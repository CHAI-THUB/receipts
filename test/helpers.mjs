import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CLI = new URL('../bin/receipts.mjs', import.meta.url).pathname;

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) fs.rmSync(abs);
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
}

export function makeRepo(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-fixture-')));
  sh(dir, 'git', ['init', '-q']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'Test']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  write(dir, files);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'base']);
  return dir;
}

export const CART = `export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return sum;
}

export function discount(amount, code) {
  if (code === 'SAVE10') return amount * 0.9;
  return amount;
}
`;

export const CART_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { total, discount } from '../src/cart.mjs';

test('total adds up line items', () => {
  assert.equal(total([{ price: 2, qty: 3 }]), 6);
});

test('SAVE10 takes ten percent off', () => {
  assert.equal(discount(100, 'SAVE10'), 90);
});
`;

export const jsRepo = () =>
  makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'src/cart.mjs': CART,
    'test/cart.test.mjs': CART_TEST,
  });

// The two edits an agent might make: a bug fix in total(), a new code in discount().
export const FIX_TOTAL = (src) =>
  src.replace('sum += item.price * item.qty;', 'sum += item.price * Math.max(0, item.qty);');
export const ADD_SAVE20 = (src) =>
  src.replace("  return amount;\n", "  if (code === 'SAVE20') return amount * 0.8;\n  return amount;\n");
export const TEST_FOR_FIX = `
test('negative quantities are ignored', () => {
  assert.equal(total([{ price: 2, qty: -1 }, { price: 5, qty: 1 }]), 5);
});
`;

export const statuses = (report) =>
  Object.fromEntries(report.files.map((f) => [f.path, f.units.map((u) => u.status)]));
