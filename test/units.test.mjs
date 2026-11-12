import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CLI, sh, write, jsRepo, CART, CART_TEST, FIX_TOTAL, TEST_FOR_FIX } from './helpers.mjs';
import { diffRanges, revertRange, topLevelBlocks } from '../src/hunks.mjs';
import { classify, isTrivial } from '../src/classify.mjs';
import { gate, sessionStart } from '../src/gate.mjs';
import { prove } from '../src/prove.mjs';

test('reverting each range of a diff, one at a time, restores exactly that part', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', ''].join('\n');
  // replace b, delete f, insert after k
  const after = ['a', 'B', 'c', 'd', 'e', 'g', 'h', 'i', 'j', 'k', 'NEW', 'l', ''].join('\n');
  const ranges = diffRanges(before, after);
  assert.equal(ranges.length, 3);
  assert.equal(revertRange(before, after, ranges[0]), after.replace('B', 'b'));
  assert.equal(revertRange(before, after, ranges[1]), after.replace('e\ng', 'e\nf\ng'));
  assert.equal(revertRange(before, after, ranges[2]), after.replace('NEW\n', ''));
  // reverting all of them, last first, gives back the original
  const all = [...ranges].reverse().reduce((text, r) => revertRange(before, text, r), after);
  assert.equal(all, before);
});

test('edits within two lines of each other are one unit', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'A\nb\nc\nD\n';
  assert.equal(diffRanges(before, after).length, 1);
});

test('a new file splits at blank lines before unindented code', () => {
  const text = 'import x\n\ndef a():\n    return 1\n\n    # still a\n\n\nclass B:\n    pass\n';
  const blocks = topLevelBlocks(text).map((b) => [b.newStart, b.newCount]);
  assert.deepEqual(blocks, [[1, 1], [3, 4], [9, 2]]);
});

test('file classification', () => {
  const kinds = (ps) => ps.map(classify);
  assert.deepEqual(kinds(['src/a.ts', 'pkg/server.go', 'lib/x.py']), ['source', 'source', 'source']);
  assert.deepEqual(
    kinds(['src/a.test.ts', 'pkg/server_test.go', 'tests/test_x.py', 'spec/x_spec.rb', 'src/__tests__/a.js', 'FooTest.java']),
    ['test', 'test', 'test', 'test', 'test', 'test'],
  );
  assert.deepEqual(kinds(['README.md', 'package.json', 'logo.png']), ['other', 'other', 'other']);
});

test('trivial changes: comments and trailing whitespace, but not indentation', () => {
  assert.equal(isTrivial([], ['// note'], 'js'), true);
  assert.equal(isTrivial(['# old'], ['# new', ''], 'py'), true);
  assert.equal(isTrivial(['x = 1'], ['x = 1   '], 'py'), true);
  assert.equal(isTrivial(['    x = 1'], ['x = 1'], 'py'), false);
  assert.equal(isTrivial([], ['#include <a.h>'], 'c'), false);
  assert.equal(isTrivial(['a()'], ['b()'], 'js'), false);
});

test('gate: sends the agent back once per code state, and accepts a current receipt', async () => {
  const dir = jsRepo();
  const input = { cwd: dir, session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false };
  sessionStart(input);
  assert.equal(gate(input), null, 'clean tree: nothing to ask for');

  write(dir, { 'README.md': 'docs only\n' });
  assert.equal(gate(input), null, 'docs are not gated');

  write(dir, { 'src/cart.mjs': FIX_TOTAL(CART), 'test/cart.test.mjs': CART_TEST + TEST_FOR_FIX });
  const first = gate(input);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /receipts\.mjs" prove/);
  assert.equal(gate(input), null, 'never nags twice for the same code');
  assert.equal(gate({ ...input, stop_hook_active: true }), null);

  write(dir, { 'src/cart.mjs': FIX_TOTAL(CART) + '\nexport const VERSION = 2;\n' });
  assert.equal(gate(input).decision, 'block', 'new code state, new request');
  await prove({ cwd: dir, test: 'node --test' });
  assert.equal(gate(input), null, 'a receipt for this exact state satisfies the gate');
});

test('gate: committing the work does not hide it from the session', () => {
  const dir = jsRepo();
  const input = { cwd: dir, session_id: 's2', stop_hook_active: false };
  sessionStart(input);
  write(dir, { 'src/cart.mjs': FIX_TOTAL(CART) });
  sh(dir, 'git', ['commit', '-qam', 'agent commit']);
  const res = gate(input);
  assert.equal(res.decision, 'block');
  assert.match(res.reason, /--base [0-9a-f]{12}/);
});

test('gate CLI: valid hook output, and silence outside a repo or on bad input', () => {
  const dir = jsRepo();
  write(dir, { 'src/cart.mjs': FIX_TOTAL(CART) });
  const call = (cwd, stdin) => spawnSync('node', [CLI, 'gate'], { cwd, input: stdin, encoding: 'utf8' });
  const blocked = call(dir, JSON.stringify({ cwd: dir, session_id: 'x' }));
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  for (const r of [call('/', JSON.stringify({ cwd: '/' })), call(dir, 'not json{')]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
