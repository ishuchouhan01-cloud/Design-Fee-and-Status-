/**
 * The explicit project / phase normalisation layer for Design Goals FY 26.
 *
 * Why this is a table of data rather than an inference rule: banner nesting in
 * the source workbooks is NOT a reliable project/phase signal. Inferring from
 * it makes `Blue in Green` (project 0098) a phase of `OTF` (project 0099), and
 * `TR Mills Chamarajpet` a phase of `KIADB - Mys`, because the "New projects"
 * workbook collects unrelated projects under one banner style. Every mapping
 * below was confirmed against the inspected workbook structure.
 *
 * A column-B label that is absent from this table is never guessed — the row is
 * rejected to `fy26_import_issues` with `UNMAPPED_SCOPE_LABEL`.
 *
 * `level`:
 *   PROJECT        the label names a project (and possibly its default scope)
 *   PHASE          the label names a phase of `projectName`
 *   PACKAGE_SCOPE  the label is a sub-scope written on package rows — a
 *                  structure or block within a project (`OWC`, `UGT, WTP`,
 *                  `STP`, `OTF [V35]`) or an abbreviated phase spelling
 *                  (`SftH - Res`, `AtR Ph 3`). Preserved verbatim on the
 *                  package as `sourceScopeLabel`; never a project or phase.
 */
import { eq } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import { fy26ScopeMap, projects } from '@/db/schema';
import { newId } from '@/lib/ids';
import type { Fy26ScopeLevel } from '@/lib/domain';

export interface ScopeMapEntry {
  sourceLabel: string;
  sourceWorkbook: string;
  level: Fy26ScopeLevel;
  projectName: string;
  phaseName: string | null;
  legacyProjectCode: string | null;
}

export const SCOPE_MAP: ScopeMapEntry[] = [
  { sourceLabel: "Imagine Campus", sourceWorkbook: "0052 Imagine - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Imagine", phaseName: null, legacyProjectCode: "IMAGINE" },
  { sourceLabel: "SftW", sourceWorkbook: "0057 SftW FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "SftW", phaseName: null, legacyProjectCode: "SFTW" },
  { sourceLabel: "PoaRR-Res", sourceWorkbook: "0059 PoaRR - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "PoaRR", phaseName: "Res", legacyProjectCode: "POARR-RES" },
  { sourceLabel: "PoaRR-T08", sourceWorkbook: "0059 PoaRR - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "PoaRR", phaseName: "T08", legacyProjectCode: "POARR-T08" },
  { sourceLabel: "ITQE", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "ITQE", phaseName: null, legacyProjectCode: null },
  { sourceLabel: "ITQE-Ph1", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "ITQE", phaseName: "Ph1", legacyProjectCode: "ITQE-PH1" },
  { sourceLabel: "ITQE-Ph2b", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "ITQE", phaseName: "Ph2b", legacyProjectCode: "ITQE-PH2B" },
  { sourceLabel: "ItQE-Ph2c [T9]", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "ITQE", phaseName: "Ph2c [T9]", legacyProjectCode: "ITQE-PH2C" },
  { sourceLabel: "ItQE-Ph3a [T10-12 & 31 Villas]", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "ITQE", phaseName: "Ph3a [T10-12 & 31 Villas]", legacyProjectCode: null },
  { sourceLabel: "VADERAHALLI", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Vaderahalli", phaseName: null, legacyProjectCode: "VADERAHALLI" },
  { sourceLabel: "Vaderahalli [Residential]", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "Vaderahalli", phaseName: "Residential", legacyProjectCode: null },
  { sourceLabel: "Vaderahalli [Commercial]", sourceWorkbook: "0063 ITQE -FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "Vaderahalli", phaseName: "Commercial", legacyProjectCode: null },
  { sourceLabel: "AtR Ph 1, 2a, 2b, 2c - Residential", sourceWorkbook: "0072 AtR - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "AtR", phaseName: "Ph 1, 2a, 2b, 2c - Residential", legacyProjectCode: "ATR" },
  { sourceLabel: "AtR Ph3-Residential", sourceWorkbook: "0072 AtR - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "AtR", phaseName: "Ph3 - Residential", legacyProjectCode: "ATR-03" },
  { sourceLabel: "AtR Ph 1, 2a, 2b", sourceWorkbook: "0072 AtR - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "AtR", phaseName: "Ph 1, 2a, 2b, 2c - Residential", legacyProjectCode: "ATR" },
  { sourceLabel: "AtR Ph 2c", sourceWorkbook: "0072 AtR - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "AtR", phaseName: "Ph 1, 2a, 2b, 2c - Residential", legacyProjectCode: "ATR" },
  { sourceLabel: "AtR Ph 3", sourceWorkbook: "0072 AtR - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "AtR", phaseName: "Ph3 - Residential", legacyProjectCode: "ATR-03" },
  { sourceLabel: "AtR - Commercial", sourceWorkbook: "72P5 AtR-C - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "AtR", phaseName: "Commercial", legacyProjectCode: "ATR-C" },
  { sourceLabel: "AtR - C", sourceWorkbook: "72P5 AtR-C - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "AtR", phaseName: "Commercial", legacyProjectCode: "ATR-C" },
  { sourceLabel: "Indiranagar Res", sourceWorkbook: "0076 Indiranagar Residence - FY26Q2 Design Goals.xlsx", level: 'PROJECT', projectName: "Indiranagar Res", phaseName: null, legacyProjectCode: "INDIRANAGAR-RES" },
  { sourceLabel: "0082| OVER THE RAINBOW", sourceWorkbook: "0082 OTR-FY26Q3 Design goals.xlsx", level: 'PROJECT', projectName: "OTR", phaseName: null, legacyProjectCode: "TEHPL-OTR" },
  { sourceLabel: "OTR-Ph01", sourceWorkbook: "0082 OTR-FY26Q3 Design goals.xlsx", level: 'PHASE', projectName: "OTR", phaseName: "PH01", legacyProjectCode: "OTR-PH01" },
  { sourceLabel: "OTR-Ph02", sourceWorkbook: "0082 OTR-FY26Q3 Design goals.xlsx", level: 'PHASE', projectName: "OTR", phaseName: "PH02", legacyProjectCode: "OTR-PH02" },
  { sourceLabel: "OTR Museum", sourceWorkbook: "0082 OTR-FY26Q3 Design goals.xlsx", level: 'PHASE', projectName: "OTR", phaseName: "MUSEUM", legacyProjectCode: "OTR-MUSEUM" },
  { sourceLabel: "OTR Oota", sourceWorkbook: "0082 OTR-FY26Q3 Design goals.xlsx", level: 'PHASE', projectName: "OTR", phaseName: "OOTA", legacyProjectCode: null },
  { sourceLabel: "DBTW", sourceWorkbook: "0093 DBTW - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "DBTW", phaseName: null, legacyProjectCode: "DBTW" },
  { sourceLabel: "OWC", sourceWorkbook: "0093 DBTW - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "DBTW", phaseName: null, legacyProjectCode: "DBTW" },
  { sourceLabel: "UGT, WTP", sourceWorkbook: "0093 DBTW - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "DBTW", phaseName: null, legacyProjectCode: "DBTW" },
  { sourceLabel: "STP", sourceWorkbook: "0093 DBTW - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "DBTW", phaseName: null, legacyProjectCode: "DBTW" },
  { sourceLabel: "TuiG", sourceWorkbook: "0095 TuiG - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "TuiG", phaseName: null, legacyProjectCode: "TUIG" },
  { sourceLabel: "OTF", sourceWorkbook: "0099 OTF & 0098 BiG - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "OtF", phaseName: null, legacyProjectCode: "OTF" },
  { sourceLabel: "OTF [V35]", sourceWorkbook: "0099 OTF & 0098 BiG - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "OtF", phaseName: null, legacyProjectCode: "OTF" },
  { sourceLabel: "OTF [V60]", sourceWorkbook: "0099 OTF & 0098 BiG - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "OtF", phaseName: null, legacyProjectCode: "OTF" },
  { sourceLabel: "Blue in Green", sourceWorkbook: "0099 OTF & 0098 BiG - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Blue in Green", phaseName: null, legacyProjectCode: "BLUE-IN-GREEN" },
  { sourceLabel: "BiG", sourceWorkbook: "0099 OTF & 0098 BiG - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "Blue in Green", phaseName: null, legacyProjectCode: "BLUE-IN-GREEN" },
  { sourceLabel: "SftH [South Block-Resi]", sourceWorkbook: "0106 SftH FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "SftH", phaseName: "South Block - Residential", legacyProjectCode: null },
  { sourceLabel: "SftH - Res", sourceWorkbook: "0106 SftH FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "SftH", phaseName: "South Block - Residential", legacyProjectCode: null },
  { sourceLabel: "SftH - C (South Block)", sourceWorkbook: "0106 SftH FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "SftH", phaseName: "Commercial - South Block", legacyProjectCode: null },
  { sourceLabel: "SftH - C - SB", sourceWorkbook: "0106 SftH FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "SftH", phaseName: "Commercial - South Block", legacyProjectCode: null },
  { sourceLabel: "SftH - C (North Block)", sourceWorkbook: "0106 SftH FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "SftH", phaseName: "Commercial - North Block", legacyProjectCode: null },
  { sourceLabel: "SftH - C - NB", sourceWorkbook: "0106 SftH FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "SftH", phaseName: "Commercial - North Block", legacyProjectCode: null },
  { sourceLabel: "MeenaSai Res", sourceWorkbook: "0116 MSRes, 0131 NHHS - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "MeenaSai Res", phaseName: null, legacyProjectCode: "MEENASAI-RES" },
  { sourceLabel: "NH Homestay", sourceWorkbook: "0116 MSRes, 0131 NHHS - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "NH Homestay", phaseName: null, legacyProjectCode: "NH-HOMESTAY" },
  { sourceLabel: "Poinciana", sourceWorkbook: "0117 Poinciana - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Poinciana", phaseName: null, legacyProjectCode: "POINCIANA" },
  { sourceLabel: "Violet Hill [21.76a]", sourceWorkbook: "0118 Violet Hill - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "Violet Hill", phaseName: "21.76a", legacyProjectCode: "VIOLET-HILL" },
  { sourceLabel: "Violet Hill [27.08a]", sourceWorkbook: "0118 Violet Hill - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "Violet Hill", phaseName: "27.08a", legacyProjectCode: null },
  { sourceLabel: "LGCE Campus", sourceWorkbook: "LGCE & Uma Kush FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "LGCE", phaseName: null, legacyProjectCode: "LGCE" },
  { sourceLabel: "MT Plano", sourceWorkbook: "LGCE & Uma Kush FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "MT Plano", phaseName: null, legacyProjectCode: "MT-PLANO" },
  { sourceLabel: "KIADB - Mys", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "KIADB - Mys", phaseName: null, legacyProjectCode: "KIADB-MYS" },
  { sourceLabel: "TMFT-Ph 3", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "TMFT", phaseName: "Ph 3", legacyProjectCode: "TMFT" },
  { sourceLabel: "Byatarayanpura [behind Mall of Asia]", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Byatarayanpura", phaseName: null, legacyProjectCode: "BYATARAYANPURA-BEHIND-MALL-OF-ASIA" },
  { sourceLabel: "TR Mills Chamarajpet", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "TR Mills Chamarajpet", phaseName: null, legacyProjectCode: "TR-MILLS-CHAMARAJPET" },
  { sourceLabel: "TR Mills", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PACKAGE_SCOPE', projectName: "TR Mills Chamarajpet", phaseName: null, legacyProjectCode: "TR-MILLS-CHAMARAJPET" },
  { sourceLabel: "Varthur 52a", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Varthur 52a", phaseName: null, legacyProjectCode: "VARTHUR-52A" },
  { sourceLabel: "Nandi Hills 10a Sultanpete", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "NH 10a", phaseName: null, legacyProjectCode: "NH-10A" },
  { sourceLabel: "Harohalli", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PROJECT', projectName: "Harohalli", phaseName: null, legacyProjectCode: "HAROHALLI" },
  { sourceLabel: "Misty [Nava Raipur]", sourceWorkbook: "New projects - FY26Q3 Design Goals.xlsx", level: 'PHASE', projectName: "Nava Raipur", phaseName: "Misty", legacyProjectCode: "NAVA-RAIPUR" },
];

/** Seed / refresh `fy26_scope_map`. Idempotent: keyed on `sourceLabel`. */
export async function seedScopeMap(tx: DbLike = db): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const e of SCOPE_MAP) {
    const [existing] = await tx
      .select({ id: fy26ScopeMap.id })
      .from(fy26ScopeMap)
      .where(eq(fy26ScopeMap.sourceLabel, e.sourceLabel))
      .limit(1);
    const values = {
      sourceLabel: e.sourceLabel,
      sourceWorkbook: e.sourceWorkbook,
      level: e.level,
      projectName: e.projectName,
      phaseName: e.phaseName,
      legacyProjectCode: e.legacyProjectCode,
      confirmed: true,
      updatedAt: new Date(),
    };
    if (existing) {
      await tx.update(fy26ScopeMap).set(values).where(eq(fy26ScopeMap.id, existing.id));
      updated += 1;
    } else {
      await tx.insert(fy26ScopeMap).values({ id: newId('fsm_'), ...values });
      created += 1;
    }
  }
  return { created, updated };
}

export async function loadScopeMap(tx: DbLike = db): Promise<Map<string, ScopeMapEntry>> {
  const rows = await tx.select().from(fy26ScopeMap);
  const source: ScopeMapEntry[] = rows.length
    ? rows.map((r) => ({
        sourceLabel: r.sourceLabel,
        sourceWorkbook: r.sourceWorkbook,
        level: r.level as Fy26ScopeLevel,
        projectName: r.projectName,
        phaseName: r.phaseName,
        legacyProjectCode: r.legacyProjectCode,
      }))
    : SCOPE_MAP;
  return new Map(source.map((e) => [e.sourceLabel, e]));
}

/** `project_code` -> `projects.id`, for wiring the nullable legacy FKs. */
export async function loadLegacyProjectIds(tx: DbLike = db): Promise<Map<string, string>> {
  const rows = await tx.select({ id: projects.id, code: projects.projectCode }).from(projects);
  return new Map(rows.map((r) => [r.code, r.id]));
}
