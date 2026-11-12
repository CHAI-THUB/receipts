import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CLI, sh, write, makeRepo, jsRepo, CART, CART_TEST, FIX_TOTAL, ADD_SAVE20, TEST_FOR_FIX, statuses,
} from './helpers.mjs';
import { prove, exitCode } from '../src/prove.mjs';
import { renderText, renderMarkdown } from '../src/report.mjs';

const T = 'node --test';

test('a fix with a test that needs it is proven', async () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': FIX_TOTAL(CART), 'test/cart.test.mjs': CART_TEST + TEST_FOR_FIX });
  const r = await prove({ cwd: dir, test: T });
  assert.equal(r.verdict, 'proven');
  assert.deepEqual(statuses(r), { 'src/cart.mjs': ['proven'] });
  assert.equal(r.withoutChange.testsFail, true);
  assert.equal(exitCode(r), 0);
});

test('an untested change next to a tested one is singled out', async () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': ADD_SAVE20(FIX_TOTAL(CART)), 'test/cart.test.mjs': CART_TEST + TEST_FOR_FIX });
  const r = await prove({ cwd: dir, test: T });
  assert.equal(r.verdict, 'partial');
  assert.deepEqual(statuses(r), { 'src/cart.mjs': ['proven', 'unproven'] });
  assert.match(r.files[0].units[1].preview, /SAVE20/);
  assert.deepEqual(
    { proven: r.summary.proven, unproven: r.summary.unproven, percent: r.summary.percent },
    { proven: 1, unproven: 1, percent: 50 },
  );
  assert.equal(exitCode(r), 1);
  assert.equal(exitCode(r, { min: 50 }), 0);
  assert.match(renderText(r), /1\/2 changes proven \(50%\)/);
  assert.match(renderMarkdown(r), /UNPROVEN/);
});

test('tests that pass without the change are called vacuous', async () => {
  const dir = jsRepo();
  const pointless = `
test('SAVE20 exists', () => {
  assert.equal(typeof discount, 'function');
});
`;
  write(dir, { 'src/cart.mjs': ADD_SAVE20(CART), 'test/cart.test.mjs': CART_TEST + pointless });
  const r = await prove({ cwd: dir, test: T });
  assert.equal(r.verdict, 'vacuous');
  assert.equal(r.withoutChange.testsFail, false);
  assert.deepEqual(statuses(r), { 'src/cart.mjs': ['unproven'] });
  assert.equal(exitCode(r), 1);
});

test('a new file is checked block by block', async () => {
  const dir = jsRepo();
  write(dir, {
    'src/shipping.mjs':
      'export function cost(kg) {\n  return 5 + kg * 2;\n}\n\nexport function eta(days) {\n  return days + 1;\n}\n',
    'test/shipping.test.mjs':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { cost } from '../src/shipping.mjs';\n\ntest('cost', () => {\n  assert.equal(cost(2), 9);\n});\n",
  });
  const r = await prove({ cwd: dir, test: T });
  assert.deepEqual(statuses(r), { 'src/shipping.mjs': ['proven', 'unproven'] });
  assert.match(r.files[0].units[1].preview, /eta/);
});

test('failing tests stop the run with a red verdict', async () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': CART.replace('amount * 0.9', 'amount * 0.5') });
  const r = await prove({ cwd: dir, test: T });
  assert.equal(r.verdict, 'red');
  assert.equal(exitCode(r), 2);
  assert.deepEqual(statuses(r), { 'src/cart.mjs': ['not-run'] });
});

test('comment-only edits are not executed', async () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': CART.replace('  let sum = 0;', '  // running total\n  let sum = 0;') });
  const r = await prove({ cwd: dir, test: T });
  assert.equal(r.verdict, 'nothing-to-prove');
  assert.deepEqual(statuses(r), { 'src/cart.mjs': ['trivial'] });
  assert.equal(r.green, null);
  assert.equal(exitCode(r), 0);
});

test('weakened tests are reported', async () => {
  const dir = jsRepo();
  const weakened = CART_TEST
    .replace("  assert.equal(discount(100, 'SAVE10'), 90);\n", '')
    .replace("test('total adds up line items'", "test.skip('total adds up line items'");
  write(dir, { 'src/cart.mjs': ADD_SAVE20(CART), 'test/cart.test.mjs': weakened });
  const r = await prove({ cwd: dir, test: T });
  const issues = r.integrity.map((i) => i.issue).sort();
  assert.deepEqual(issues, ['existing assertions changed or removed', 'tests skipped']);
  assert.match(r.integrity.find((i) => i.issue.startsWith('existing')).detail, /SAVE10/);
  assert.equal(exitCode({ ...r, verdict: 'proven', summary: { ...r.summary, percent: 100, notRun: 0 } }, { strict: true }), 1);
});

test('deleting a test file is reported', async () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': ADD_SAVE20(CART), 'test/cart.test.mjs': null });
  const r = await prove({ cwd: dir, test: `${T} || true` });
  assert.equal(r.integrity[0].issue, 'test file deleted');
});

test('the working tree and ignored files are left exactly as they were', async () => {
  const dir = jsRepo();
  write(dir, { '.gitignore': 'node_modules/\n' });
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'ignore']);
  write(dir, {
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'src/cart.mjs': ADD_SAVE20(FIX_TOTAL(CART)),
    'test/cart.test.mjs': CART_TEST + TEST_FOR_FIX,
    'notes.md': 'untracked note\n',
  });
  const snapshot = () => ({
    status: sh(dir, 'git', ['status', '--porcelain']),
    cart: fs.readFileSync(path.join(dir, 'src/cart.mjs'), 'utf8'),
    dep: fs.readFileSync(path.join(dir, 'node_modules/dep/index.js'), 'utf8'),
  });
  const before = snapshot();
  // The command only passes if the ignored dependency is reachable from the scratch copy.
  const r = await prove({ cwd: dir, test: `test -f node_modules/dep/index.js && ${T}` });
  assert.equal(r.green.pass, true);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(r.notChecked, ['notes.md']);
});

test('--base measures a whole branch, including committed work', async () => {
  const dir = jsRepo();
  const main = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
  write(dir, { 'src/cart.mjs': FIX_TOTAL(CART), 'test/cart.test.mjs': CART_TEST + TEST_FOR_FIX });
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'fix']);
  const head = await prove({ cwd: dir, test: T });
  assert.equal(head.verdict, 'nothing-to-prove');
  const branch = await prove({ cwd: dir, test: T, base: main });
  assert.equal(branch.verdict, 'proven');
});

test('works for a Python project', { skip: spawnSync('python3', ['--version']).status !== 0 }, async () => {
  const dir = makeRepo({
    'calc.py': 'def area(w, h):\n    return w * h\n\n\ndef label(n):\n    return str(n)\n',
    'test_calc.py':
      'import unittest\nfrom calc import area\n\n\nclass T(unittest.TestCase):\n    def test_area(self):\n        self.assertEqual(area(2, 3), 6)\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
  });
  write(dir, {
    'calc.py':
      'def area(w, h):\n    if w < 0 or h < 0:\n        raise ValueError("negative")\n    return w * h\n\n\ndef label(n):\n    return "#" + str(n)\n',
    'test_calc.py':
      'import unittest\nfrom calc import area\n\n\nclass T(unittest.TestCase):\n    def test_area(self):\n        self.assertEqual(area(2, 3), 6)\n\n    def test_negative(self):\n        with self.assertRaises(ValueError):\n            area(-1, 3)\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
  });
  const r = await prove({ cwd: dir, test: 'python3 -m unittest -q' });
  assert.deepEqual(statuses(r), { 'calc.py': ['proven', 'unproven'] });
});

test('CLI: exit codes, JSON output and the saved report', () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': ADD_SAVE20(FIX_TOTAL(CART)), 'test/cart.test.mjs': CART_TEST + TEST_FOR_FIX });
  const run = (...args) => spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  const json = run('prove', '--json'); // test command auto-detected from package.json
  assert.equal(json.status, 1, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.schema, 'receipts/v1');
  assert.equal(report.testCommand, 'npm test');
  assert.equal(report.summary.unproven, 1);
  assert.equal(run('prove', '--quiet', '--min', '50').status, 0);
  assert.match(run('report').stdout, /1\/2 changes proven/);
  assert.match(run('report', '--md').stdout, /\| ✗ \| `src\/cart.mjs` \|/);
  assert.equal(sh(dir, 'git', ['status', '--porcelain']).includes('receipts'), false);
});

test('CLI: setup problems exit 3 with a plain message', () => {
  const dir = makeRepo({ 'lib.rb': 'def a; 1; end\n' });
  write(dir, { 'lib.rb': 'def a; 2; end\n' });
  const r = spawnSync('node', [CLI, 'prove'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /No test command found/);
});

test('editing an expected value is flagged; moving a test is not', async () => {
  const dir = jsRepo();
  const edited = CART_TEST.replace("discount(100, 'SAVE10'), 90", "discount(100, 'SAVE10'), 80");
  write(dir, { 'src/cart.mjs': CART.replace('amount * 0.9', 'amount * 0.8'), 'test/cart.test.mjs': edited });
  const r = await prove({ cwd: dir, test: T });
  assert.equal(r.verdict, 'proven', 'the score alone looks perfect');
  assert.deepEqual(r.integrity.map((i) => i.issue), ['existing assertions changed or removed']);

  const [head, a, b] = CART_TEST.split(/\n(?=test\()/);
  write(dir, { 'test/cart.test.mjs': [head, b.trimEnd() + '\n', a].join('\n') });
  write(dir, { 'src/cart.mjs': ADD_SAVE20(CART) });
  const moved = await prove({ cwd: dir, test: T });
  assert.deepEqual(moved.integrity, []);
});
