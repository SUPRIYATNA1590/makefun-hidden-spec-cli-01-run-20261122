// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.
// Sections 5-8 below were written in the build session, in-session, from SPEC.md.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- section 5 helpers: lines of a file, three-tier matching, re-indentation ----

type FileParts = { lines: string[]; br: string; final: boolean };
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}
const leadingOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimTrail(s);
  return trimBoth(s);
}
function findTier(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}
function reindentLine(text: string, oldLines: string[], fileLines: string[], pos: number, tier: number): string {
  if (tier !== 2 || oldLines.length === 0) return text;
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  const p = leadingOf(oldLines[0]!);
  const f = leadingOf(fileLines[pos] ?? '');
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}
type BodyItem = { kind: 'ctx' | 'old' | 'new'; text: string; noNL: boolean };
function replacementFromBody(fileLines: string[], pos: number, tier: number, body: BodyItem[]): { oldLines: string[]; newLines: string[]; replacement: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctxOfNew: number[] = [];
  for (const it of body) {
    if (it.kind === 'ctx') { ctxOfNew.push(oldLines.length); oldLines.push(it.text); newLines.push(it.text); }
    else if (it.kind === 'old') { oldLines.push(it.text); }
    else { ctxOfNew.push(-1); newLines.push(it.text); }
  }
  const replacement = newLines.map((t, i) => {
    const oi = ctxOfNew[i]!;
    if (oi >= 0) return fileLines[pos + oi]!;
    return reindentLine(t, oldLines, fileLines, pos, tier);
  });
  return { oldLines, newLines, replacement };
}
function lastNNoNL(body: BodyItem[]): boolean | null {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const it = body[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.noNL;
  }
  return null;
}
function applyBodyToLines(lines: string[], pos: number, tier: number, body: BodyItem[]): string[] {
  const { oldLines, replacement } = replacementFromBody(lines, pos, tier, body);
  const out = lines.slice();
  out.splice(pos, oldLines.length, ...replacement);
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- section 6: unified diffs ----

type Hunk = { a: number; body: BodyItem[] };
type UniSection = {
  oldPath: string | null; newPath: string | null;
  isCreate: boolean; isDelete: boolean;
  hunks: Hunk[];
};
function uniPathFromHeader(line: string): string {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw;
}
function parseHunkBody(lines: string[], start: number): { body: BodyItem[]; next: number } {
  const body: BodyItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') { body.push({ kind: 'ctx', text: '', noNL: false }); j += 1; continue; }
    if (l[0] === ' ') { body.push({ kind: 'ctx', text: l.slice(1), noNL: false }); j += 1; continue; }
    if (l[0] === '-') { body.push({ kind: 'old', text: l.slice(1), noNL: false }); j += 1; continue; }
    if (l[0] === '+') { body.push({ kind: 'new', text: l.slice(1), noNL: false }); j += 1; continue; }
    if (l[0] === '\\') {
      if (body.length > 0) body[body.length - 1]!.noNL = true;
      j += 1; continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { body, next: j };
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  let cur: UniSection | null = null;
  let inHeader = false;
  let pairSeen = false;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let pairOldNull = false;
  let pairNewNull = false;
  const finishSection = (): void => {
    if (cur === null) return;
    const oldPath = pairOld !== null ? pairOld : pairOldNull ? null : renameFrom ?? diffOld;
    const newPath = pairNew !== null ? pairNew : pairNewNull ? null : renameTo ?? diffNew;
    cur.oldPath = oldPath;
    cur.newPath = newPath;
    sections.push(cur);
    cur = null;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    finishSection();
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    inHeader = true; pairSeen = false;
    diffOld = oldP; diffNew = newP;
    renameFrom = null; renameTo = null; pairOld = null; pairNew = null; pairOldNull = false; pairNewNull = false;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1; continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body: parsed.body });
      inHeader = false;
      i = parsed.next; continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairSeen) {
        const o = uniPathFromHeader(l);
        const n = uniPathFromHeader(lines[i + 1]!);
        pairOldNull = o === '/dev/null'; pairNewNull = n === '/dev/null';
        pairOld = pairOldNull ? null : o; pairNew = pairNewNull ? null : n;
        pairSeen = true;
        i += 2; continue;
      }
      const o = uniPathFromHeader(l);
      const n = uniPathFromHeader(lines[i + 1]!);
      startSection(null, null);
      pairOldNull = o === '/dev/null'; pairNewNull = n === '/dev/null';
      pairOld = pairOldNull ? null : o; pairNew = pairNewNull ? null : n;
      pairSeen = true;
      i += 2; continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1; continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        const n = uniPathFromHeader(l);
        pairNewNull = n === '/dev/null'; pairNew = pairNewNull ? null : n; pairSeen = true;
      } else if (l.startsWith('rename from ')) renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1; continue;
    }
    i += 1;
  }
  finishSection();
  // resolve create/delete flags from /dev/null
  for (const s of sections) {
    if (s.oldPath === null && s.newPath !== null) s.isCreate = true;
    if (s.newPath === null && s.oldPath !== null) s.isDelete = true;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate && !sec.isDelete;
    const isDelete = sec.isDelete && !sec.isCreate;
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    const single = isMove ? oldP : (oldP ?? newP);
    return (tree: Tree): void => {
      const toCheck: string[] = [];
      if (isCreate) { if (newP !== null) toCheck.push(newP); }
      else if (isDelete) { if (oldP !== null) toCheck.push(oldP); }
      else if (isMove) { if (oldP !== null) toCheck.push(oldP); if (newP !== null) toCheck.push(newP); }
      else if (single !== null) toCheck.push(single);
      for (const p of toCheck) if (!safe(p)) throw new Fail('unsafe', p);
      if (isCreate) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of sec.hunks) {
          for (const it of h.body) if (it.kind === 'new') plus.push(it.text);
        }
        // A created file ends with a line break unless a `\` line follows its last `+` line.
        let finalBreak = true;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
          const nn = lastNNoNL(sec.hunks[hi]!.body);
          if (nn !== null) { finalBreak = !nn; break; }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = oldP!;
      const curText = tree.get(op);
      if (curText === null) throw new Fail('missing', op);
      if (isMove && newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
      const parts = splitFile(curText);
      let linesNow = parts.lines.slice();
      let finalBreak = parts.final;
      let d = 0;
      for (const h of sec.hunks) {
        const oldLines: string[] = [];
        for (const it of h.body) if (it.kind === 'ctx' || it.kind === 'old') oldLines.push(it.text);
        if (oldLines.length === 0) {
          const ins = Math.min(h.a + d, linesNow.length);
          const wasAtEnd = ins === linesNow.length;
          const repl = h.body.filter((it) => it.kind === 'new').map((it) => it.text);
          linesNow.splice(ins, 0, ...repl);
          d += repl.length;
          if (wasAtEnd && repl.length > 0) {
            const nn = lastNNoNL(h.body);
            if (nn !== null) finalBreak = !nn;
          }
          continue;
        }
        const found = findTier(linesNow, oldLines, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        for (const pos of found.positions) {
          if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
        }
        const touchesEnd = best + oldLines.length === linesNow.length;
        const repl = replacementFromBody(linesNow, best, found.tier, h.body).replacement;
        linesNow.splice(best, oldLines.length, ...repl);
        d += repl.length - oldLines.length;
        if (touchesEnd) {
          if (repl.length === 0) { if (linesNow.length > 0) finalBreak = true; else finalBreak = false; }
          else {
            const nn = lastNNoNL(h.body);
            if (nn !== null) finalBreak = !nn;
          }
        }
      }
      const outText = joinFile(linesNow, parts.br, finalBreak);
      if (isMove && newP !== null) {
        tree.now.set(op, null);
        tree.now.set(newP, outText);
        tree.moves.push({ old: op, new: newP });
      } else {
        tree.now.set(op, outText);
      }
    };
  });
}

// ---- section 7: SEARCH/REPLACE blocks ----

type SRBlock = { path: string; oldLines: string[]; newLines: string[] };
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const parts = splitFile(cur);
    const found = findTier(parts.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const repl = b.newLines.map((t) => reindentLine(t, b.oldLines, parts.lines, pos, found.tier));
    const out = parts.lines.slice();
    out.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinFile(out, parts.br, parts.final));
  });
}

// ---- section 8: V4A patches ----

type VChunk = { anchor: string | null; body: BodyItem[]; eof: boolean };
type VSection = { kind: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; addLines: string[]; chunks: VChunk[]; lineNo: number };
function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const l = lines[i]!;
    if (!isVSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let prefix: string;
    if (l.startsWith('*** Add File: ')) { kind = 'add'; prefix = '*** Add File: '; }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; prefix = '*** Delete File: '; }
    else { kind = 'update'; prefix = '*** Update File: '; }
    const path = l.slice(prefix.length).trim();
    i += 1;
    if (kind === 'add') {
      const addLines: string[] = [];
      while (i < last && !isVSectionStart(lines[i]!)) {
        const t = lines[i]!;
        if (t === '') { addLines.push(''); i += 1; continue; }
        if (t.startsWith('+')) { addLines.push(t.slice(1)); i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], lineNo: startLine });
    } else if (kind === 'delete') {
      while (i < last && !isVSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) { i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], lineNo: startLine });
    } else {
      let moveTo: string | null = null;
      // Move to is the first line of the section; allow blank lines before it.
      let j = i;
      while (j < last && blank(lines[j]!)) j += 1;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        i = j + 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      while (i < last && !isVSectionStart(lines[i]!)) {
        const t = lines[i]!;
        if (t.startsWith('*** Move to: ')) {
          if (moveTo === null && chunks.length === 0 && curChunk === null) { moveTo = t.slice('*** Move to: '.length).trim(); i += 1; continue; }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (t === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          i += 1; continue;
        }
        if (t.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          curChunk = { anchor: t.slice(2).trim(), body: [], eof: false };
          i += 1; continue;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          if (t === '') curChunk.body.push({ kind: 'ctx', text: '', noNL: false });
          else if (t[0] === ' ') curChunk.body.push({ kind: 'ctx', text: t.slice(1), noNL: false });
          else if (t[0] === '-') curChunk.body.push({ kind: 'old', text: t.slice(1), noNL: false });
          else curChunk.body.push({ kind: 'new', text: t.slice(1), noNL: false });
          i += 1; continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.kind === 'ctx' && lastChunk.body[lastChunk.body.length - 1]!.text === '') lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, lineNo: startLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = splitFile(cur);
    let linesNow = parts.lines.slice();
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const anchor = chunk.anchor;
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < linesNow.length; k += 1) {
            if (normLine(linesNow[k]!, tier) === normLine(anchor, tier)) { foundAt = k; break; }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const { oldLines } = replacementFromBody(linesNow, 0, 0, chunk.body);
      if (oldLines.length === 0) {
        const ins = chunk.eof ? linesNow.length : cursor;
        const repl = chunk.body.filter((it) => it.kind === 'new').map((it) => it.text);
        linesNow.splice(ins, 0, ...repl);
        cursor = ins + repl.length;
        continue;
      }
      let chosen: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        const positions: number[] = [];
        for (let k = cursor; k + oldLines.length <= linesNow.length; k += 1) {
          let ok = true;
          for (let m = 0; m < oldLines.length; m += 1) {
            if (normLine(linesNow[k + m]!, tier) !== normLine(oldLines[m]!, tier)) { ok = false; break; }
          }
          if (ok) positions.push(k);
        }
        const usable = chunk.eof ? positions.filter((p) => p + oldLines.length === linesNow.length) : positions;
        if (usable.length > 0) { chosen = { tier, pos: usable[0]! }; break; }
      }
      if (chosen === null) throw new Fail('no-match', sec.path);
      const repl = replacementFromBody(linesNow, chosen.pos, chosen.tier, chunk.body).replacement;
      linesNow.splice(chosen.pos, oldLines.length, ...repl);
      cursor = chosen.pos + repl.length;
    }
    const outText = joinFile(linesNow, parts.br, parts.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, outText);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, outText);
    }
  });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.new);
    const nowOld = tree.now.get(mv.old);
    const nowNew = tree.now.get(mv.new);
    if (wasOld === null || wasNew !== null || nowOld !== null || nowNew === null) continue;
    const di = entries.findIndex((e) => e.text === `D ${mv.old}`);
    const ai = entries.findIndex((e) => e.text === `A ${mv.new}`);
    if (di < 0 || ai < 0) continue;
    entries.splice(Math.max(di, ai), 1);
    entries.splice(Math.min(di, ai), 1);
    entries.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const now = tree.now.get(p)!;
    const was = tree.original(p);
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
