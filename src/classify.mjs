import path from 'node:path';

const TEST_PATTERNS = [
  /(^|\/)(tests?|__tests__|specs?|e2e|testing|__snapshots__)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb|exs?|dart|rs|cc|cpp|c)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)conftest\.py$/,
  /Tests?\.(java|kt|cs|scala|swift|php)$/,
  /_spec\.rb$/,
  /\.snap$/,
];

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'scala', 'cs', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'swift', 'php', 'pl', 'lua', 'sh', 'bash',
  'zsh', 'ex', 'exs', 'erl', 'clj', 'cljs', 'hs', 'ml', 'dart', 'r', 'jl', 'sql', 'vue', 'svelte',
  'zig', 'nim',
]);

const HASH_COMMENT = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'pl', 'r', 'jl', 'ex', 'exs', 'nim']);
const SLASH_COMMENT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'cs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'swift', 'php', 'dart', 'zig',
]);

export const extOf = (p) => path.extname(p).slice(1).toLowerCase();

/** 'test' | 'source' | 'other' (docs, config, data: not something a test run can vouch for). */
export function classify(p) {
  const norm = p.split(path.sep).join('/');
  if (TEST_PATTERNS.some((re) => re.test(norm))) return 'test';
  return CODE_EXT.has(extOf(norm)) ? 'source' : 'other';
}

function isCommentOrBlank(line, ext) {
  const t = line.trim();
  if (t === '') return true;
  if (HASH_COMMENT.has(ext)) return t.startsWith('#');
  if (SLASH_COMMENT.has(ext)) return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
  return false;
}

/**
 * A change that cannot alter behaviour: only comments and blank lines moved,
 * or only trailing whitespace differs. These are reported, never executed.
 */
export function isTrivial(oldLines, newLines, ext) {
  if ([...oldLines, ...newLines].every((l) => isCommentOrBlank(l, ext))) return true;
  const strip = (ls) => ls.map((l) => l.trimEnd()).filter((l) => l !== '');
  const a = strip(oldLines);
  const b = strip(newLines);
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
