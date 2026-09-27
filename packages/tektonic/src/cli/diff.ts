import * as fs from 'fs';
import * as path from 'path';

/** Difference between a freshly synthesized directory and the committed one. */
export interface DirDiff {
  /** Committed files whose content no longer matches what the project emits. */
  stale: string[];
  /** Files the project emits that are not committed at all. */
  missing: string[];
  /** Committed files the project no longer emits — what a `git status` check misses. */
  orphan: string[];
}

/** True when the diff found nothing. */
export function isClean(d: DirDiff): boolean {
  return d.stale.length === 0 && d.missing.length === 0 && d.orphan.length === 0;
}

/** Lists files under `dir` recursively, as paths relative to it. Missing dir yields `[]`. */
export function listFiles(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

/**
 * Compares a freshly synthesized tree against the committed one.
 *
 * The comparison is recursive and symmetric on purpose: a check that only re-synthesizes over
 * the committed directory and looks at `git status` cannot see files the project stopped
 * emitting, so stale manifests keep being applied by the cluster long after the code dropped
 * them.
 */
export function diffDirs(freshDir: string, committedDir: string): DirDiff {
  const fresh = new Set(listFiles(freshDir));
  const committed = new Set(listFiles(committedDir));
  const diff: DirDiff = { stale: [], missing: [], orphan: [] };

  for (const file of fresh) {
    if (!committed.has(file)) {
      diff.missing.push(file);
      continue;
    }
    const a = fs.readFileSync(path.join(freshDir, file));
    const b = fs.readFileSync(path.join(committedDir, file));
    if (!a.equals(b)) diff.stale.push(file);
  }
  for (const file of committed) {
    if (!fresh.has(file)) diff.orphan.push(file);
  }
  return diff;
}

/**
 * Makes `targetDir` hold exactly what `freshDir` does: writes files that are new or changed,
 * leaves identical ones untouched (so their mtimes don't churn), deletes orphans and the
 * directories they empty. Returns the orphans it deleted, relative to `targetDir`.
 */
export function syncDir(freshDir: string, targetDir: string): { removed: string[] } {
  const diff = diffDirs(freshDir, targetDir);
  for (const file of [...diff.missing, ...diff.stale]) {
    const dest = path.join(targetDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(freshDir, file), dest);
  }
  for (const file of diff.orphan) {
    fs.rmSync(path.join(targetDir, file));
    // Walk up, removing directories the deletion left empty, but never the outdir itself.
    for (let dir = path.dirname(path.join(targetDir, file)); dir !== targetDir; dir = path.dirname(dir)) {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    }
  }
  return { removed: diff.orphan };
}

/** Renders a diff as the lines `tektonic check` prints, most actionable first. */
export function formatDiff(outdir: string, d: DirDiff): string[] {
  const lines: string[] = [];
  for (const f of d.stale) lines.push(`  stale    ${outdir}/${f} — committed content differs from synthesis`);
  for (const f of d.missing) lines.push(`  missing  ${outdir}/${f} — emitted by the project, not committed`);
  for (const f of d.orphan) lines.push(`  orphan   ${outdir}/${f} — committed, no longer emitted`);
  return lines;
}
