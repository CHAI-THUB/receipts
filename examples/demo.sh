#!/usr/bin/env bash
# Builds a tiny project in a temp folder, makes the kind of change an agent
# makes (one tested fix, one untested extra, one weakened test), and runs receipts.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$(mktemp -d)"
cd "$dir"
git init -q && git config user.email demo@example.com && git config user.name Demo

mkdir -p src test
cat > package.json <<'EOF'
{ "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > src/cart.mjs <<'EOF'
export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return sum;
}

export function discount(amount, code) {
  if (code === 'SAVE10') return amount * 0.9;
  return amount;
}
EOF
cat > test/cart.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { total, discount } from '../src/cart.mjs';

test('total adds up line items', () => {
  assert.equal(total([{ price: 2, qty: 3 }]), 6);
});

test('SAVE10 takes ten percent off', () => {
  assert.equal(discount(100, 'SAVE10'), 90);
  assert.equal(discount(100, 'NOPE'), 100);
});
EOF
git add -A && git commit -q -m "base"

# --- the "agent" change -------------------------------------------------------
cat > src/cart.mjs <<'EOF'
export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price * Math.max(0, item.qty);
  return sum;
}

export function discount(amount, code) {
  if (code === 'SAVE10') return amount * 0.9;
  if (code === 'SAVE20') return amount * 0.8;
  return amount;
}
EOF
cat > src/shipping.mjs <<'EOF'
export function cost(kg) {
  return 5 + kg * 2;
}

export function eta(days) {
  return days + 1;
}
EOF
cat > test/cart.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { total, discount } from '../src/cart.mjs';
import { cost } from '../src/shipping.mjs';

test('total adds up line items', () => {
  assert.equal(total([{ price: 2, qty: 3 }]), 6);
});

test('negative quantities are ignored', () => {
  assert.equal(total([{ price: 2, qty: -1 }, { price: 5, qty: 1 }]), 5);
});

test('SAVE10 takes ten percent off', () => {
  assert.equal(discount(100, 'SAVE10'), 90);
});

test('shipping cost', () => {
  assert.equal(cost(2), 9);
});
EOF

echo "demo project: $dir"
echo
node "$here/bin/receipts.mjs" prove "$@" || echo "(exit code $?)"
