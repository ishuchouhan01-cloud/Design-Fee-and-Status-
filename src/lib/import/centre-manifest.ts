/**
 * The import manifest the Import Centre builds for one uploaded workbook —
 * pure (no database), so the dry-run diagnostic (scripts/import-diagnose.ts)
 * reads a workbook with exactly the same rules as the screen.
 *
 *   drawing lists  the sheets the user mapped, else every visible sheet that
 *                  reads as a drawing list (a Location column)
 *   Design Fee     the sheet the user chose, else the best candidate
 *                  (design-fee.ts `feeSheetCandidates`: readable layout,
 *                  visible, latest "Billed till Dec'yy", highest revision)
 */
import { IMPORT_FILE_TYPE_LABEL } from '@/lib/labels';
import { chooseFeeSheet } from './drawing-register/design-fee';
import { manifestSchema, type DrawingManifest, type FeeLayoutChoice } from './drawing-register/manifest';
import { layout } from './drawing-register/parse';
import type { TextSheet } from './drawing-register/read';

export interface CentreMapping {
  /** sheet name ('*' = every sheet) → role → column letter */
  columns?: Record<string, Record<string, string>>;
  /** sheet name → discipline code */
  disciplines?: Record<string, string>;
  /** The Design Fee sheet to read, when the workbook has more than one. */
  feeSheet?: string | null;
  /** How its fees are read: AUTO (one fee per package when the sheet has a
   *  Total Fee / Balance column set), or pinned. */
  feeLayout?: FeeLayoutChoice | null;
}

/** "…03YPlan_01012026…" → 2026; else null. */
export function planYearOf(name: string): number | null {
  const m = /(\d{2})(\d{2})(20\d{2})/.exec(name) ?? /(20\d{2})/.exec(name);
  if (!m) return null;
  return Number(m[3] ?? m[1]);
}

const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function planSheetPattern(sheets: TextSheet[], m: CentreMapping) {
  const mapped = Object.keys(m.columns ?? {}).filter((k) => k !== '*');
  const names = mapped.length ? mapped : sheets.filter((s) => !s.hidden && (layout(s)?.title ?? -1) >= 0).map((s) => s.name);
  if (!names.length) return '^$';
  return `^(${names.map(esc).join('|')})$`;
}

export function centreManifest(o: {
  fileName: string;
  fileType: 'PLAN' | 'DESIGN_FEE';
  sheets: TextSheet[];
  mapping: CentreMapping | null | undefined;
  code: string;
  name: string;
}): DrawingManifest {
  const m = o.mapping ?? {};
  const fee = chooseFeeSheet(o.sheets, m.feeSheet);
  const year = new Date().getUTCFullYear();
  return manifestSchema.parse({
    name: `${IMPORT_FILE_TYPE_LABEL[o.fileType]} — ${o.name}`,
    sourceDir: '.',
    planSheetPattern: planSheetPattern(o.sheets, m),
    planWorkbooks:
      o.fileType === 'PLAN'
        ? [
            {
              file: o.fileName,
              projectCode: o.code,
              role: 'CURRENT',
              label: `${o.fileName} (Import Centre)`,
              snapshotDate: null,
              planYear: planYearOf(o.fileName) ?? year,
              columns: m.columns,
              disciplines: m.disciplines,
            },
          ]
        : [],
    designFees: fee ? [{ file: o.fileName, projectCode: o.code, sheet: fee.sheet, label: `${o.fileName} — ${fee.sheet}`, layout: m.feeLayout ?? 'AUTO' }] : [],
    dfsHierarchy: { labelPrefix: '^GFC\\s*\\|\\s*', nodeTypes: [], resolveUnlinkedByHeading: true },
    phaseMap: {},
  });
}
