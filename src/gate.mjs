import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, resolveBase, stateDir, git } from './git.mjs';
import { collectChanges, fingerprint } from './changes.mjs';

const readState = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

/** SessionStart hook: remember where the session began, so committed work still counts as "the change". */
export function sessionStart(input) {
  const root = repoRoot(input.cwd ?? process.cwd());
  if (!root || !input.session_id) return;
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root, allowFail: true });
  if (head.status !== 0) return;
  const file = path.join(stateDir(root), 'state.json');
  const state = readState(file);
  const sessions = { ...(state.sessions ?? {}) };
  if (!sessions[input.session_id]) sessions[input.session_id] = head.stdout.trim();
  const keep = Object.fromEntries(Object.entries(sessions).slice(-20));
  fs.writeFileSync(file, JSON.stringify({ ...state, sessions: keep }, null, 2));
}

/**
 * Stop hook. Returns null to let the agent stop, or a hook response that
 * sends it back once. It never judges what the agent said; it only checks
 * a fact: source code changed and there is no receipt for its current state.
 */
export function gate(input) {
  if (input.stop_hook_active) return null;
  const root = repoRoot(input.cwd ?? process.cwd());
  if (!root) return null;
  const file = path.join(stateDir(root), 'state.json');
  const state = readState(file);
  const startSha = state.sessions?.[input.session_id];
  let baseRef = 'HEAD';
  let baseSha;
  try {
    baseSha = resolveBase(root, startSha ?? 'HEAD');
    if (startSha) baseRef = startSha.slice(0, 12);
  } catch {
    return null;
  }
  const changes = collectChanges(root, baseSha);
  if (!changes.some((c) => c.kind === 'source' && !c.binary)) return null;
  const fp = fingerprint(changes);
  if (state.receipt === fp || state.nagged === fp) return null;
  fs.writeFileSync(file, JSON.stringify({ ...state, nagged: fp }, null, 2));
  // Point at this very install, so the command works whether or not `receipts` is on PATH.
  const cli = fileURLToPath(new URL('../bin/receipts.mjs', import.meta.url));
  const cmd = `node "${cli}" prove${baseRef === 'HEAD' ? '' : ` --base ${baseRef}`}`;
  return {
    decision: 'block',
    reason:
      `Source files changed and there is no receipt for their current state. Run \`${cmd}\` ` +
      'and include its summary in your final message, listing every UNPROVEN change and test integrity warning as-is. ' +
      'Do not edit tests only to raise the score. If this repository has no runnable tests, say that plainly instead.',
  };
}
