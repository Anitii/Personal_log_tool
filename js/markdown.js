// Markdown <-> editor blocks, inline formatting and diary export. No DOM, so it runs under Node.
import { WEEKDAYS, fmtMinute, toDay, weekdayIdx } from './core.js';

export const makeBlockNode = (type = 'p', text = '', extra = {}) => ({ type, text, indent: 0, ...extra });

const LIST_TYPES = new Set(['ul', 'ol', 'todo', 'quote']);
export const isListType = (type) => type === 'ul' || type === 'ol' || type === 'todo';

function parseLine(line) {
  const leading = line.match(/^ */)[0].length;
  const indent = Math.min(4, Math.floor(leading / 2));
  const rest = line.slice(leading);
  let m;
  if ((m = rest.match(/^(#{1,3}) (.*)$/))) return makeBlockNode(`h${m[1].length}`, m[2]);
  if ((m = rest.match(/^[-*+] \[( |x|X)\] (.*)$/))) return makeBlockNode('todo', m[2], { indent, checked: m[1] !== ' ' });
  if ((m = rest.match(/^[-*+] (.*)$/))) return makeBlockNode('ul', m[1], { indent });
  if ((m = rest.match(/^\d+[.)] (.*)$/))) return makeBlockNode('ol', m[1], { indent });
  if ((m = rest.match(/^> ?(.*)$/))) return makeBlockNode('quote', m[1]);
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(rest)) return makeBlockNode('divider');
  return makeBlockNode('p', line);
}

// Blocks are separated by one blank line (one newline inside a list), so a run of k blank
// lines between blocks holds floor((k - 1) / 2) empty paragraphs.
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1 && lines[0] === '') return [makeBlockNode()];
  const blocks = [];
  let blank = 0;
  const flushBlank = (atEdge) => {
    const empties = atEdge ? Math.floor(blank / 2) : Math.floor((blank - 1) / 2);
    for (let i = 0; i < empties; i++) blocks.push(makeBlockNode());
    blank = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      blank++;
      continue;
    }
    flushBlank(blocks.length === 0);
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      blocks.push(makeBlockNode('code', code.join('\n'), { lang: fence[1].trim() }));
      continue;
    }
    blocks.push(parseLine(line));
  }
  flushBlank(true);
  return blocks.length ? blocks : [makeBlockNode()];
}

function serializeBlock(b, number) {
  const pad = '  '.repeat(b.indent || 0);
  switch (b.type) {
    case 'h1': return `# ${b.text}`;
    case 'h2': return `## ${b.text}`;
    case 'h3': return `### ${b.text}`;
    case 'ul': return `${pad}- ${b.text}`;
    case 'ol': return `${pad}${number}. ${b.text}`;
    case 'todo': return `${pad}- [${b.checked ? 'x' : ' '}] ${b.text}`;
    case 'quote': return `> ${b.text}`;
    case 'divider': return '---';
    case 'code': return `\`\`\`${b.lang || ''}\n${b.text}\n\`\`\``;
    default: return b.text;
  }
}

export function olNumbers(blocks) {
  const numbers = [];
  const counters = [];
  blocks.forEach((b, i) => {
    if (b.type !== 'ol') {
      if (!isListType(b.type)) counters.length = 0;
      numbers[i] = 0;
      return;
    }
    const level = b.indent || 0;
    counters.length = level + 1;
    counters[level] = (counters[level] || 0) + 1;
    numbers[i] = counters[level];
  });
  return numbers;
}

export function serializeMarkdown(blocks) {
  const numbers = olNumbers(blocks);
  let out = '';
  blocks.forEach((b, i) => {
    if (i > 0) {
      const tight = LIST_TYPES.has(b.type) && LIST_TYPES.has(blocks[i - 1].type)
        && (b.type === 'quote') === (blocks[i - 1].type === 'quote');
      out += tight ? '\n' : '\n\n';
    }
    out += serializeBlock(b, numbers[i]);
  });
  return out;
}

/* ---------- Inline formatting ---------- */

const INLINE = /\*\*(.+?)\*\*|~~(.+?)~~|`(.+?)`|\*(.+?)\*|\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g;

// rawStart maps a rendered character back to its place in the source, for clicking into text.
export function inlineSegments(text) {
  const segs = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m; (m = INLINE.exec(text));) {
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index), rawStart: last });
    if (m[1] !== undefined) segs.push({ type: 'bold', text: m[1], rawStart: m.index + 2 });
    else if (m[2] !== undefined) segs.push({ type: 'strike', text: m[2], rawStart: m.index + 2 });
    else if (m[3] !== undefined) segs.push({ type: 'code', text: m[3], rawStart: m.index + 1 });
    else if (m[4] !== undefined) segs.push({ type: 'italic', text: m[4], rawStart: m.index + 1 });
    else segs.push({ type: 'link', text: m[5], rawStart: m.index + 1, href: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last), rawStart: last });
  return segs;
}

export function plainPreview(body, max = 60) {
  for (const b of parseMarkdown(body)) {
    if (b.type === 'divider' || b.type === 'code' || !b.text.trim()) continue;
    return inlineSegments(b.text).map((s) => s.text).join('').slice(0, max);
  }
  return '';
}

// Shortcut typed at the start of a block, e.g. "# " or "- [] ".
export function detectShortcut(text) {
  let m;
  if ((m = text.match(/^(#{1,3})[\s　]/))) return { type: `h${m[1].length}`, rest: text.slice(m[0].length) };
  if ((m = text.match(/^[-*+][\s　]\[( |x|X)?\][\s　]/))) return { type: 'todo', checked: !!m[1] && m[1] !== ' ', rest: text.slice(m[0].length) };
  if ((m = text.match(/^\[( |x|X)?\][\s　]/))) return { type: 'todo', checked: !!m[1] && m[1] !== ' ', rest: text.slice(m[0].length) };
  if ((m = text.match(/^[-*+][\s　]/))) return { type: 'ul', rest: text.slice(m[0].length) };
  if ((m = text.match(/^\d+[.)][\s　]/))) return { type: 'ol', rest: text.slice(m[0].length) };
  if ((m = text.match(/^>[\s　]/))) return { type: 'quote', rest: text.slice(m[0].length) };
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) return { type: 'divider', rest: '' };
  if (/^```$/.test(text)) return { type: 'code', rest: '' };
  return null;
}

/* ---------- Export ---------- */

// Each day becomes a section under the file's title, so a diary's own headings move down two levels.
function demoteHeadings(body) {
  let fenced = false;
  return body.split('\n').map((line) => {
    if (line.startsWith('```')) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/^(#{1,4}) /, (_, hashes) => `${hashes}## `);
  }).join('\n');
}

const dayHeading = (iso) => `${iso} 星期${WEEKDAYS[weekdayIdx(toDay(iso))]}`;

export function diaryDays(entries, from, to) {
  return entries
    .filter((d) => d.date >= from && d.date <= to && d.body.trim())
    .sort((a, b) => a.date.localeCompare(b.date));
}

// blocksFor(date) returns [{ start, end, title, done }] when the time table should be included.
export function diaryToMarkdown(entries, { from, to, skip = new Set(), blocksFor = null } = {}) {
  const days = diaryDays(entries, from, to).filter((d) => !skip.has(d.date));
  const title = from === to ? `# 日記 ${from}` : `# 日記 ${from} – ${to}`;
  const parts = [title];
  for (const d of days) {
    parts.push(`## ${dayHeading(d.date)}`, demoteHeadings(d.body.trim()));
    const blocks = blocksFor?.(d.date) || [];
    if (blocks.length) {
      parts.push('### 時間表', blocks.map((b) =>
        `- [${b.done ? 'x' : ' '}] ${fmtMinute(b.start)}–${fmtMinute(b.end)} ${b.title}`).join('\n'));
    }
  }
  return `${parts.join('\n\n')}\n`;
}
