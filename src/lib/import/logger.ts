export type Severity = 'INFO' | 'WARNING' | 'ERROR';

export interface Issue {
  severity: Severity;
  workbook?: string;
  sheet?: string;
  rowNumber?: number;
  code: string;
  message: string;
  payload?: unknown;
}

export class ImportLogger {
  readonly issues: Issue[] = [];
  private counters = new Map<string, number>();

  add(issue: Issue) {
    this.issues.push(issue);
  }

  info(code: string, message: string, ctx: Partial<Issue> = {}) {
    this.add({ severity: 'INFO', code, message, ...ctx });
  }

  warn(code: string, message: string, ctx: Partial<Issue> = {}) {
    this.add({ severity: 'WARNING', code, message, ...ctx });
  }

  error(code: string, message: string, ctx: Partial<Issue> = {}) {
    this.add({ severity: 'ERROR', code, message, ...ctx });
  }

  count(key: string, by = 1) {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  get(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  get counts(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort());
  }

  get warnings(): number {
    return this.issues.filter((i) => i.severity === 'WARNING').length;
  }

  get errors(): number {
    return this.issues.filter((i) => i.severity === 'ERROR').length;
  }

  get infos(): number {
    return this.issues.filter((i) => i.severity === 'INFO').length;
  }
}
