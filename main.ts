// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers, and writes
// every change or none, printing what it changed or why it failed. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its own break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** A moved file's current path -> the path it had before the patch. */
  readonly movedTo = new Map<string, string>();
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
  move(oldP: string, newP: string, text: string): void {
    const orig = this.movedTo.get(oldP) ?? oldP;
    this.movedTo.delete(oldP);
    this.movedTo.set(newP, orig);
    this.now.set(oldP, null);
    this.now.set(newP, text);
  }
}

type Edit = (tree: Tree) => void;

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

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC.md section 5).                  */
/* ------------------------------------------------------------------ */

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at which O occurs in lines at this tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, and its positions. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line, the rest as written. */
interface NLine {
  text: string;
  ctx: boolean;
  /** For a context line, its index in O. */
  oIdx: number;
}

/** N with context lines taken from the file and tier-2 re-indentation applied to the rest. */
function buildNew(O: string[], N: NLine[], at: number, lines: string[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const f = leadingWs(lines[at] ?? '');
    const p = leadingWs(O[0] ?? '');
    for (const nl of N) {
      if (nl.ctx) {
        out.push(lines[at + nl.oIdx]!);
        continue;
      }
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
    return out;
  }
  for (const nl of N) {
    if (nl.ctx) out.push(lines[at + nl.oIdx]!);
    else out.push(nl.text);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9).                                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6).                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Old start line from the header (1-based). */
  a: number;
  O: string[];
  N: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoBreak: boolean;
  plusCount: number;
}

interface UniSection {
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  /** The section's header already holds its `---` / `+++` pair. */
  hasPair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function patchPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from a `--- ` / `+++ ` path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** A hunk's body, from the line after its header; returns the hunk and the next line to read. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const items: BodyItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1) });
      j++;
    } else if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1) });
      j++;
    } else if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1) });
      j++;
    } else if (c === '\\') {
      items.push({ kind: 'bs', text: l.slice(1) });
      j++;
    } else break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      N.push({ text: it.text, ctx: true, oIdx: O.length - 1 });
    } else if (it.kind === 'old') O.push(it.text);
    else if (it.kind === 'new') N.push({ text: it.text, ctx: false, oIdx: -1 });
  }
  let lastCtxNew = -1;
  let lastNew = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') lastCtxNew = k;
    if (items[k]!.kind === 'new') lastNew = k;
  }
  const noBreak = lastCtxNew >= 0 && items[lastCtxNew + 1]?.kind === 'bs';
  const plusNoBreak = lastNew >= 0 && items[lastNew + 1]?.kind === 'bs';
  const plusCount = N.filter((x) => !x.ctx).length;
  return { hunk: { a, O, N, noBreak, plusNoBreak, plusCount }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): UniSection => ({
    dashOld: null,
    dashNew: null,
    renOld: null,
    renNew: null,
    diffOld: null,
    diffNew: null,
    hasPair: false,
    create: false,
    del: false,
    hunks: [],
  });
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // The first pair before the first hunk is this section's header pair; a later
      // pair is not already part of a section's header, so it starts a new section.
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.dashOld = patchPath(l);
        cur.dashNew = patchPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = fresh();
      cur.dashOld = patchPath(l);
      cur.dashNew = patchPath(lines[i + 1]!);
      cur.hasPair = true;
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const { hunk, next } = parseHunkBody(lines, i + 1, Number(m[1]));
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.dashNew = patchPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => uniSectionEdit(sec, strict));
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  const rawOld = sec.dashOld ?? sec.renOld ?? sec.diffOld;
  const rawNew = sec.dashNew ?? sec.renNew ?? sec.diffNew;
  const oldPath = rawOld === null ? null : rawOld === '/dev/null' ? null : stripAB(rawOld);
  const newPath = rawNew === null ? null : rawNew === '/dev/null' ? null : stripAB(rawNew);
  const isCreate = oldPath === null || sec.create;
  const isDelete = !isCreate && (newPath === null || sec.del);
  return (tree) => {
    if (isCreate) {
      const np = newPath ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plusLines: string[] = [];
      let lastPlusNoBreak = false;
      let foundPlus = false;
      for (const h of sec.hunks) {
        for (const nl of h.N) if (!nl.ctx) plusLines.push(nl.text);
        if (h.plusCount > 0) {
          lastPlusNoBreak = h.plusNoBreak;
          foundPlus = true;
        }
      }
      const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (foundPlus && lastPlusNoBreak ? '' : '\n');
      tree.now.set(np, text);
      return;
    }
    if (isDelete) {
      const op = oldPath ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath ?? '';
    const np = newPath ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let doc = parseDoc(before);
    let d = 0;
    for (const h of sec.hunks) {
      doc = applyUniHunk(doc, h, d, strict, op);
      d += h.N.length - h.O.length;
    }
    const text = writeDoc(doc);
    if (isMove) tree.move(op, np, text);
    else tree.now.set(op, text);
  };
}

function applyUniHunk(doc: FileDoc, h: Hunk, d: number, strict: boolean, path: string): FileDoc {
  if (h.O.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), doc.lines.length);
    const ins = buildNew(h.O, h.N, 0, doc.lines, 0);
    const lines = [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)];
    let fin = doc.final;
    if (at === doc.lines.length) fin = !h.noBreak;
    return { lines, br: doc.br, final: fin };
  }
  const found = findTier(h.O, doc.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const at = best;
  const newLines = buildNew(h.O, h.N, at, doc.lines, found.tier);
  const lines = [...doc.lines.slice(0, at), ...newLines, ...doc.lines.slice(at + h.O.length)];
  let fin = doc.final;
  if (at + h.O.length === doc.lines.length) fin = !h.noBreak;
  return { lines, br: doc.br, final: fin };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7).                          */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const repl = buildNew(oldLines, N, at, doc.lines, found.tier);
    const lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, writeDoc({ lines, br: doc.br, final: doc.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8).                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHead = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isHead(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headNo = i + 1;
    const start = i;
    i++;
    while (i < last && !isHead(lines[i]!)) i++;
    const raw: { text: string; no: number }[] = [];
    for (let k = start + 1; k < i; k++) raw.push({ text: lines[k]!, no: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aSectionEdit(l, raw, headNo, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aSectionEdit(head: string, raw: { text: string; no: number }[], headNo: number, strict: boolean): Edit {
  let kind: 'add' | 'delete' | 'update';
  let prefix: string;
  if (head.startsWith('*** Add File: ')) {
    kind = 'add';
    prefix = '*** Add File: ';
  } else if (head.startsWith('*** Delete File: ')) {
    kind = 'delete';
    prefix = '*** Delete File: ';
  } else {
    kind = 'update';
    prefix = '*** Update File: ';
  }
  const path = head.slice(prefix.length).trim();
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const r of raw) throw new Exit2(`error: parse ${r.no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update: an optional `*** Move to:` first, then chunks.
  let moveTo: string | null = null;
  let at = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    at = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const body: { kind: 'ctx' | 'old' | 'new'; text: string }[] = [];
  const flush = (eof: boolean): void => {
    if (cur === null && body.length === 0) return;
    if (cur === null) cur = { anchor: null, eof: false, O: [], N: [] };
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of body) {
      if (b.kind === 'ctx') {
        O.push(b.text);
        N.push({ text: b.text, ctx: true, oIdx: O.length - 1 });
      } else if (b.kind === 'old') O.push(b.text);
      else N.push({ text: b.text, ctx: false, oIdx: -1 });
    }
    cur.O = O;
    cur.N = N;
    cur.eof = eof;
    chunks.push(cur);
    cur = null;
    body.length = 0;
  };
  for (; at < raw.length; at++) {
    const r = raw[at]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      flush(false);
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, O: [], N: [] };
      continue;
    }
    if (l === '*** End of File') {
      flush(true);
      continue;
    }
    if (l === '') {
      if (cur === null) cur = { anchor: null, eof: false, O: [], N: [] };
      body.push({ kind: 'ctx', text: '' });
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      if (cur === null) cur = { anchor: null, eof: false, O: [], N: [] };
      body.push({ kind: 'ctx', text: l.slice(1) });
    } else if (c === '-') {
      if (cur === null) cur = { anchor: null, eof: false, O: [], N: [] };
      body.push({ kind: 'old', text: l.slice(1) });
    } else if (c === '+') {
      if (cur === null) cur = { anchor: null, eof: false, O: [], N: [] };
      body.push({ kind: 'new', text: l.slice(1) });
    } else throw new Exit2(`error: parse ${r.no}`);
  }
  flush(false);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(doc, ch, cursor, strict, path);
      doc = r.doc;
      cursor = r.cursor;
    }
    const text = writeDoc(doc);
    if (moveTo !== null) tree.move(path, moveTo, text);
    else tree.now.set(path, text);
  };
}

function applyV4aChunk(doc: FileDoc, ch: VChunk, cursor: number, strict: boolean, path: string): { doc: FileDoc; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    const found = findTier([ch.anchor], doc.lines, strict, cur);
    if (found === null) throw new Fail('no-match', path);
    cur = found.pos[0]! + 1;
  }
  if (ch.O.length === 0) {
    const at = ch.eof ? doc.lines.length : Math.min(cur, doc.lines.length);
    const ins = buildNew(ch.O, ch.N, 0, doc.lines, 0);
    const lines = [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)];
    return { doc: { lines, br: doc.br, final: doc.final }, cursor: at + ins.length };
  }
  const found = findTier(ch.O, doc.lines, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  let pos: number | null = null;
  for (const p of found.pos) {
    if (ch.eof && p + ch.O.length !== doc.lines.length) continue;
    pos = p;
    break;
  }
  if (pos === null) throw new Fail('no-match', path);
  const newLines = buildNew(ch.O, ch.N, pos, doc.lines, found.tier);
  const lines = [...doc.lines.slice(0, pos), ...newLines, ...doc.lines.slice(pos + ch.O.length)];
  return { doc: { lines, br: doc.br, final: doc.final }, cursor: pos + newLines.length };
}

/* ------------------------------------------------------------------ */
/* Running the patch (SPEC.md sections 1, 2 and 10).                   */
/* ------------------------------------------------------------------ */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.movedTo);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.movedTo.clear();
      for (const [k, v] of beforeMoves) tree.movedTo.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rPairs = new Map<string, string>();
  for (const [newP, orig] of tree.movedTo) {
    if (tree.original(orig) !== null && tree.get(orig) === null && tree.get(newP) !== null) rPairs.set(newP, orig);
  }
  const rSources = new Set(rPairs.values());
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rSources.has(p)) {
      // The D half of a move: the file is removed, the R line is printed at the new path.
      if (!check) rmSync(p, { force: true });
      continue;
    }
    if (rPairs.has(p)) rows.push(`R ${rPairs.get(p)} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
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
