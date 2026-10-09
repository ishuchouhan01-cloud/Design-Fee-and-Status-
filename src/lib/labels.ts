/**
 * The one label dictionary. Every screen, export, tooltip and API message that
 * names a discipline, a status, a period or a DFS column takes its wording from
 * here, so the same thing is always called the same thing — in full, never as
 * an internal code or an unexplained abbreviation.
 */

export const APP_NAME = 'Design Goals & Delivery Control System';

/** The name of this copy of the application and of its main screen. */
export const APP_TITLE = 'Project Drawing Status';

export const NAV_LABEL = {
  dashboard: 'Dashboard',
  projects: 'Projects',
  goals: 'Goals',
  deliverables: 'Design Delivery',
  fy26: 'Design Goals – Financial Year 2026–27',
  dfs: 'Project Drawing Status',
  billing: 'Billing',
  drawingControl: 'Drawing Control',
  importCentre: 'Import',
  updateCentre: 'Update Centre',
  schedule: 'Schedule / Reschedule',
  audit: 'Audit',
  members: 'Members',
  settings: 'Settings',
} as const;

/** Full discipline names. Codes are for data only. */
export const DISCIPLINE_LABEL: Record<string, string> = {
  AR: 'Architecture',
  ST: 'Structural',
  MEP: 'Mechanical, Electrical & Plumbing',
  LS: 'Landscape',
  MP: 'Master Planning',
  UD: 'Urban Design',
  ID: 'Interior Design',
  INFRA: 'Infrastructure Consultants',
  PHE: 'Public Health Engineering',
  ELE: 'Electrical',
  IBMS: 'Integrated Building Management System',
  LDS: 'Landscape',
  NONE: 'No discipline',
};

export function disciplineLabel(code: string | null | undefined, fallbackName?: string | null): string {
  if (!code) return DISCIPLINE_LABEL.NONE;
  return DISCIPLINE_LABEL[code.toUpperCase()] ?? fallbackName ?? code;
}

/** A project's name for display: the Project List full name, else the source name. Never the code. */
export function projectLabel(p: { displayName?: string | null; projectName?: string | null; name?: string | null; projectCode?: string | null; code?: string | null }): string {
  return p.displayName || p.projectName || p.name || p.projectCode || p.code || '';
}

export const STATUS_LABEL = {
  COMPLETE: 'Complete',
  PENDING: 'Pending',
  NA: 'Not Applicable',
  RELEASED: 'Released',
  NOT_RELEASED: 'Not Released',
} as const;

/** Package status (COMPLETE | NOT_COMPLETE | NA) → words. */
export function packageStatusLabel(s: string): string {
  if (s === 'COMPLETE') return STATUS_LABEL.COMPLETE;
  if (s === 'NA') return STATUS_LABEL.NA;
  return STATUS_LABEL.PENDING;
}

/** Drawing release status (COMPLETED | NOT_COMPLETED) → words. */
export function releaseLabel(s: string): string {
  return s === 'COMPLETED' ? STATUS_LABEL.RELEASED : STATUS_LABEL.NOT_RELEASED;
}

/**
 * Release evidence as stored by the imports ("Issued 2026 Q1", "ACC release
 * 28-Feb-2023", …) in full words, for the drawing detail and data-quality pages.
 */
export function evidenceLabel(ev: string | null | undefined): string {
  if (!ev) return '';
  let m = /^Issued (\d{4}) Q([1-4])$/.exec(ev);
  if (m) return `Issued in Calendar Year ${m[1]}, Quarter ${m[2]}`;
  m = /^Issued in (\d{4})$/.exec(ev);
  if (m) return `Issued in Calendar Year ${m[1]}`;
  m = /^ACC release (.+)$/.exec(ev);
  if (m) return `Autodesk Construction Cloud release ${m[1]}`;
  if (/^In ACC export/.test(ev)) return 'Listed in the Autodesk Construction Cloud export, without a release date';
  return ev.replace(/\bACC\b/g, 'Autodesk Construction Cloud');
}

export const RAG_LABEL: Record<string, string> = { GREEN: 'Green', AMBER: 'Amber', RED: 'Red', GREY: 'Not rated', NONE: 'Not rated' };

export const NODE_TYPE_LABEL: Record<string, string> = {
  PHASE: 'Phase',
  TOWER: 'Tower',
  PRODUCT: 'Product',
  BLOCK: 'Block',
  VILLA: 'Villa',
  GROUP: 'Group',
};

export function quarterLabel(q: number | string | null | undefined): string {
  if (q == null || q === '') return '';
  return `Quarter ${String(q).replace(/^Q/i, '')}`;
}

/** "FY26-27" → "Financial Year 2026–27"; "CY2026" → "Calendar Year 2026". Anything else unchanged. */
export function yearLabel(label: string | null | undefined): string {
  if (!label) return '';
  let m = /^FY\s?(\d{2})-(\d{2})$/i.exec(label);
  if (m) return `Financial Year 20${m[1]}–${m[2]}`;
  m = /^FY\s?(\d{4})-(\d{2,4})$/i.exec(label);
  if (m) return `Financial Year ${m[1]}–${m[2].slice(-2)}`;
  m = /^CY\s?(\d{4})$/i.exec(label);
  if (m) return `Calendar Year ${m[1]}`;
  return label;
}

/** "FY26-27 Q2" / "FY26-27-Q2" → "Financial Year 2026–27, Quarter 2". */
export function periodLabelFull(label: string | null | undefined): string {
  if (!label) return '';
  const m = /^(FY\s?\d{2}-\d{2}|CY\s?\d{4})[\s-]*Q([1-4])$/i.exec(label);
  if (m) return `${yearLabel(m[1])}, ${quarterLabel(m[2])}`;
  return yearLabel(label);
}

export const DFS_LABEL = {
  title: 'Project Drawing Status',
  billingTitle: 'Billing',
  subtitle: 'Package and drawing status by project.',
  tabTree: 'Project Drawing Status',
  tabSummary: 'DFS Summary',
  tabPeriods: 'Year / Quarter',
  tabList: 'Drawing list',
  openDrawingControl: 'Open Drawing Control',
  expandToPackages: 'Expand to Packages',
  expandTo: 'Expand to',
  expandLevelProjects: 'Projects',
  expandLevelPhases: 'Phases',
  expandLevelTowers: 'Towers / Products',
  expandLevelPackages: 'Packages',
  expandLevelDisciplines: 'Disciplines',
  expandLevelDrawings: 'Drawings',
  narrowToOpenDrawings: 'Narrow the filter to open all drawings',
  collapseAll: 'Collapse All',
  showEmptyRows: 'Show empty rows',
  noDrawings: 'No drawings',
  wholePackage: 'Whole package (one fee)',
  billingExcludedNote: 'No drawings released — left out of billing',
  billingToReview: 'Billing to review',
  reviewEmpty: 'Nothing to review: every billed line has released drawings.',
  reviewReason: 'Reason',
  exportExcel: 'Export to Excel',
  exportCsv: 'Export to CSV',
  searchPlaceholder: 'Search by drawing number, drawing name, package or project',
  colName: 'Name',
  colPackageStatus: 'Package Status',
  colReleaseDate: 'Release Date',
  colPackagesComplete: 'Packages Complete',
  colDrawingsReleased: 'Drawings Released',
  colResponsible: 'Responsible Person',
  colTotal: 'Total',
  colBilled: 'Billed',
  colUnbilled: 'Unbilled',
  groupStatus: 'Status',
  groupSchedule: 'Schedule',
  groupProgress: 'Progress',
  groupBilling: 'Billing (₹ Cr)',
  colReleaseStatus: 'Release Status',
  eligibleAfterCompletion: 'Eligible to bill after completion',
  billedBeforeCompletion: 'Billed before the package is complete',
  fullScreen: 'Full Screen',
  exitFullScreen: 'Exit Full Screen',
  switchUser: 'Switch User',
  signOut: 'Sign out',
  editMode: 'Edit Mode',
  editingEnabled: 'Editing enabled',
  colDrawingName: 'Drawing Name',
  colDrawingNumber: 'Drawing Number',
  colRevision: 'Revision',
  colDiscipline: 'Discipline',
  colUpdatedOn: 'Updated On',
  colStatus: 'Status',
  colProject: 'Project',
  colTower: 'Tower / Product',
  colGroup: 'Group',
  colPackage: 'Package',
  colPackageCode: 'Package Code',
  notYetNumbered: 'Not yet numbered',
  emptyTree: 'No packages or drawings match the current filters.',
  emptyDrawings: 'No drawings match the current filters.',
  loadMore: 'Load more drawings',
  errorLoad: 'This part of the schedule could not be loaded. Please try again.',
} as const;

/** Short definitions shown as column-header tooltips. */
export const DFS_TOOLTIP = {
  packageStatus: 'Complete: every drawing in the package is released. Pending: at least one drawing is not released, or the package has none in the register. Not Applicable: marked so for a discipline.',
  releaseDate: 'The date the last drawing of the package was released, where it is recorded.',
  packagesComplete: 'Packages that are complete, of all packages in this row.',
  drawingsReleased: 'Drawings released, of all drawings in this row.',
  total: 'Total: the design fee (scope) of the packages.',
  billed: 'Billed: the amount billed to date.',
  responsible: 'The person responsible for the package or drawing.',
  unbilled: 'Unbilled: Total less Billed.',
  overall: 'Packages complete as a share of all packages.',
} as const;

export const SUMMARY_LABEL = {
  packages: 'Packages',
  complete: 'Complete',
  pending: 'Pending',
  overall: 'Overall',
  billing: 'Billing',
  total: 'Total (₹ Cr)',
  billed: 'Billed (₹ Cr)',
  unbilled: 'Unbilled (₹ Cr)',
  packageSummary: 'Package summary',
  projectDiscipline: 'Project / Discipline',
} as const;

export const IMPORT_FILE_TYPE_LABEL: Record<string, string> = {
  DESIGN_FEE: 'Base DFS / Design Fee sheet',
  PLAN: 'Drawing register / 03-Year Plan',
  ACC: 'Autodesk Construction Cloud release export',
  PROJECT_LIST: 'Project List',
};

/** Phrases that must never appear on a screen, in an export or in an API message. */
export const BANNED_PHRASES = [
  'source of truth',
  'import/export format only',
  'derived from',
  'entered by hand',
  'read-only',
  'no base dfs',
  'not recorded',
  'with its evidence',
  'no drawings yet',
] as const;

/** Goal priority codes → words. */
export const PRIORITY_LABEL: Record<string, string> = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

/** Billing values are held in crores of rupees. */
export const CRORE_UNIT = '₹ Cr';

/** Record types named in the audit trail and its filter. */
export const ENTITY_TYPE_LABEL: Record<string, string> = {
  GOAL: 'Goal',
  DELIVERABLE: 'Deliverable',
  DRAWING: 'Drawing',
  PACKAGE: 'Package',
  PROJECT: 'Project',
  IMPORT_RUN: 'Import run',
  EXPORT: 'Export',
  DATABASE: 'Database',
  DEPENDENCY: 'Dependency',
  USER: 'User',
  SETTING: 'Setting',
  FY26_PROJECT: 'Design Goals – Financial Year 2026–27 project',
  FY26_PHASE: 'Design Goals – Financial Year 2026–27 phase',
  FY26_PACKAGE: 'Design Goals – Financial Year 2026–27 package',
  FY26_DEPENDENCY: 'Design Goals – Financial Year 2026–27 dependency',
  FY26_IMPORT: 'Design Goals – Financial Year 2026–27 import',
};

/** A code such as "IMPORT_RUN" or "FY26_PACKAGE" in words, for audit screens. */
export function entityTypeLabel(t: string | null | undefined): string {
  if (!t) return '';
  if (ENTITY_TYPE_LABEL[t]) return ENTITY_TYPE_LABEL[t];
  const words = t.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
