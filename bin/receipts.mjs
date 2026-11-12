#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { prove, exitCode, UsageError } from '../src/prove.mjs';
import { renderText, renderMarkdown } from '../src/report.mjs';
import { gate, sessionStart } from '../src/gate.mjs';
import { repoRoot, stateDir } from '../src/git.mjs';

const HELP = `receipts: which of these code changes would a test actually notice?

For each changed piece of source code, receipts puts the old code back in a
scratch copy of your repo and runs your tests. If they still pass, nothing is
checking that change.

Usage
  receipts prove [options]      run the experiment and print the report
  receipts report [--json|--md] reprint the last report
  receipts gate                 Stop-hook entry point (reads hook JSON on stdin)
  receipts session-start        SessionStart-hook entry point

Options for prove
  --base <ref>       compare against this commit or branch (default: HEAD,
                     meaning uncommitted work; use main for a whole branch)
  --test "<cmd>"     test command (default: .receipts.json, then auto-detect)
  --timeout <sec>    per-run timeout (default: 4x the first run, min 60)
  --budget <sec>     total time for per-change runs (default: 900)
  --max-units <n>    cap on changes checked individually (default: 60)
  --min <percent>    fail below this proven percentage (default: 100)
  --strict           treat test integrity warnings as failures
  --json             print the report as JSON
  --md <file>        also write a Markdown report (use - for stdout)
  --keep             keep the scratch copy for inspection
  --quiet            no progress lines

Exit codes
  0 every checkable change is proven    2 tests fail as delivered
  1 something is unproven               3 usage or setup problem
`;

function parseArgs(argv, valued) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`Unexpected argument: ${a}`);
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (valued.has(key)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`--${key} needs a value`);
      flags[key] = v;
    } else flags[key] = true;
  }
  return flags;
}

const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return n;
};

function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === 'version') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }

  if (cmd === 'gate' || cmd === 'session-start') {
    // Hooks must never break the session: any failure means "stay out of the way".
    try {
      const input = readStdinJson();
      if (cmd === 'session-start') sessionStart(input);
      else {
        const res = gate(input);
        if (res) process.stdout.write(JSON.stringify(res));
      }
    } catch { /* silent by design */ }
    return 0;
  }

  const flags = parseArgs(
    rest,
    new Set(cmd === 'prove' ? ['base', 'test', 'timeout', 'budget', 'max-units', 'min', 'md'] : []),
  );

  if (cmd === 'report') {
    const root = repoRoot(process.cwd());
    if (!root) throw new UsageError('Not inside a git repository.');
    const file = path.join(stateDir(root), 'last-report.json');
    if (!fs.existsSync(file)) throw new UsageError('No report yet. Run `receipts prove` first.');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else if (flags.md) process.stdout.write(renderMarkdown(report));
    else console.log(renderText(report, { color: process.stdout.isTTY }));
    return 0;
  }

  if (cmd === 'prove') {
    const quiet = flags.quiet || flags.json;
    const report = await prove({
      ...(flags.base ? { base: flags.base } : {}),
      ...(flags.test ? { test: flags.test } : {}),
      ...(flags.timeout ? { timeout: num(flags.timeout, 'timeout') } : {}),
      ...(flags.budget ? { budget: num(flags.budget, 'budget') } : {}),
      ...(flags['max-units'] ? { maxUnits: num(flags['max-units'], 'max-units') } : {}),
      keep: Boolean(flags.keep),
      log: quiet ? undefined : (m) => process.stderr.write(`receipts: ${m}\n`),
    });
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else console.log((quiet ? '' : '\n') + renderText(report, { color: process.stdout.isTTY }));
    if (flags.md === '-') process.stdout.write('\n' + renderMarkdown(report));
    else if (flags.md) fs.writeFileSync(flags.md, renderMarkdown(report));
    return exitCode(report, { min: num(flags.min, 'min') ?? 100, strict: Boolean(flags.strict) });
  }

  throw new UsageError(`Unknown command: ${cmd}\n\n${HELP}`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`receipts: ${err instanceof UsageError ? err.message : err.stack}\n`);
    process.exit(3);
  },
);
