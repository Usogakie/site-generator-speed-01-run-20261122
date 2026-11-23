// A fast drop-in for makefun-site 1.0.0.
//
// run(input) builds one generated site into its output tree: a JSON object
// of every path the generator writes and that file's text, byte for byte the
// same as makefun-site 1.0.0's build. The pipeline is the same shape as the
// reference (sources, front matter, permalinks, Markdown, collections,
// tags, layouts, report), but every stage is written for speed: no regular
// expression runs over body text, no per-character escaping calls, output
// accumulated in arrays and joined once, and slugs cached.

const MONTH_WORDS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Code-unit order, never the locale's. */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const ESC_TABLE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `s` with &, <, >, " and ' escaped, and nothing else. */
function escHtml(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_ALL, (c) => ESC_TABLE[c]);
}

const MARK_RE = /\p{M}/gu;

/** Slugs, cached: the same title or tag name is slugified once per build. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run
 * of characters other than a-z and 0-9 one "-", none at either end, cut to
 * 64 characters with a "-" left at the cut dropped, "untitled" when nothing
 * is left. Pure-ASCII input skips the normalisation step entirely.
 */
function toSlug(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    let keep = '';
    if (cp >= 65 && cp <= 90) keep = String.fromCharCode(cp + 32);
    else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) keep = ch;
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `base` made unique against `taken` (and added to it): base, base-2, ... */
function freshSlug(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  let cand = `${base}-${n}`;
  while (taken.has(cand)) {
    n++;
    cand = `${base}-${n}`;
  }
  taken.add(cand);
  return cand;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(ds) {
  return `${Number(ds.slice(8, 10))} ${MONTH_WORDS[Number(ds.slice(5, 7)) - 1]} ${ds.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    if (isWsCode(s.charCodeAt(i))) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Whether a code point is whitespace, in JavaScript's \s sense. */
function isWsCode(cp) {
  return cp === 32 || cp === 9 || cp === 10 || cp === 11 || cp === 12 || cp === 13 || cp === 160 ||
    cp === 5760 || (cp >= 8192 && cp <= 8202) || cp === 8232 || cp === 8233 ||
    cp === 8239 || cp === 8287 || cp === 12288 || cp === 65279;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Whether a line holds only spaces and tabs. */
function lineBlank(line) {
  if (line === '') return true;
  if (line.charCodeAt(0) !== 32 && line.charCodeAt(0) !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with its trailing spaces and tabs dropped. */
function stripTrail(line) {
  let e = line.length;
  while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(0, e);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `raw` is a real day from 1970-01-01 to 2099-12-31, YYYY-MM-DD. */
function isRealDate(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function readFmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = readFmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    if (!isRealDate(raw)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = [];
    for (const part of inner.split(',')) {
      const t = part.trim();
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags.push(t);
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!/^[a-z0-9-]+$/.test(raw)) return { error: 'key "layout": not a template name' };
    return { value: raw };
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) || raw.length > 64) {
    return { error: 'key "slug": not a slug' };
  }
  return { value: raw };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFm(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (lineBlank(line) || line[0] === '#') continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line[k] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (line[k + 1] === ' ') raw = stripTrail(line.slice(k + 2));
    else if (k + 1 === line.length) raw = '';
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

/** A line with spaces and tabs dropped at both ends. */
function trimEnds(line) {
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(line.length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

const LANG_OK = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/**
 * A fence line's language, or null when the line is no fence at all.
 * A line of three backticks and nothing after it has language "".
 */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length && LANG_OK(line.charCodeAt(i))) i++;
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

/** Whether a line is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const dash = line[0] === '-' && line[1] === '-' && line[2] === '-';
  const star = line[0] === '*' && line[1] === '*' && line[2] === '*';
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A list item's start: { ordered, num, rest }, or null. A bullet is "- " or
 * "* "; an ordered item is one to nine digits and ". ".
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, num: 1, rest: line.slice(2) };
  }
  let i = 0;
  while (i < 9 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
    return { ordered: true, num: Number(line.slice(0, i)), rest: line.slice(i + 2) };
  }
  return null;
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWsCode(line.charCodeAt(k));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9 && c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42) return false;
  return lineBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  return line.charCodeAt(0) === 96 && fenceLang(line) === '';
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * `s` rendered inline into `out`; `link` turns a link target into its href.
 * A regular expression finds the next character that starts a construct, so
 * the loop only ever stops at one; the plain text between is flushed through
 * the escaper in whole slices.
 */
function inlineInto(s, link, out) {
  const n = s.length;
  const re = /[\\`*[]/g;
  let run = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      if (run < j) out.push(escHtml(s.slice(run, j)));
      out.push(escHtml(s[j + 1]));
      re.lastIndex = j + 2;
      run = j + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (run < j) out.push(escHtml(s.slice(run, j)));
        out.push('<code>', escHtml(s.slice(j + 1, k)), '</code>');
        re.lastIndex = k + 1;
        run = k + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (run < j) out.push(escHtml(s.slice(run, j)));
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          re.lastIndex = k + 2;
          run = k + 2;
        } else {
          re.lastIndex = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (run < j) out.push(escHtml(s.slice(run, j)));
        out.push('<em>');
        inlineInto(s.slice(j + 1, k), link, out);
        out.push('</em>');
        re.lastIndex = k + 1;
        run = k + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (run < j) out.push(escHtml(s.slice(run, j)));
        out.push('<a href="', escHtml(link(target)), '">');
        inlineInto(s.slice(j + 1, k), link, out);
        out.push('</a>');
        re.lastIndex = mm + 1;
        run = mm + 1;
      }
      continue;
    }
  }
  if (run < n) out.push(escHtml(s.slice(run, n)));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMd(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;

  /** A list block starting at line `i`, whose first item is `ls`. */
  const readList = (ls) => {
    const ordered = ls.ordered;
    const items = [];
    while (i < n) {
      const cur = listStart(lines[i]);
      if (cur !== null && cur.ordered === ordered) {
        items.push(trimEnds(cur.rest));
        i++;
      } else if (isContinued(lines[i])) {
        items[items.length - 1] += '\n' + trimEnds(lines[i]);
        i++;
      } else {
        break;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    if (ordered && ls.num !== 1) out.push(`<ol start="${ls.num}">\n`);
    else out.push(`<${tag}>\n`);
    for (const item of items) {
      out.push('<li>');
      inlineInto(item, link, out);
      out.push('</li>\n');
    }
    out.push(`</${tag}>\n`);
  };

  /** A paragraph block starting at line `i`. */
  const readPara = () => {
    const plines = [trimEnds(lines[i])];
    i++;
    while (i < n && !endsPara(lines[i])) plines.push(trimEnds(lines[i++]));
    const mark = out.length;
    out.push('<p>');
    inlineInto(plines.join('\n'), link, out);
    out.push('</p>\n');
    if (excerpt === null) excerpt = out.slice(mark + 1, out.length - 1).join('');
  };

  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code');
        if (lang !== '') out.push(' class="language-', escHtml(lang), '"');
        out.push('>');
        for (const bl of body) out.push(escHtml(bl), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = freshSlug(toSlug(hd.text), ids);
        const inner = [];
        inlineInto(hd.text, link, inner);
        const html = inner.join('');
        out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const ls = listStart(line);
      if (ls !== null) {
        readList(ls);
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        parts.push(trimEnds(l.slice(l.charCodeAt(1) === 32 ? 2 : 1)));
      }
      const kept = parts.filter((p) => p !== '');
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        out.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ls = listStart(line);
      if (ls !== null) {
        readList(ls);
        continue;
      }
    } else if (c0 === 32 || c0 === 9) {
      if (lineBlank(line)) {
        i++;
        continue;
      }
    }
    readPara();
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- Templates

/** A template that does not parse: its message names it and why. */
class TplErr extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TplErr. */
function splitPath(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TplErr(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** Whether `src` holds only spaces or tabs from `a` to `b`. */
function onlySpaces(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * `src`'s tokens: ['t', text], ['v' | 'r', path] and ['g', tag]. A {% %} tag
 * alone on its line takes the whole line with it, its newline included.
 */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TplErr(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') {
        tokens.push(['t', text]);
        text = '';
      }
      tokens.push([raw ? 'r' : 'v', splitPath(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplErr(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push(['t', text]);
      text = '';
    }
    tokens.push(['g', src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push(['t', text]);
  return tokens;
}

/**
 * `src` parsed into its tree of nodes. A node is an array whose first item
 * is its kind: 't' text, 'v' escaped value, 'r' raw value, 'for', 'if' and
 * 'inc' (an include). A TplErr names the template and why it does not parse.
 */
function parseTpl(name, src) {
  const root = [];
  const stack = [null];
  let body = root;
  for (const tok of tokenizeTpl(name, src)) {
    const kind = tok[0];
    if (kind === 't' || kind === 'v' || kind === 'r') {
      body.push(tok);
      continue;
    }
    const tag = tok[1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = ['for', m[1], splitPath(name, m[2]), []];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = ['if', m[1] !== undefined, splitPath(name, m[2]), [], null];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top === null || top[0] !== 'if' || top[4] !== null) {
        throw new TplErr(`template "${name}": an else outside an if`);
      }
      top[4] = [];
      body = top[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top === null || top[0] !== want) {
        throw new TplErr(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent === null ? root : parent[0] === 'for' ? parent[3] : parent[4] !== null ? parent[4] : parent[3];
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push(['inc', m[1]]);
    } else {
      throw new TplErr(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TplErr(`template "${name}": a ${stack[stack.length - 1][0]} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope chain, or undefined. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in its own digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the
 * parsed templates, and `depth` is how deep the includes have nested.
 */
function renderTpl(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    const k = n[0];
    if (k === 't') {
      out.push(n[1]);
    } else if (k === 'v') {
      out.push(escHtml(textOf(lookup(scope, n[1]))));
    } else if (k === 'r') {
      out.push(textOf(lookup(scope, n[1])));
    } else if (k === 'if') {
      const branch = isTruthy(lookup(scope, n[2])) !== n[1] ? n[3] : n[4];
      if (branch !== null) renderTpl(branch, scope, ctx, depth, out);
    } else if (k === 'for') {
      const xs = lookup(scope, n[2]);
      if (Array.isArray(xs)) {
        for (let j = 0; j < xs.length; j++) {
          const vars = {};
          vars[n[1]] = xs[j];
          vars.loop = { index: j + 1, first: j === 0, last: j === xs.length - 1, length: xs.length };
          renderTpl(n[3], { vars, parent: scope }, ctx, depth, out);
        }
      }
    } else if (k === 'inc') {
      const t = ctx.templates.get(n[1]);
      if (t !== undefined && depth < 8) renderTpl(t, scope, ctx, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------------- build

/** The directory of a path, or "" at the root. */
function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmpStr)) {
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplErr) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const ctx = { templates };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => cmpStr(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    } else {
      statics.push(f);
    }
  }

  // 2. Each source's front matter, in order; a refused source or a draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      takenByDir.set(dir, taken);
    }
    const slug = freshSlug(s.data.slug !== undefined ? s.data.slug : toSlug(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMd(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((a, b) => cmpStr(b.data.date, a.data.date) || cmpStr(a.slug, b.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const tagBySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const names = [];
    for (const name of s.data.tags ?? []) {
      const sl = toSlug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        names.push(name);
      }
    }
    return names;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const sl = toSlug(name);
      let t = tagBySlug.get(sl);
      if (t === undefined) {
        t = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        tagBySlug.set(sl, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const t = tagBySlug.get(toSlug(name));
      return t !== undefined ? t : { name, slug: toSlug(name), url: '', posts: [] };
    });
  }
  const tags = [...tagBySlug.values()].sort((a, b) => b.posts.length - a.posts.length || cmpStr(a.slug, b.slug));

  // A page's card, as lists show it; one card per source, shared by its page and its listings.
  const cards = new Map();
  const getCard = (s) => {
    let card = cards.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date !== undefined ? s.data.date : '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary !== undefined ? s.data.summary : '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, card);
    }
    return card;
  };
  const linkRec = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date !== undefined ? s.data.date : '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const makePage = (s) => ({
    ...getCard(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkRec(s.newer ?? null),
    older: linkRec(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => getCard(p));
  const output = {};
  const renderPage = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderTpl(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = renderPage(s.layout, { page: makePage(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = renderPage('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => getCard(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = renderPage('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => getCard(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderPage('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmpStr);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
