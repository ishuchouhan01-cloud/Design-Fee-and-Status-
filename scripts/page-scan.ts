/**
 * Page wording check: fetches every screen of a running server and fails when
 * one shows a banned phrase or an unexplained abbreviation.
 *
 *   BASE=http://localhost:3000 npx tsx scripts/page-scan.ts
 *   (optional) SCAN_HEADER="x-user-email: admin@company.local"
 */
import 'dotenv/config';
import { BANNED_PHRASES } from '../src/lib/labels';

const BASE = process.env.BASE ?? 'http://localhost:3000';
/** Signs in (SCAN_ROLE, default SUPER_ADMIN; SCAN_PASSWORD or the role's *_PASSWORD) and scans as that role. */
const HEADERS: Record<string, string> = {};
async function signIn() {
  const role = process.env.SCAN_ROLE ?? 'SUPER_ADMIN';
  const password = process.env.SCAN_PASSWORD ?? (role === 'ADMIN' ? process.env.ADMIN_PASSWORD : role === 'SUPER_ADMIN' ? process.env.SUPER_ADMIN_PASSWORD : undefined);
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, password }) });
  if (!res.ok) throw new Error(`Sign-in as ${role} failed: ${res.status}`);
  HEADERS.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Abbreviations that must be written in full on screen. */
export const ABBREVIATIONS: { re: RegExp; say: string }[] = [
  { re: /\bFY\s?\d{2}\b/, say: 'Financial Year …' },
  { re: /\bQ[1-4]\b/, say: 'Quarter …' },
  { re: /\bQtr\b/i, say: 'Quarter' },
  { re: /\bRAG\b/, say: 'Status (Green / Amber / Red)' },
  { re: /\bACC\b/, say: 'Autodesk Construction Cloud' },
  { re: /\bMEP\b/, say: 'Mechanical, Electrical & Plumbing' },
  { re: /\bPkgs?\b/, say: 'Package' },
  { re: /\bRev\b/, say: 'Revision' },
  { re: /\bWBS\b/, say: '(not shown)' },
  { re: /[✓✕✔✗]/, say: 'Complete / Pending' },
  { re: /\bPOARR-(RES|T08|T09)\b/, say: 'the project’s full name' },
  { re: /\bVIOLET-HILL\b/, say: 'Violet Hill' },
];

/** Values that are never shown on a screen, even inside record data. */
export const DATA_NEVER_SHOWN: { re: RegExp; say: string }[] = [
  { re: /\bPoaRR-(Res|T08|T09)\b/, say: 'the project’s full name' },
  { re: /(^|[\s>|])=\s*(CONCATENATE|CONCAT|VLOOKUP|INDEX|TEXT|TRIM|IF)\s*\(/i, say: 'the value, not formula text' },
];

export function visibleText(html: string): string {
  return clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/\s(title|placeholder|aria-label)="([^"]*)"/gi, ' >$2< '),
  );
}

function clean(s: string) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The screen's own wording — headings, column headers, labels, buttons, menu,
 * tooltips, placeholders and fixed filter options. Record values (names,
 * descriptions, sheet names from the source workbooks) are data and are not
 * rewritten.
 */
export function chromeText(html: string): string {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const parts: string[] = [];
  // Record names shown as links inside a heading or summary are data.
  const noRecordLinks = (x: string) => x.replace(/<a\b[^>]*class="[^"]*\blink\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ');
  for (const m of body.matchAll(/<(th|h1|h2|h3|label|button|legend|summary|dt)\b[^>]*>([\s\S]*?)<\/\1>/gi)) parts.push(clean(noRecordLinks(m[2])));
  for (const m of body.matchAll(/<a\b[^>]*class="[^"]*(nav-item|btn)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) parts.push(clean(m[2]));
  // Tooltips, placeholders and accessible names of controls and column headers. A tooltip on a
  // table cell or text span repeats the record value it sits on (data); a row checkbox is named
  // after its record ("Select D-…"), which is data too.
  for (const m of body.matchAll(/<(th|button|select|input|textarea|abbr|a)\b([^>]*)>/gi)) {
    if (/type="checkbox"/i.test(m[2])) continue;
    for (const a of m[2].matchAll(/\s(title|placeholder|aria-label)="([^"]*)"/gi)) parts.push(a[2]);
  }
  for (const m of body.matchAll(/<span\b[^>]*class="[^"]*\b(pill|rounded)\b[^"]*"[^>]*>([^<]*)<\/span>/gi)) parts.push(clean(m[2]));
  for (const m of body.matchAll(/<p\b[^>]*class="[^"]*(kpi-label|label)[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)) parts.push(clean(m[2]));
  // Options of filters whose values are fixed lists or projects (not free text).
  for (const sel of body.matchAll(/<select\b[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    // Pickers that list records (packages, people, phases, batches, schedule items) hold data.
    if (/package|owner|lead|responsible|phase|batch|dep-|sched-include/i.test(sel[1])) continue;
    for (const o of sel[2].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)) parts.push(clean(o[1]));
  }
  return parts.join(' | ');
}

export function findProblems(html: string, pagePath = ''): string[] {
  const out: string[] = [];
  const text = visibleText(html);
  const lower = text.toLowerCase();
  for (const p of BANNED_PHRASES) {
    const i = lower.indexOf(p);
    if (i >= 0) out.push(`banned phrase "${p}": …${text.slice(Math.max(0, i - 40), i + p.length + 40)}…`);
  }
  // Project codes and formula text never show on a DFS screen, not even as data.
  for (const a of /^\/(drawings|drawing-control|billing)/.test(pagePath) ? DATA_NEVER_SHOWN : []) {
    const m = a.re.exec(text);
    if (m) out.push(`"${m[0]}" shown (write ${a.say}): …${text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50)}…`);
  }
  const chrome = chromeText(html);
  for (const a of ABBREVIATIONS) {
    const m = a.re.exec(chrome);
    if (m) out.push(`abbreviation "${m[0]}" (write ${a.say}): …${chrome.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50)}…`);
  }
  return out;
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, redirect: 'follow' });
  return { status: res.status, html: await res.text() };
}

async function firstHref(path: string, re: RegExp): Promise<string | null> {
  const { html } = await get(path);
  const m = re.exec(html);
  return m ? m[1] : null;
}

async function main() {
  await signIn();
  const pages = [
    '/',
    '/projects',
    '/goals',
    '/deliverables',
    '/fy26',
    '/fy26/import',
    '/drawings',
    '/drawings?view=summary',
    '/drawings?view=periods',
    '/drawings?view=periods&basis=FY',
    '/drawings?view=list',
    '/billing',
    '/login',
    '/drawing-control',
    '/import-centre',
    '/update-centre',
    '/schedule',
    '/audit',
    '/settings',
  ];
  for (const [list, re] of [
    ['/projects', /href="(\/projects\/[^"?#]+)"/],
    ['/fy26', /href="(\/fy26\/(?!import)[^"?#]+)"/],
    ['/drawings?view=list', /href="(\/drawings\/[^"?#]+)"/],
    ['/drawing-control', /href="(\/drawing-control\/[^"?#]+)"/],
  ] as const) {
    const h = await firstHref(list, re);
    if (h) pages.push(h);
  }
  let failures = 0;
  for (const p of pages) {
    const { status, html } = await get(p);
    const problems = status >= 500 ? [`HTTP ${status}`] : findProblems(html, p);
    if (problems.length) {
      failures += problems.length;
      console.log(`✗ ${p}`);
      for (const x of problems) console.log(`    ${x}`);
    } else console.log(`  ok ${p}`);
  }
  console.log(failures ? `\n${failures} problem(s).` : '\nNo banned phrases or abbreviations on any page.');
  process.exit(failures ? 1 : 0);
}

if (process.argv[1]?.endsWith('page-scan.ts')) void main();
