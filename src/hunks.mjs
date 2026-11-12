import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.mjs';
import { extOf, isTrivial } from './classify.mjs';

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Line ranges that differ between two texts. Git does the diffing; nearby
 * edits (within 2 lines) are fused so that one logical change is one unit.
 */
export function diffRanges(beforeText, afterText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), beforeText);
    fs.writeFileSync(path.join(dir, 'b'), afterText);
    const r = git(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--text', '-U0', '--inter-hunk-context=2', 'a', 'b'],
      { cwd: dir, allowFail: true },
    );
    const ranges = [];
    for (const line of r.stdout.split('\n')) {
      const m = HEADER.exec(line);
      if (!m) continue;
      ranges.push({
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
      });
    }
    return ranges;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Put the old lines back for one range, leaving the rest of the new file intact. */
export function revertRange(beforeText, afterText, r) {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  const oldLines = r.oldCount > 0 ? before.slice(r.oldStart - 1, r.oldStart - 1 + r.oldCount) : [];
  // With zero new lines git reports the line *after which* the deletion happened.
  if (r.newCount > 0) after.splice(r.newStart - 1, r.newCount, ...oldLines);
  else after.splice(r.newStart, 0, ...oldLines);
  return after.join('\n');
}

/**
 * Split a brand-new file into top-level blocks (a blank line followed by an
 * unindented line starts a new block). Each block can be removed on its own,
 * which is how a new file gets finer-grained proof than "the file exists".
 */
export function topLevelBlocks(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const blocks = [];
  let start = 0;
  for (let i = 1; i < lines.length; i++) {
    const startsBlock = lines[i - 1].trim() === '' && lines[i].trim() !== '' && !/^[\s)\]}]/.test(lines[i]);
    if (startsBlock) {
      blocks.push([start, i - 1]);
      start = i;
    }
  }
  if (lines.length) blocks.push([start, lines.length - 1]);
  return blocks.map(([s, e]) => {
    while (e > s && lines[e].trim() === '') e--;
    return { oldStart: 0, oldCount: 0, newStart: s + 1, newCount: e - s + 1 };
  });
}

const preview = (lines) => {
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const t = first.trim();
  return t.length > 64 ? `${t.slice(0, 61)}...` : t;
};

/**
 * Turn one changed source file into checkable units. Each unit knows how to
 * produce the "what if this part had not been changed" version of the file
 * (`mutant`: a string, or null meaning the file should not exist).
 */
export function unitsForFile(change) {
  const ext = extOf(change.path);
  const before = change.before ? change.before.toString('utf8') : null;
  const after = change.after ? change.after.toString('utf8') : null;
  const units = [];

  if (after === null) {
    units.push({ kind: 'file-deleted', label: 'file deleted', preview: '', mutant: before, trivial: false });
    return units;
  }
  const afterLines = after.split('\n');

  if (before === null) {
    const blocks = topLevelBlocks(after);
    if (blocks.length <= 1) {
      units.push({ kind: 'file-added', label: 'new file', preview: preview(afterLines), mutant: null, trivial: false });
      return units;
    }
    for (const r of blocks) {
      const newLines = afterLines.slice(r.newStart - 1, r.newStart - 1 + r.newCount);
      units.push({
        kind: 'block-added',
        label: `L${r.newStart}-${r.newStart + r.newCount - 1}`,
        preview: preview(newLines),
        mutant: revertRange('', after, r),
        trivial: isTrivial([], newLines, ext),
      });
    }
    return units;
  }

  const beforeLines = before.split('\n');
  for (const r of diffRanges(before, after)) {
    const oldLines = r.oldCount > 0 ? beforeLines.slice(r.oldStart - 1, r.oldStart - 1 + r.oldCount) : [];
    const newLines = r.newCount > 0 ? afterLines.slice(r.newStart - 1, r.newStart - 1 + r.newCount) : [];
    units.push({
      kind: r.newCount === 0 ? 'lines-deleted' : 'modified',
      label:
        r.newCount === 0
          ? `after L${r.newStart} (${r.oldCount} line${r.oldCount === 1 ? '' : 's'} deleted)`
          : r.newCount === 1
            ? `L${r.newStart}`
            : `L${r.newStart}-${r.newStart + r.newCount - 1}`,
      preview: preview(newLines.length ? newLines : oldLines),
      mutant: revertRange(before, after, r),
      trivial: isTrivial(oldLines, newLines, ext),
    });
  }
  return units;
}
