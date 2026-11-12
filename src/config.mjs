import fs from 'node:fs';
import path from 'node:path';

const has = (root, f) => fs.existsSync(path.join(root, f));

export function readConfig(root) {
  const file = path.join(root, '.receipts.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`.receipts.json is not valid JSON: ${e.message}`);
  }
}

/** Best guess at how this repo runs its tests. Returns null rather than guessing wildly. */
export function detectTestCommand(root) {
  if (has(root, 'package.json')) {
    try {
      const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts?.test;
      if (script && !/no test specified/.test(script)) {
        if (has(root, 'pnpm-lock.yaml')) return 'pnpm test';
        if (has(root, 'yarn.lock')) return 'yarn test';
        if (has(root, 'bun.lockb') || has(root, 'bun.lock')) return 'bun run test';
        return 'npm test';
      }
    } catch { /* fall through */ }
  }
  if (has(root, 'go.mod')) return 'go test ./...';
  if (has(root, 'Cargo.toml')) return 'cargo test';
  if (has(root, 'pytest.ini') || has(root, 'pyproject.toml') || has(root, 'tox.ini') || has(root, 'setup.cfg')) {
    return 'python3 -m pytest -q -x';
  }
  if (has(root, 'Makefile') && /^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) return 'make test';
  return null;
}
