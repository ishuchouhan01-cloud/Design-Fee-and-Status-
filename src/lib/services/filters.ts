/**
 * Shared filter/paging contract for every list screen and API route.
 */
export interface ListFilters {
  projectId?: string;
  phaseId?: string;
  disciplineId?: string;
  designLeadId?: string;
  ownerId?: string;
  packageId?: string;
  goalId?: string;
  fiscalYear?: string;
  quarter?: number;
  completion?: 'COMPLETED' | 'NOT_COMPLETED';
  scheduleStatus?: string;
  rag?: string;
  priority?: string;
  rescheduled?: boolean;
  portfolio?: string;
  search?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export function parseFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): ListFilters {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const numOf = (k: string) => {
    const v = get(k);
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const boolOf = (k: string) => {
    const v = get(k);
    if (v == null || v === '') return undefined;
    return v === 'true' || v === '1' || v === 'yes';
  };
  const completion = get('completion');
  return {
    projectId: get('projectId') || undefined,
    phaseId: get('phaseId') || undefined,
    disciplineId: get('disciplineId') || undefined,
    designLeadId: get('designLeadId') || undefined,
    ownerId: get('ownerId') || undefined,
    packageId: get('packageId') || undefined,
    goalId: get('goalId') || undefined,
    fiscalYear: get('fiscalYear') || undefined,
    quarter: numOf('quarter'),
    completion: completion === 'COMPLETED' || completion === 'NOT_COMPLETED' ? completion : undefined,
    scheduleStatus: get('scheduleStatus') || undefined,
    rag: get('rag') || undefined,
    priority: get('priority') || undefined,
    rescheduled: boolOf('rescheduled'),
    portfolio: get('portfolio') || undefined,
    search: get('search')?.trim() || undefined,
    sort: get('sort') || undefined,
    dir: get('dir') === 'asc' ? 'asc' : get('dir') === 'desc' ? 'desc' : undefined,
    page: numOf('page') ?? 1,
    pageSize: Math.min(500, numOf('pageSize') ?? 50),
  };
}

export function toQueryString(filters: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function pageOf<T>(rows: T[], total: number, page: number, pageSize: number): Paged<T> {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
