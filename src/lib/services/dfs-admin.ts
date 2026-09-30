/**
 * The one DFS setting that is not derived: whether a package × discipline is
 * explicitly NOT APPLICABLE. NA is distinct from complete, is audited, and is
 * kept by later imports (package_fees.user_edited_fields).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { disciplines, packageFees, packages } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';

export async function setUnitApplicability(
  input: { packageId: string; discipline: string; applicability: 'APPLICABLE' | 'NA'; reason: string },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const [pkg] = await tx.select().from(packages).where(eq(packages.id, input.packageId)).limit(1);
    if (!pkg) throw new Error('Package not found');
    const [disc] = await tx.select().from(disciplines).where(eq(disciplines.code, input.discipline)).limit(1);
    if (!disc) throw new Error('Discipline not found');
    const [fee] = await tx
      .select()
      .from(packageFees)
      .where(and(eq(packageFees.packageId, pkg.id), eq(packageFees.disciplineId, disc.id)))
      .limit(1);
    const before = fee?.applicability ?? 'APPLICABLE';
    if (before === input.applicability) return { changed: false };
    const edited = new Set((fee?.userEditedFields ?? '').split(',').filter(Boolean));
    edited.add('applicability');
    if (fee) {
      await tx
        .update(packageFees)
        .set({ applicability: input.applicability, userEditedFields: [...edited].sort().join(','), updatedAt: new Date() })
        .where(eq(packageFees.id, fee.id));
    } else {
      await tx.insert(packageFees).values({
        id: newId('pf_'),
        packageId: pkg.id,
        disciplineId: disc.id,
        applicability: input.applicability,
        userEditedFields: 'applicability',
        updatedAt: new Date(),
      });
    }
    await recordAudit(
      {
        actor,
        entityType: 'PACKAGE',
        entityId: pkg.id,
        entityLabel: `${pkg.packageCode} — ${pkg.packageName} · ${input.discipline}`,
        action: 'UPDATE',
        field: `applicability.${input.discipline}`,
        oldValue: before,
        newValue: input.applicability,
        reason: input.reason,
        projectId: pkg.projectId,
      },
      tx,
    );
    return { changed: true };
  });
}
