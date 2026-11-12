import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, resolveBase, stateDir } from './git.mjs';
import { collectChanges, fingerprint } from './changes.mjs';
import { unitsForFile } from './hunks.mjs';
import { integrityFindings } from './integrity.mjs';
import { createScratch, destroyScratch, place, run } from './scratch.mjs';
import { readConfig, detectTestCommand } from './config.mjs';

export const SCHEMA = 'receipts/v1';

export class UsageError extends Error {}

/**
 * The core experiment. For every changed piece of source code, put the old
 * code back (in a scratch copy) and run the tests:
 *   tests fail  -> the tests depend on that change: PROVEN
 *   tests pass  -> nothing checks that change:      UNPROVEN
 */
export async function prove(options = {}) {
  const log = options.log ?? (() => {});
  const root = repoRoot(options.cwd ?? process.cwd());
  if (!root) throw new UsageError('Not inside a git repository.');
  const config = readConfig(root);
  const opt = { base: 'HEAD', budget: 900, maxUnits: 60, ...config, ...options };
  const testCmd = opt.test ?? detectTestCommand(root);
  if (!testCmd) {
    throw new UsageError('No test command found. Pass --test "<command>" or add {"test": "..."} to .receipts.json.');
  }
  const baseSha = resolveBase(root, opt.base);
  const changes = collectChanges(root, baseSha);
  const sources = changes.filter((c) => c.kind === 'source' && !c.binary);
  const tests = changes.filter((c) => c.kind === 'test' && !c.binary);

  const report = {
    schema: SCHEMA,
    root,
    base: { ref: opt.base, sha: baseSha },
    testCommand: testCmd,
    startedAt: new Date().toISOString(),
    fingerprint: fingerprint(changes),
    verdict: null,
    green: null,
    withoutChange: null,
    files: [],
    integrity: integrityFindings(tests),
    testFilesChanged: tests.map((t) => t.path),
    notChecked: changes.filter((c) => c.kind === 'other' || c.binary).map((c) => c.path),
    summary: null,
  };

  for (const c of sources) {
    const units = unitsForFile(c).map((u) => ({ ...u, status: u.trivial ? 'trivial' : 'pending' }));
    report.files.push({ path: c.path, change: c.status, units, _before: c.before, _after: c.after });
  }
  const pending = () => report.files.flatMap((f) => f.units.map((u) => ({ f, u }))).filter((x) => x.u.status === 'pending');

  if (pending().length === 0) {
    report.verdict = 'nothing-to-prove';
    return finish(report, root);
  }

  const scratch = createScratch(root);
  try {
    log(`running tests on the change as delivered: ${testCmd}`);
    const green = await run(testCmd, scratch, (opt.timeout ?? 1800) * 1000);
    report.green = { pass: green.pass, ms: green.ms, timedOut: green.timedOut, tail: green.pass ? undefined : green.tail };
    if (!green.pass) {
      report.verdict = 'red';
      for (const { u } of pending()) u.status = 'not-run';
      return finish(report, root);
    }
    // A reverted change that hangs the suite counts as noticed, as in mutation testing.
    const timeoutMs = (opt.timeout ?? Math.max(60, Math.ceil((green.ms / 1000) * 4))) * 1000;

    log('running tests with every source change reverted');
    for (const f of report.files) place(scratch, f.path, f._before);
    const without = await run(testCmd, scratch, timeoutMs);
    for (const f of report.files) place(scratch, f.path, f._after);
    report.withoutChange = { testsFail: !without.pass, ms: without.ms, timedOut: without.timedOut };

    if (without.pass) {
      report.verdict = 'vacuous';
      for (const { u } of pending()) {
        u.status = 'unproven';
        u.reason = 'tests pass with the whole change reverted';
      }
      return finish(report, root);
    }

    const deadline = Date.now() + opt.budget * 1000;
    const queue = pending();
    for (let i = 0; i < queue.length; i++) {
      const { f, u } = queue[i];
      if (i >= opt.maxUnits || Date.now() > deadline) {
        u.status = 'not-run';
        u.reason = i >= opt.maxUnits ? 'over --max-units' : 'time budget used up';
        continue;
      }
      log(`[${i + 1}/${queue.length}] reverting ${f.path} ${u.label}`);
      place(scratch, f.path, u.mutant);
      const r = await run(testCmd, scratch, timeoutMs);
      place(scratch, f.path, f._after);
      u.ms = r.ms;
      if (r.pass) {
        u.status = 'unproven';
        u.reason = 'tests still pass with the old code';
      } else {
        u.status = 'proven';
        u.reason = r.timedOut ? 'tests hang with the old code' : 'tests fail with the old code';
      }
    }
    const all = report.files.flatMap((f) => f.units);
    report.verdict = all.some((u) => u.status === 'unproven' || u.status === 'not-run') ? 'partial' : 'proven';
    return finish(report, root);
  } finally {
    if (opt.keep) log(`scratch copy kept at ${scratch}`);
    else destroyScratch(scratch);
  }
}

function finish(report, root) {
  const units = report.files.flatMap((f) => f.units);
  const n = (s) => units.filter((u) => u.status === s).length;
  const proven = n('proven');
  const unproven = n('unproven');
  report.summary = {
    proven,
    unproven,
    trivial: n('trivial'),
    notRun: n('not-run'),
    checkable: proven + unproven,
    percent: proven + unproven === 0 ? null : Math.round((proven / (proven + unproven)) * 100),
    integrityFindings: report.integrity.length,
  };
  for (const f of report.files) {
    delete f._before;
    delete f._after;
    for (const u of f.units) {
      delete u.mutant;
      delete u.trivial;
    }
  }
  report.finishedAt = new Date().toISOString();
  const dir = stateDir(root);
  fs.writeFileSync(path.join(dir, 'last-report.json'), JSON.stringify(report, null, 2));
  const stateFile = path.join(dir, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch { /* first run */ }
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, receipt: report.fingerprint, receiptBase: report.base.sha }, null, 2));
  return report;
}

/** 0 everything checkable is proven · 1 something is unproven · 2 tests fail as delivered */
export function exitCode(report, { min = 100, strict = false } = {}) {
  if (report.verdict === 'red') return 2;
  if (report.verdict === 'vacuous') return 1;
  if (strict && report.integrity.length) return 1;
  if (report.summary.notRun > 0) return 1;
  if (report.summary.percent !== null && report.summary.percent < min) return 1;
  return 0;
}
