/**
 * Wording: no screen, export, tooltip or message may carry the banned phrases,
 * and the label dictionary writes everything in full. (scripts/page-scan.ts
 * checks the rendered pages of a running server the same way.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, DFS_LABEL, DFS_TOOLTIP, NAV_LABEL, SUMMARY_LABEL, disciplineLabel, evidenceLabel, periodLabelFull, quarterLabel, yearLabel } from '@/lib/labels';
import { ABBREVIATIONS, findProblems } from '../scripts/page-scan';

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

/** Source text without comments — what can reach a user. */
function code(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
}

describe('wording', () => {
  it('no banned phrase in any string the application can show', () => {
    const hits: string[] = [];
    for (const f of files(path.resolve(process.cwd(), 'src'))) {
      if (f.endsWith(path.join('lib', 'labels.ts'))) continue; // defines the list itself
      const text = code(fs.readFileSync(f, 'utf8')).toLowerCase();
      for (const p of BANNED_PHRASES) if (text.includes(p)) hits.push(`${path.relative(process.cwd(), f)}: "${p}"`);
    }
    expect(hits).toEqual([]);
  });

  it('screen labels are written in full', () => {
    const labels = [...Object.values(NAV_LABEL), ...Object.values(DFS_LABEL), ...Object.values(DFS_TOOLTIP), ...Object.values(SUMMARY_LABEL)].join(' | ');
    for (const a of ABBREVIATIONS) expect(a.re.test(labels), `${a.re} in labels`).toBe(false);
    for (const p of BANNED_PHRASES) expect(labels.toLowerCase()).not.toContain(p);
    expect(DFS_LABEL.title).toBe('Project Drawing Status');
    expect(DFS_LABEL.subtitle).toBe('Package and drawing status by project.');
    expect(NAV_LABEL.fy26).toBe('Design Goals – Financial Year 2026–27');
  });

  it('full forms of years, quarters, disciplines and release evidence', () => {
    expect(yearLabel('FY26-27')).toBe('Financial Year 2026–27');
    expect(yearLabel('CY2026')).toBe('Calendar Year 2026');
    expect(quarterLabel('Q1')).toBe('Quarter 1');
    expect(periodLabelFull('FY26-27 Q2')).toBe('Financial Year 2026–27, Quarter 2');
    expect(disciplineLabel('MEP')).toBe('Mechanical, Electrical & Plumbing');
    expect(evidenceLabel('Issued 2026 Q1')).toBe('Issued in Calendar Year 2026, Quarter 1');
    expect(evidenceLabel('ACC release 28-Feb-2023')).toBe('Autodesk Construction Cloud release 28-Feb-2023');
    expect(evidenceLabel('In ACC export — release date not recorded').toLowerCase()).not.toContain('not recorded');
  });

  it('the page check finds banned phrases and abbreviations in screen wording, not in record values', () => {
    expect(findProblems('<p>Database is the source of truth</p>')).toHaveLength(1);
    expect(findProblems('<th>Rev</th><th>RAG</th>')).toHaveLength(2);
    expect(findProblems('<td>Infra - MEP</td>')).toHaveLength(0);
  });
});
