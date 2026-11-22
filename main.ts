// mend: one patch tool for every AI edit format.
//
// Implements SPEC.md sections 1-10: the command line, output and exit
// codes, safe paths and line breaks, format auto-detection, three-tier
// line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edits, applied in order and all-or-nothing.
//
// Node 22 standard library only. Run as: node main.ts [options] [PATCH]

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A parse fault carries the 1-based patch line the format's section names. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function parseFail(line: number): never {
  throw new ParseError(line);
}

/**
 * A patch's lines: its text split at '\n', each with one trailing '\r'
 * removed, and without the empty piece after a final '\n' (SPEC section 3).
 * An empty patch has no lines.
 */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Remove trailing spaces and tabs. */
function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** Remove leading and trailing spaces and tabs. */
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Byte order of paths (UTF-8), for the exit-0 listing (SPEC section 2). */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Files: lines, line breaks, final line break (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileShape {
  lines: string[];
  br: '\r\n' | '\n';
  eol: boolean;
}

/**
 * A file's line break is CRLF when its first line feed follows a carriage
 * return, and LF otherwise. Its lines are its text split at that break.
 * It ends with a line break when its text ends with that break; that last,
 * empty piece is not a line. An empty file has no lines.
 */
function parseFile(text: string): FileShape {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const firstLf = text.indexOf('\n');
  const br: '\r\n' | '\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    eol = true;
    lines.pop();
  }
  return { lines, br, eol };
}

/** Write a file's lines back with its own break, and a final one iff eol. */
function serializeFile(lines: string[], br: string, eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (eol ? br : '');
}

/**
 * A path is safe when it is not empty, does not start with '/', holds no
 * '\', and none of its '/'-separated segments is empty, '.' or '..'.
 */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Three-tier line matching (SPEC section 5)
// ---------------------------------------------------------------------------

/** One line matches another at a tier: 0 exact, 1 trailing ws ignored, 2 both sides' ws ignored. */
function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

interface TierHit {
  tier: number;
  positions: number[];
}

/**
 * O is found at the first tier at which it occurs at least once, searching
 * from `from`. Occurrences may overlap. With --strict only tier 0 is tried.
 */
function findTier(lines: string[], oldLines: string[], from: number, strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + oldLines.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (!lineMatches(lines[i + j], oldLines[j], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Find a single-line anchor at or after `from`, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineMatches(lines[i], anchor, tier)) return i;
    }
  }
  return null;
}

// A line of N: either a context line (written as the file's own matched
// line, at the ctxIndex-th line of O) or a fresh line (ctxIndex null).
interface NewEntry {
  text: string;
  ctxIndex: number | null;
}

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** Split a chunk/hunk's body items into its old lines O and its new lines N. */
function itemsToOldNew(items: BodyItem[]): { oldLines: string[]; newEntries: NewEntry[] } {
  const oldLines: string[] = [];
  const newEntries: NewEntry[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      oldLines.push(it.text);
      newEntries.push({ text: it.text, ctxIndex: oIdx });
      oIdx++;
    } else if (it.kind === 'old') {
      oldLines.push(it.text);
      oIdx++;
    } else {
      newEntries.push({ text: it.text, ctxIndex: null });
    }
  }
  return { oldLines, newEntries };
}

/**
 * Build the replacement lines for a matched occurrence at `pos`.
 * A context line is written as the file's own matched line, never the
 * patch's. At tier 2 every other line of N is re-indented: with F the
 * leading spaces/tabs of the file's first matched line and P those of O's
 * first line, a line that is not empty and not only whitespace and starts
 * with P has that P replaced by F; any other line is written as it is.
 * At tiers 0 and 1 the lines of N are written as they are.
 */
function buildReplacement(
  fileLines: string[],
  pos: number,
  tier: number,
  oldLines: string[],
  newEntries: NewEntry[],
): string[] {
  const out: string[] = [];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldLines[0] ?? '');
  for (const e of newEntries) {
    if (e.ctxIndex !== null) {
      out.push(fileLines[pos + e.ctxIndex]);
      continue;
    }
    let text = e.text;
    if (tier === 2 && !/^[ \t]*$/.test(text) && text.startsWith(p)) {
      text = f + text.slice(p.length);
    }
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits: one edit is a function that applies itself to the in-memory tree.
// It mutates the tree only when it succeeds, so a failed edit changes
// nothing; it returns its failure (code + path) or null on success.
// ---------------------------------------------------------------------------

interface EditFailure {
  code: string;
  path: string;
}

interface EditContext {
  // Successful move edits, in order, for the R-line collapsing (section 2).
  moves: [string, string][];
}

type Edit = (tree: Map<string, string>, strict: boolean, ctx: EditContext) => EditFailure | null;

/** The first unsafe path in `paths`, or null when all are safe. */
function firstUnsafe(paths: string[]): string | null {
  for (const p of paths) {
    if (!isSafePath(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Format auto-detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const firstNonBlank = lines.find((l) => l.trim() !== '');
  if (firstNonBlank !== undefined) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const firstChar = firstNonBlank.replace(/^\s+/, '')[0];
    if (firstChar === '[' || firstChar === '{') return 'json';
  }
  if (lines.some((l) => rtrimWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l) => l.startsWith('diff --git '))) return 'unified';
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

/**
 * The path of a '--- ' / '+++ ' line: text after the four characters, up to
 * the first tab, surrounding spaces removed, and a leading 'a/' or 'b/'
 * removed from either.
 */
function extractHeaderPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab === -1 ? rest : rest.slice(0, tab)).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  // True while still in a section's header, before its first hunk.
  let inHeader = false;
  const startSection = (s: UnifiedSection): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  const isHeaderStart = (idx: number): boolean =>
    lines[idx].startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) parseFail(i + 1);
      startSection({
        oldPath: null, newPath: null, renameFrom: null, renameTo: null,
        diffOld: m[1], diffNew: m[2], newFileMode: false, deletedFileMode: false, hunks: [],
      });
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      // A hunk before any section is a parse error.
      if (cur === null) parseFail(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/.exec(line);
      if (!m) parseFail(i + 1);
      const a = parseInt(m[1], 10);
      i++;
      // The hunk's body: lines starting with ' ', '-', '+' or '\', or empty
      // (an empty line is a context line whose text is empty). It ends at
      // the first other line, at a 'diff --git ' line, at a '--- ' line
      // followed by a '+++ ' line, or at the end of the patch.
      const entries: BodyEntry[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '') {
          entries.push({ kind: 'ctx', text: '', raw: bl });
          i++;
          continue;
        }
        const c = bl[0];
        if (c === ' ') {
          entries.push({ kind: 'ctx', text: bl.slice(1), raw: bl });
          i++;
          continue;
        }
        if (c === '-') {
          entries.push({ kind: 'old', text: bl.slice(1), raw: bl });
          i++;
          continue;
        }
        if (c === '+') {
          entries.push({ kind: 'new', text: bl.slice(1), raw: bl });
          i++;
          continue;
        }
        if (c === '\\') {
          entries.push({ kind: 'mark', text: bl, raw: bl });
          i++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (entries.length > 0) {
        const last = entries[entries.length - 1];
        if (last.kind === 'ctx' && last.raw.trim() === '') entries.pop();
        else break;
      }
      cur.hunks.push({ a, entries });
      inHeader = false;
      continue;
    }
    if (inHeader && cur !== null && line.startsWith('--- ')) {
      // Inside a section's header a '--- ' line must be followed by '+++ '.
      if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) parseFail(i + 2);
      cur.oldPath = extractHeaderPath(line);
      cur.newPath = extractHeaderPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (isHeaderStart(i)) {
      // A section starts at a '--- ' line followed by a '+++ ' line that is
      // not already part of a section's header.
      startSection({
        oldPath: extractHeaderPath(line), newPath: extractHeaderPath(lines[i + 1]),
        renameFrom: null, renameTo: null, diffOld: null, diffNew: null,
        newFileMode: false, deletedFileMode: false, hunks: [],
      });
      i += 2;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('+++ ')) {
        cur.newPath = extractHeaderPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
        i++;
        continue;
      }
      // 'index', 'old mode', 'new mode', 'similarity index',
      // 'dissimilarity index', 'Index:' and any other line are ignored.
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  if (sections.length === 0) parseFail(1);
  return sections.map((sec) => unifiedEdit(sec));
}

function unifiedEdit(sec: UnifiedSection): Edit {
  return (tree, strict, ctx) => {
    const oldPath = sec.oldPath ?? sec.renameFrom ?? sec.diffOld;
    const newPath = sec.newPath ?? sec.renameTo ?? sec.diffNew;
    const isCreate = oldPath === '/dev/null' || sec.newFileMode;
    const isDelete = newPath === '/dev/null' || sec.deletedFileMode;
    // Every path the edit names is checked for safety before anything else
    // about it. '/dev/null' is a sentinel meaning "no file", not a path.
    const safetyPaths: string[] = [];
    if (isCreate) {
      if (newPath !== null) safetyPaths.push(newPath);
    } else if (isDelete) {
      if (oldPath !== null) safetyPaths.push(oldPath);
    } else {
      if (oldPath !== null) safetyPaths.push(oldPath);
      if (newPath !== null) safetyPaths.push(newPath);
    }
    const unsafe = firstUnsafe(safetyPaths);
    if (unsafe !== null) return { code: 'unsafe', path: unsafe };
    if (oldPath === null || newPath === null) return { code: 'missing', path: oldPath ?? newPath ?? '' };

    if (isCreate) {
      if (tree.has(newPath)) return { code: 'exists', path: newPath };
      // The file is the '+' lines of all its hunks, in order.
      const plus: string[] = [];
      let lastPlusMark = false;
      for (const hunk of sec.hunks) {
        for (let k = 0; k < hunk.entries.length; k++) {
          const e = hunk.entries[k];
          if (e.kind === 'new') {
            plus.push(e.text);
            // A '\' line following the section's last '+' line.
            lastPlusMark = hunk.entries[k + 1] !== undefined && hunk.entries[k + 1].kind === 'mark';
          }
        }
      }
      // A created file is written with LF breaks, and ends with a line
      // break unless a '\' line follows its last '+' line.
      tree.set(newPath, plus.length === 0 ? '' : serializeFile(plus, '\n', !lastPlusMark));
      return null;
    }

    if (isDelete) {
      if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
      // Its hunks are not read.
      tree.delete(oldPath);
      return null;
    }

    const isMove = oldPath !== newPath;
    if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
    if (isMove && tree.has(newPath)) return { code: 'exists', path: newPath };

    // Apply the hunks in order to a copy, so any failure of a hunk fails
    // the section and the section changes nothing.
    const cur = parseFile(tree.get(oldPath) as string);
    let lines = [...cur.lines];
    let eol = cur.eol;
    const br = cur.br;
    // d: the sum over this section's hunks applied so far of (N's length
    // minus O's length).
    let d = 0;
    for (const hunk of sec.hunks) {
      const items: BodyItem[] = hunk.entries
        .filter((e) => e.kind !== 'mark')
        .map((e) => ({ kind: e.kind as 'ctx' | 'old' | 'new', text: e.text }));
      const { oldLines, newEntries } = itemsToOldNew(items);
      // Does a '\' line follow the hunk's last context or '+' line?
      let lastCtxNew = -1;
      for (let k = 0; k < hunk.entries.length; k++) {
        if (hunk.entries[k].kind === 'ctx' || hunk.entries[k].kind === 'new') lastCtxNew = k;
      }
      const hasNoEol =
        lastCtxNew >= 0 &&
        hunk.entries[lastCtxNew + 1] !== undefined &&
        hunk.entries[lastCtxNew + 1].kind === 'mark';

      if (oldLines.length === 0) {
        // Empty O: N is inserted after the first A + d lines (all of them
        // when the file has fewer).
        const insertIdx = Math.min(hunk.a + d, lines.length);
        const touchesEnd = insertIdx === lines.length;
        const newTexts = newEntries.map((e) => e.text);
        lines = [...lines.slice(0, insertIdx), ...newTexts, ...lines.slice(insertIdx)];
        if (touchesEnd) eol = !hasNoEol;
        d += newEntries.length;
      } else {
        const found = findTier(lines, oldLines, 0, strict);
        if (!found) return { code: 'no-match', path: oldPath };
        // Of the occurrences at the tier where O is found, the one whose
        // 0-based position is nearest to A - 1 + d; of two equally near,
        // the earlier.
        const target = hunk.a - 1 + d;
        let best = found.positions[0];
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const pos = best;
        const touchesEnd = pos + oldLines.length === lines.length;
        const replacement = buildReplacement(lines, pos, found.tier, oldLines, newEntries);
        lines = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + oldLines.length)];
        // When the matched lines run to the end of the file, the result
        // ends with a line break unless a '\' line follows the hunk's last
        // context or '+' line; when they do not, the file's final break
        // stays as it was.
        if (touchesEnd) eol = !hasNoEol;
        d += newEntries.length - oldLines.length;
      }
    }
    const text = serializeFile(lines, br, eol);
    if (isMove) {
      tree.delete(oldPath);
      tree.set(newPath, text);
      ctx.moves.push([oldPath, newPath]);
    } else {
      tree.set(oldPath, text);
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  // Index just after the previous block's '>>>>>>> REPLACE' line (or 0).
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWs(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      // Find '=======' after the SEARCH line.
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (rtrimWs(lines[j]) === '=======') {
          eq = j;
          break;
        }
        if (rtrimWs(lines[j]) === '<<<<<<< SEARCH') break;
      }
      if (eq === -1) parseFail(searchLine);
      // Find '>>>>>>> REPLACE' after it.
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (rtrimWs(lines[j]) === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (rtrimWs(lines[j]) === '<<<<<<< SEARCH') break;
      }
      if (rep === -1) parseFail(searchLine);
      // The path is the nearest line before the SEARCH line, and after the
      // previous block's REPLACE line (or the start of the patch), that is
      // not blank and, its surrounding whitespace removed, does not start
      // with three backticks.
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else parseFail(searchLine);
      }
      blocks.push({
        path,
        oldLines: lines.slice(i + 1, eq),
        newLines: lines.slice(eq + 1, rep),
      });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) parseFail(1);
  return blocks.map((b) => searchReplaceEdit(b.path, b.oldLines, b.newLines));
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    const unsafe = firstUnsafe([path]);
    if (unsafe !== null) return { code: 'unsafe', path: unsafe };
    if (oldLines.length === 0) {
      // Old lines empty: the file is created with the new lines.
      if (tree.has(path)) return { code: 'exists', path };
      tree.set(path, newLines.length === 0 ? '' : serializeFile(newLines, '\n', true));
      return null;
    }
    if (!tree.has(path)) return { code: 'missing', path };
    const cur = parseFile(tree.get(path) as string);
    const found = findTier(cur.lines, oldLines, 0, strict);
    if (!found) return { code: 'no-match', path };
    // The old lines occur at their tier exactly once, or the block fails
    // with 'ambiguous'.
    if (found.positions.length > 1) return { code: 'ambiguous', path };
    const pos = found.positions[0];
    const newEntries: NewEntry[] = newLines.map((text) => ({ text, ctxIndex: null }));
    const replacement = buildReplacement(cur.lines, pos, found.tier, oldLines, newEntries);
    const lines = [...cur.lines.slice(0, pos), ...replacement, ...cur.lines.slice(pos + oldLines.length)];
    tree.set(path, serializeFile(lines, cur.br, cur.eol));
    return null;
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: (BodyItem & { blank: boolean })[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function isV4aSectionStart(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4a(lines: string[]): Edit[] {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) parseFail(1);
  if (lines[firstIdx].trim() !== '*** Begin Patch') parseFail(firstIdx + 1);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx].trim() !== '*** End Patch') parseFail(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i];
    if (line.trim() === '') {
      // Blank lines between sections are ignored.
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: { text: string; blank: boolean }[] = [];
      let j = i + 1;
      while (j < lastIdx) {
        const l = lines[j];
        if (isV4aSectionStart(l)) break;
        if (l.startsWith('+')) {
          fileLines.push({ text: l.slice(1), blank: false });
          j++;
          continue;
        }
        if (l.trim() === '') {
          // An empty line of the file (blank lines at the end of a section
          // are stripped below).
          fileLines.push({ text: '', blank: true });
          j++;
          continue;
        }
        parseFail(j + 1);
      }
      // Blank lines at the end of a section are not part of it.
      while (fileLines.length > 0 && fileLines[fileLines.length - 1].blank) fileLines.pop();
      sections.push({ kind: 'add', path, lines: fileLines.map((e) => e.text), moveTo: null, chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < lastIdx) {
        const l = lines[j];
        if (isV4aSectionStart(l)) break;
        if (l.trim() === '') {
          j++;
          continue;
        }
        parseFail(j + 1);
      }
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      // '*** Move to: <path>' may be the section's first line.
      if (j < lastIdx && lines[j].startsWith('*** Move to: ')) {
        moveTo = lines[j].slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      // True once a chunk has been closed by '*** End of File': only a new
      // '@@' chunk may follow it.
      let afterEof = false;
      while (j < lastIdx) {
        const l = lines[j];
        if (isV4aSectionStart(l)) break;
        if (l.trim() === '*** End Patch') parseFail(j + 1);
        if (l.startsWith('@@')) {
          // The text after '@@', its surrounding spaces removed, is the
          // chunk's anchor; an empty text is no anchor.
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          chunks.push(curChunk);
          afterEof = false;
          j++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (afterEof) parseFail(j + 1);
          if (curChunk === null) {
            // An end-of-file chunk with no body lines yet.
            curChunk = { anchor: null, eof: true, items: [] };
            chunks.push(curChunk);
          } else {
            curChunk.eof = true;
          }
          afterEof = true;
          j++;
          continue;
        }
        if (l.startsWith('*** ')) parseFail(j + 1);
        // Body lines start with ' ', '-' or '+', or are empty (an empty
        // context line).
        const isBody =
          l === '' || l.trim() === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
        if (!isBody) parseFail(j + 1);
        if (afterEof) parseFail(j + 1);
        if (curChunk === null) {
          // For the first chunk, a chunk starts at a body line.
          curChunk = { anchor: null, eof: false, items: [] };
          chunks.push(curChunk);
        }
        if (l.trim() === '') {
          curChunk.items.push({ kind: 'ctx', text: l.startsWith(' ') ? l.slice(1) : '', blank: true });
        } else if (l[0] === ' ') {
          curChunk.items.push({ kind: 'ctx', text: l.slice(1), blank: false });
        } else if (l[0] === '-') {
          curChunk.items.push({ kind: 'old', text: l.slice(1), blank: false });
        } else {
          curChunk.items.push({ kind: 'new', text: l.slice(1), blank: false });
        }
        j++;
      }
      // Blank lines at the end of a section are not part of it.
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.items.length > 0) {
          const last = lastChunk.items[lastChunk.items.length - 1];
          if (last.kind === 'ctx' && last.blank) lastChunk.items.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) parseFail(updateLine);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks });
      i = j;
      continue;
    }
    // Any other line is a parse error.
    parseFail(i + 1);
  }
  if (sections.length === 0) parseFail(1);
  return sections.map((sec) => v4aEdit(sec));
}

function v4aEdit(sec: V4aSection): Edit {
  return (tree, strict, ctx) => {
    if (sec.kind === 'add') {
      const unsafe = firstUnsafe([sec.path]);
      if (unsafe !== null) return { code: 'unsafe', path: unsafe };
      if (tree.has(sec.path)) return { code: 'exists', path: sec.path };
      // The file is the section's lines, ended by a line break.
      tree.set(sec.path, sec.lines.length === 0 ? '' : serializeFile(sec.lines, '\n', true));
      return null;
    }
    if (sec.kind === 'delete') {
      const unsafe = firstUnsafe([sec.path]);
      if (unsafe !== null) return { code: 'unsafe', path: unsafe };
      if (!tree.has(sec.path)) return { code: 'missing', path: sec.path };
      tree.delete(sec.path);
      return null;
    }
    // Update.
    const safetyPaths = sec.moveTo === null ? [sec.path] : [sec.path, sec.moveTo];
    const unsafe = firstUnsafe(safetyPaths);
    if (unsafe !== null) return { code: 'unsafe', path: unsafe };
    if (!tree.has(sec.path)) return { code: 'missing', path: sec.path };
    if (sec.moveTo !== null && tree.has(sec.moveTo)) return { code: 'exists', path: sec.moveTo };

    // Apply the chunks in order to a copy, with a cursor that starts at
    // line 0, so any failure fails the section and changes nothing.
    const cur = parseFile(tree.get(sec.path) as string);
    let lines = [...cur.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        // A chunk with an anchor first finds the first line at or after
        // the cursor equal to the anchor at the first tier where one is.
        const anchorPos = findAnchor(lines, chunk.anchor, cursor, strict);
        if (anchorPos === null) return { code: 'no-match', path: sec.path };
        cursor = anchorPos + 1;
      }
      const items: BodyItem[] = chunk.items.map((e) => ({ kind: e.kind, text: e.text }));
      const { oldLines, newEntries } = itemsToOldNew(items);
      if (oldLines.length === 0) {
        // N is inserted at the cursor, or at the end of the file for an
        // end-of-file chunk.
        const insertIdx = chunk.eof ? lines.length : cursor;
        const newTexts = newEntries.map((e) => e.text);
        lines = [...lines.slice(0, insertIdx), ...newTexts, ...lines.slice(insertIdx)];
        cursor = insertIdx + newTexts.length;
      } else {
        let pos: number;
        let tier: number;
        if (chunk.eof) {
          // An end-of-file chunk takes only an occurrence that ends at the
          // file's last line, at the first tier where one is.
          const tiers = strict ? [0] : [0, 1, 2];
          let hit: TierHit | null = null;
          for (const t of tiers) {
            // Occurrences at/after the cursor that end at the file's last line.
            const positions: number[] = [];
            for (let idx = cursor; idx + oldLines.length <= lines.length; idx++) {
              if (idx + oldLines.length !== lines.length) continue;
              let ok = true;
              for (let jj = 0; jj < oldLines.length; jj++) {
                if (!lineMatches(lines[idx + jj], oldLines[jj], t)) {
                  ok = false;
                  break;
                }
              }
              if (ok) positions.push(idx);
            }
            if (positions.length > 0) {
              hit = { tier: t, positions };
              break;
            }
          }
          if (hit === null) return { code: 'no-match', path: sec.path };
          pos = hit.positions[0];
          tier = hit.tier;
        } else {
          const found = findTier(lines, oldLines, cursor, strict);
          if (!found) return { code: 'no-match', path: sec.path };
          // The chunk takes the first occurrence of O at or after the cursor.
          pos = found.positions[0];
          tier = found.tier;
        }
        const replacement = buildReplacement(lines, pos, tier, oldLines, newEntries);
        lines = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + oldLines.length)];
        // The cursor then moves to just after the lines written.
        cursor = pos + replacement.length;
      }
    }
    const text = serializeFile(lines, cur.br, cur.eol);
    if (sec.moveTo !== null) {
      tree.delete(sec.path);
      tree.set(sec.moveTo, text);
      ctx.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.set(sec.path, text);
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

interface JsonEditObject {
  kind: 'create' | 'str_replace' | 'insert';
  path: string;
  fileText: string;
  oldStr: string;
  newStr: string;
  insertLine: number;
}

/** Validate one edit object; any fault is a parse error at `line`. */
function validateJsonEdit(obj: unknown, line: number): JsonEditObject {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) parseFail(line);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') parseFail(line);
  if (typeof o.command !== 'string') parseFail(line);
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') parseFail(line);
    return { kind: 'create', path, fileText: o.file_text as string, oldStr: '', newStr: '', insertLine: 0 };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') parseFail(line);
    if ('new_str' in o && typeof o.new_str !== 'string') parseFail(line);
    const newStr = 'new_str' in o ? (o.new_str as string) : '';
    return { kind: 'str_replace', path, fileText: '', oldStr: o.old_str as string, newStr, insertLine: 0 };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) parseFail(line);
    if (typeof o.new_str !== 'string') parseFail(line);
    return {
      kind: 'insert', path, fileText: '', oldStr: '', newStr: o.new_str as string,
      insertLine: o.insert_line as number,
    };
  }
  parseFail(line);
}

function parseJson(lines: string[], patchText: string): Edit[] {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) parseFail(1);
  const firstChar = lines[firstIdx].replace(/^\s+/, '')[0];
  const edits: JsonEditObject[] = [];
  if (firstChar === '[') {
    // Array form: any fault is a parse error at the line where the array starts.
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      parseFail(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) parseFail(firstIdx + 1);
    for (const item of parsed) edits.push(validateJsonEdit(item, firstIdx + 1));
  } else {
    // JSON Lines: one edit object a line, blank lines ignored.
    for (let idx = 0; idx < lines.length; idx++) {
      if (lines[idx].trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[idx]);
      } catch {
        parseFail(idx + 1);
      }
      edits.push(validateJsonEdit(obj, idx + 1));
    }
  }
  if (edits.length === 0) parseFail(1);
  return edits.map((e) => jsonEdit(e));
}

function jsonEdit(e: JsonEditObject): Edit {
  return (tree) => {
    const unsafe = firstUnsafe([e.path]);
    if (unsafe !== null) return { code: 'unsafe', path: unsafe };
    if (e.kind === 'create') {
      if (tree.has(e.path)) return { code: 'exists', path: e.path };
      // Written with file_text's bytes, byte for byte.
      tree.set(e.path, e.fileText);
      return null;
    }
    if (!tree.has(e.path)) return { code: 'missing', path: e.path };
    if (e.kind === 'str_replace') {
      const text = tree.get(e.path) as string;
      const isCrlf = parseFile(text).br === '\r\n';
      // In a CRLF file, the file's text and both strings are read with
      // every '\r\n' as '\n', and the result is written back with '\r\n'.
      const normText = isCrlf ? text.replaceAll('\r\n', '\n') : text;
      const normOld = isCrlf ? e.oldStr.replaceAll('\r\n', '\n') : e.oldStr;
      const normNew = isCrlf ? e.newStr.replaceAll('\r\n', '\n') : e.newStr;
      // Count occurrences exactly (positions may overlap).
      let count = 0;
      let at = normText.indexOf(normOld);
      while (at !== -1) {
        count++;
        at = normText.indexOf(normOld, at + 1);
      }
      if (count === 0) return { code: 'no-match', path: e.path };
      if (count > 1) return { code: 'ambiguous', path: e.path };
      const replaced = normText.replace(normOld, normNew);
      tree.set(e.path, isCrlf ? replaced.replaceAll('\n', '\r\n') : replaced);
      return null;
    }
    // insert
    const cur = parseFile(tree.get(e.path) as string);
    if (e.insertLine < 0 || e.insertLine > cur.lines.length) return { code: 'no-match', path: e.path };
    // new_str's lines: split at '\n', each with one trailing '\r' removed,
    // without the empty piece after a final '\n'; an empty new_str has none.
    const newLines = splitPatchLines(e.newStr);
    const lines = [
      ...cur.lines.slice(0, e.insertLine),
      ...newLines,
      ...cur.lines.slice(e.insertLine),
    ];
    // The file's final break stays as it was.
    tree.set(e.path, serializeFile(lines, cur.br, cur.eol));
    return null;
  };
}

// ---------------------------------------------------------------------------
// The tree, the output, and the run
// ---------------------------------------------------------------------------

/** Read every regular file under the working directory into a map. */
function readTree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        try {
          out.set(rel, readFileSync(full, 'utf8'));
        } catch {
          // An unreadable file is left out of the tree.
        }
      }
    }
  };
  walk(process.cwd(), '');
  return out;
}

/** Write the differences between the original tree and the new one. */
function writeTree(orig: Map<string, string>, next: Map<string, string>): void {
  const paths = new Set([...orig.keys(), ...next.keys()]);
  for (const p of paths) {
    const o = orig.get(p);
    const n = next.get(p);
    if (o === n) continue;
    const full = join(process.cwd(), ...p.split('/'));
    if (n === undefined) {
      try {
        rmSync(full);
      } catch {
        // The file is already gone.
      }
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, n);
    }
  }
}

interface ChangeEntry {
  sortKey: string;
  line: string;
}

/**
 * The exit-0 listing: one line for each path whose state changed, in byte
 * order of the paths (R lines sort by the NEW path), then 'ok: n file(s)'.
 * A file whose bytes after the patch are its bytes before it is not listed.
 * A move replaces its pair's D and A lines with one R line and counts as
 * one file.
 */
function computeChanges(
  orig: Map<string, string>,
  next: Map<string, string>,
  moves: [string, string][],
): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  // Resolve move chains (A -> B, then B -> C is one move A -> C).
  const moveMap = new Map<string, string>();
  for (const [o, n] of moves) moveMap.set(o, n);
  for (const [o, n] of moves) {
    let dest = n;
    const seen = new Set<string>([o]);
    while (moveMap.has(dest) && !seen.has(dest)) {
      seen.add(dest);
      dest = moveMap.get(dest) as string;
    }
    if (orig.has(o) && !next.has(o) && !orig.has(dest) && next.has(dest)) {
      entries.push({ sortKey: dest, line: `R ${o} -> ${dest}` });
      coveredOld.add(o);
      coveredNew.add(dest);
    }
  }
  const paths = new Set([...orig.keys(), ...next.keys()]);
  for (const p of paths) {
    const o = orig.get(p);
    const n = next.get(p);
    if (o === n) continue;
    if (o !== undefined && n === undefined) {
      if (!coveredOld.has(p)) entries.push({ sortKey: p, line: `D ${p}` });
    } else if (o === undefined && n !== undefined) {
      if (!coveredNew.has(p)) entries.push({ sortKey: p, line: `A ${p}` });
    } else {
      entries.push({ sortKey: p, line: `M ${p}` });
    }
  }
  entries.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  return entries;
}

interface RunResult {
  out: string[];
  code: number;
}

function run(argv: string[]): RunResult {
  // --- Section 1: the command line. Options and PATCH may come in any order.
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let afterDashDash = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (afterDashDash) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (arg === '--check') {
      if (seenCheck) return { out: ['error: usage'], code: 2 };
      seenCheck = true;
      check = true;
      continue;
    }
    if (arg === '--strict') {
      if (seenStrict) return { out: ['error: usage'], code: 2 };
      seenStrict = true;
      strict = true;
      continue;
    }
    if (arg.startsWith('--format=')) {
      if (seenFormat) return { out: ['error: usage'], code: 2 };
      seenFormat = true;
      format = arg.slice('--format='.length);
      if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(format)) {
        return { out: ['error: usage'], code: 2 };
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') return { out: ['error: usage'], code: 2 };
    positionals.push(arg);
  }
  if (positionals.length > 1) return { out: ['error: usage'], code: 2 };
  const patchArg = positionals.length === 0 ? null : positionals[0];

  // --- Read the patch (from the PATCH file, or from standard input when
  // PATCH is absent or '-'). A file that cannot be read is 'no-patch'.
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { out: ['error: no-patch'], code: 2 };
    }
  }
  const lines = splitPatchLines(patchText);

  // --- Section 4: detect the format, or take the named one as it is.
  let formatName = format;
  if (formatName === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { out: ['error: format'], code: 2 };
    formatName = detected;
  }

  // --- Parse the patch. A parse error is reported before any file is looked at.
  let edits: Edit[];
  try {
    if (formatName === 'unified') edits = parseUnified(lines);
    else if (formatName === 'search-replace') edits = parseSearchReplace(lines);
    else if (formatName === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof ParseError) return { out: [`error: parse ${err.line}`], code: 2 };
    throw err;
  }

  // --- Section 10: edits apply in order to the tree as earlier edits left
  // it. Every failure is reported, and a failed edit changes nothing.
  const origTree = readTree();
  const tree = new Map(origTree);
  const failures: EditFailure[] = [];
  const ctx: EditContext = { moves: [] };
  for (const edit of edits) {
    const failure = edit(tree, strict, ctx);
    if (failure !== null) failures.push(failure);
  }
  if (failures.length > 0) {
    // When any edit failed, no file is written (exit 1).
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { out, code: 1 };
  }

  const changes = computeChanges(origTree, tree, ctx.moves);
  // With --check nothing is written, but the output and exit code are the same.
  if (!check) writeTree(origTree, tree);
  const out = changes.map((c) => c.line);
  out.push(`ok: ${changes.length} file${changes.length === 1 ? '' : 's'}`);
  return { out, code: 0 };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
