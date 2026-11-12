import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, splitZ } from './git.mjs';
import { classify } from './classify.mjs';

// Never copied, linked, or treated as part of a change.
export const NEVER = new Set([
  '.git', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.nyc_output', 'coverage', '.receipts',
]);
// Dependency trees: linked rather than copied even when a repo forgot to ignore them.
export const HEAVY = new Set(['node_modules', '.venv', 'venv', '.tox']);

export const skipPath = (rel) =>
  rel.endsWith('.pyc') || rel.split('/').some((seg) => NEVER.has(seg) || HEAVY.has(seg));

const isBinary = (buf) => buf && buf.subarray(0, 8000).includes(0);

function readWorkingFile(root, rel) {
  try {
    const abs = path.join(root, rel);
    if (!fs.lstatSync(abs).isFile()) return undefined; // symlink, submodule, directory
    return fs.readFileSync(abs);
  } catch {
    return undefined;
  }
}

/**
 * Everything that differs between `baseSha` and the working tree, including
 * staged, unstaged and untracked files. Renames are treated as delete + add.
 */
export function collectChanges(root, baseSha) {
  const out = [];
  const diff = splitZ(git(['diff', '--name-status', '--no-renames', '-z', baseSha], { cwd: root }).stdout);
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const status = diff[i][0] === 'A' ? 'A' : diff[i][0] === 'D' ? 'D' : 'M';
    out.push({ path: diff[i + 1], status });
  }
  const untracked = splitZ(git(['ls-files', '-z', '-o', '--exclude-standard'], { cwd: root }).stdout);
  for (const p of untracked) out.push({ path: p, status: 'A' });

  const result = [];
  for (const c of out) {
    if (skipPath(c.path)) continue;
    const before =
      c.status === 'A' ? null : git(['show', `${baseSha}:${c.path}`], { cwd: root, buffer: true, allowFail: true }).stdout;
    const after = c.status === 'D' ? null : readWorkingFile(root, c.path);
    if (after === undefined) continue;
    result.push({
      ...c,
      before,
      after,
      kind: classify(c.path),
      binary: isBinary(before) || isBinary(after),
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Stable identity of "the code as it stands now", used to tell whether a receipt is current. */
export function fingerprint(changes) {
  const h = crypto.createHash('sha256');
  for (const c of changes) {
    if (c.kind === 'other') continue;
    h.update(c.path).update('\0');
    h.update(c.after ? crypto.createHash('sha256').update(c.after).digest('hex') : 'DELETED').update('\0');
  }
  return h.digest('hex');
}
