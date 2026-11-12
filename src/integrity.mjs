// Static signals that a change made the tests weaker. Counted over the whole
// file before and after, so moving a test around does not raise a flag.

const count = (text, re) => (text ? (text.match(re) || []).length : 0);

const ASSERT = /\b(assert\w*|expect|should|require\.\w+|t\.(?:Error|Fatal|Fail)\w*|verify\w*)\s*[.(!]/g;
const CASE = /\b(?:it|test)(?:\.\w+)?\s*\(|\bdef\s+test_\w+|\bfunc\s+Test\w+|#\[test\]|@Test\b|\bit\s+['"]/g;
const SKIP =
  /\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip\w*\(|@Ignore\b|@Disabled\b|#\[ignore\]/g;
const FOCUS = /\.only\s*\(|\bf(?:it|describe)\s*\(/g;

/**
 * Lines matching `re` that were in the old file and are not in the new one.
 * A moved line is still present, so it is not reported; an assertion whose
 * expected value was edited is, which is exactly the case worth a human look.
 */
function goneLines(before, after, re) {
  const left = new Map();
  for (const l of after.split('\n')) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const gone = [];
  for (const raw of before.split('\n')) {
    const l = raw.trim();
    re.lastIndex = 0;
    if (!re.test(l)) continue;
    if (left.get(l) > 0) left.set(l, left.get(l) - 1);
    else gone.push(l);
  }
  re.lastIndex = 0;
  return gone;
}

export function integrityFindings(testChanges) {
  const findings = [];
  for (const c of testChanges) {
    const before = c.before ? c.before.toString('utf8') : '';
    const after = c.after ? c.after.toString('utf8') : '';
    if (c.status === 'D') {
      findings.push({ file: c.path, issue: 'test file deleted', detail: `${count(before, CASE)} test case(s) removed with it` });
      continue;
    }
    if (c.status === 'A') {
      if (count(after, SKIP)) findings.push({ file: c.path, issue: 'new tests are skipped', detail: `${count(after, SKIP)} skip marker(s)` });
      if (count(after, FOCUS)) findings.push({ file: c.path, issue: 'focused tests', detail: 'a .only / fit marker hides every other test' });
      continue;
    }
    const gone = goneLines(before, after, ASSERT);
    const lostCases = count(before, CASE) - count(after, CASE);
    const newSkips = count(after, SKIP) - count(before, SKIP);
    const newFocus = count(after, FOCUS) - count(before, FOCUS);
    if (lostCases > 0) findings.push({ file: c.path, issue: 'test cases removed', detail: `${lostCases} fewer than before` });
    if (gone.length) {
      findings.push({
        file: c.path,
        issue: 'existing assertions changed or removed',
        detail: `${gone.length}, e.g. \`${gone[0].length > 70 ? `${gone[0].slice(0, 67)}...` : gone[0]}\``,
      });
    }
    if (newSkips > 0) findings.push({ file: c.path, issue: 'tests skipped', detail: `${newSkips} new skip marker(s)` });
    if (newFocus > 0) findings.push({ file: c.path, issue: 'focused tests', detail: 'a .only / fit marker hides every other test' });
  }
  return findings;
}
