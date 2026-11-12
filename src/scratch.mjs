import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git, splitZ } from './git.mjs';
import { NEVER, HEAVY } from './changes.mjs';

const banned = (rel) => rel.endsWith('.pyc') || rel.split('/').some((s) => NEVER.has(s));

function copyFile(root, dir, rel) {
  const src = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    return; // deleted in the working tree
  }
  const dst = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
  else if (st.isFile()) fs.copyFileSync(src, dst);
}

function link(root, dir, rel) {
  const src = path.join(root, rel);
  const dst = path.join(dir, rel);
  if (fs.existsSync(dst) || !fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? 'dir' : 'file');
}

/**
 * A throwaway copy of the working tree. Source and test files are real copies,
 * so experiments never touch the user's files; git-ignored entries such as
 * installed dependencies are symlinked so the test command can still run.
 */
export function createScratch(root) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-')));
  for (const rel of splitZ(git(['ls-files', '-z', '-c'], { cwd: root }).stdout)) {
    if (!banned(rel)) copyFile(root, dir, rel);
  }
  const untracked = splitZ(git(['ls-files', '-z', '-o', '--exclude-standard', '--directory'], { cwd: root }).stdout);
  for (const entry of untracked) {
    const rel = entry.replace(/\/$/, '');
    if (banned(rel)) continue;
    if (!entry.endsWith('/')) copyFile(root, dir, rel);
    else if (HEAVY.has(path.basename(rel))) link(root, dir, rel);
    else {
      fs.cpSync(path.join(root, rel), path.join(dir, rel), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !banned(path.relative(root, src).split(path.sep).join('/')) && !HEAVY.has(path.basename(src)),
      });
    }
  }
  const ignored = splitZ(git(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'], { cwd: root }).stdout);
  for (const entry of ignored) {
    const rel = entry.replace(/\/$/, '');
    if (!banned(rel)) link(root, dir, rel);
  }
  return dir;
}

/** Write (or remove, when content is null) a file, refusing to leave the scratch directory. */
export function place(dir, rel, content) {
  const dst = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const parent = fs.realpathSync(path.dirname(dst));
  if (parent !== dir && !parent.startsWith(dir + path.sep)) {
    throw new Error(`Refusing to write outside the scratch copy: ${rel}`);
  }
  if (content === null) fs.rmSync(dst, { force: true });
  else {
    if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) fs.rmSync(dst);
    fs.writeFileSync(dst, content);
  }
}

export function destroyScratch(dir) {
  fs.rmSync(dir, { recursive: true, force: true }); // symlinks are unlinked, never followed
}

/** Run the test command; resolves with exit status, timing and the last lines of output. */
export function run(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, CI: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1', RECEIPTS: '1' };
    // If receipts itself is started from a `node --test` run, the project's own
    // test command must not mistake itself for a child of that run.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }, timeoutMs);
    const done = (code) => {
      clearTimeout(timer);
      resolve({
        pass: code === 0 && !timedOut,
        code,
        timedOut,
        ms: Date.now() - t0,
        tail: out.trimEnd().split('\n').slice(-20).join('\n'),
      });
    };
    child.on('close', (code) => done(code));
    child.on('error', (e) => {
      out += String(e);
      done(127);
    });
  });
}
