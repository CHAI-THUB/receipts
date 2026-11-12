const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const HEADLINE = {
  proven: 'Every checkable change is backed by a test that fails without it.',
  partial: 'Some changes have no test that would notice if they were undone.',
  vacuous: 'The tests pass even with the whole change reverted. They prove nothing about it.',
  red: 'The tests fail on the change as delivered.',
  'nothing-to-prove': 'No source changes that a test run could vouch for.',
};

const MARK = { proven: '✓', unproven: '✗', trivial: '·', 'not-run': '?' };
const WORD = { proven: 'proven', unproven: 'UNPROVEN', trivial: 'trivial', 'not-run': 'not run' };

function paint(useColor) {
  const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: wrap(32), red: wrap(31), yellow: wrap(33), dim: wrap(2), bold: wrap(1) };
}

export function renderText(report, { color = false } = {}) {
  const c = paint(color);
  const tone = { proven: c.green, unproven: c.red, trivial: c.dim, 'not-run': c.yellow };
  const out = [];
  out.push(c.bold('receipts') + c.dim(`  base ${report.base.ref} (${report.base.sha.slice(0, 7)})  ·  test: ${report.testCommand}`));
  out.push('');
  if (report.green) {
    out.push(`  as delivered        ${report.green.pass ? c.green('tests pass') : c.red('TESTS FAIL')} ${c.dim(secs(report.green.ms))}`);
  }
  if (report.withoutChange) {
    out.push(
      `  change reverted     ${report.withoutChange.testsFail ? c.green('tests fail (good: they notice the change)') : c.red('TESTS STILL PASS')} ${c.dim(secs(report.withoutChange.ms))}`,
    );
  }
  if (report.green) out.push('');
  for (const f of report.files) {
    out.push(`  ${c.bold(f.path)}${f.change === 'A' ? c.dim(' (new file)') : f.change === 'D' ? c.dim(' (deleted)') : ''}`);
    for (const u of f.units) {
      const head = `    ${MARK[u.status]} ${u.label.padEnd(12)} ${WORD[u.status].padEnd(9)}`;
      const why = u.status === 'trivial' ? 'comments or whitespace only' : (u.reason ?? '');
      out.push(tone[u.status](head) + c.dim(` ${why}`) + (u.preview ? c.dim(`   | ${u.preview}`) : ''));
    }
  }
  if (report.integrity.length) {
    out.push('');
    out.push(c.yellow('  test integrity'));
    for (const i of report.integrity) out.push(c.yellow(`    ! ${i.file}: ${i.issue} (${i.detail})`));
  }
  if (report.verdict !== 'nothing-to-prove' && report.testFilesChanged.length === 0) {
    out.push('');
    out.push(c.dim('  note: no test files changed; any proof comes from tests that already existed'));
  }
  if (report.notChecked.length) {
    out.push('');
    out.push(c.dim(`  not checked (docs, config, data): ${report.notChecked.join(', ')}`));
  }
  if (report.verdict === 'red' && report.green?.tail) {
    out.push('');
    out.push(c.dim('  last lines of test output:'));
    for (const l of report.green.tail.split('\n')) out.push(c.dim(`    ${l}`));
  }
  out.push('');
  const s = report.summary;
  const score = s.checkable ? `${s.proven}/${s.checkable} changes proven (${s.percent}%)` : 'nothing checked';
  const extra = [
    s.unproven ? `${s.unproven} need review` : null,
    s.notRun ? `${s.notRun} not run` : null,
    s.integrityFindings ? `${s.integrityFindings} test integrity warning${s.integrityFindings === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const good = report.verdict === 'proven' || report.verdict === 'nothing-to-prove';
  out.push('  ' + (good ? c.green : c.red)(c.bold([score, ...extra].join('  ·  '))));
  out.push('  ' + HEADLINE[report.verdict]);
  return out.join('\n');
}

export function renderMarkdown(report) {
  const s = report.summary;
  const out = [];
  out.push(`## Receipts: ${s.checkable ? `${s.proven}/${s.checkable} changes proven (${s.percent}%)` : 'nothing checked'}`);
  out.push('');
  out.push(HEADLINE[report.verdict]);
  out.push('');
  out.push(`Base \`${report.base.sha.slice(0, 7)}\` · test command \`${report.testCommand}\``);
  out.push('');
  const rows = report.files.flatMap((f) => f.units.map((u) => ({ f, u })));
  if (rows.length) {
    out.push('| | File | Where | Result | Why |');
    out.push('|---|---|---|---|---|');
    for (const { f, u } of rows) {
      const why = u.status === 'trivial' ? 'comments or whitespace only' : (u.reason ?? '');
      out.push(`| ${MARK[u.status]} | \`${f.path}\` | ${u.label} | ${WORD[u.status]} | ${why} |`);
    }
    out.push('');
  }
  if (report.integrity.length) {
    out.push('**Test integrity warnings**');
    out.push('');
    for (const i of report.integrity) out.push(`- \`${i.file}\`: ${i.issue} (${i.detail})`);
    out.push('');
  }
  if (report.notChecked.length) out.push(`Not checked (docs, config, data): ${report.notChecked.map((p) => `\`${p}\``).join(', ')}`);
  return out.join('\n').trimEnd() + '\n';
}
