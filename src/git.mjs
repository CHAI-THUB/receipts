import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(args, { cwd, allowFail = false, buffer = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const splitZ = (s) => String(s).split('\0').filter(Boolean);

export function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/** A directory inside .git for our state, so nothing shows up in `git status`. */
export function stateDir(root) {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: root }).stdout.trim();
  const dir = path.join(gitDir, 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the commit the change is measured against.
 * `HEAD` means "uncommitted work"; any other ref means "everything since the
 * merge-base with that ref", which is what a pull request contains.
 */
export function resolveBase(root, ref = 'HEAD') {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root, allowFail: true });
  if (head.status !== 0) throw new Error('This repository has no commits yet; receipts needs a base commit to compare against.');
  const target = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, allowFail: true });
  if (target.status !== 0) throw new Error(`Cannot resolve base ref "${ref}".`);
  const sha = target.stdout.trim();
  if (sha === head.stdout.trim()) return sha;
  const mb = git(['merge-base', sha, 'HEAD'], { cwd: root, allowFail: true });
  return mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : sha;
}
