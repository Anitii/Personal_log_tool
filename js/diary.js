// Diary: a Notion-style block editor over plain Markdown. Only the block being edited is a
// text field; the others show rendered text. Keeping input in real text fields makes
// Zhuyin and Pinyin composition behave exactly as it does anywhere else.
import {
  WEEKDAYS, addDays, addMonths, blocksOn, fmtMinute, fromDay, isActiveOn, monthWeeks, percent, toDay, todayStr, weekdayIdx,
} from './core.js';
import {
  detectShortcut, diaryDays, diaryToMarkdown, inlineSegments, isListType, makeBlockNode, olNumbers, parseMarkdown, plainPreview,
  serializeMarkdown,
} from './markdown.js';
import { blockInfo, diaryBody, focusDate, saveDiary, state } from './store.js';
import { actions, changes, download, esc, icon, toast } from './ui.js';
import { openPanel } from './sheet.js';

const SLASH_ITEMS = [
  { k: 'p', label: '文字', hint: '一般段落', kw: 'text p wenzi' },
  { k: 'h1', label: '大標題', hint: '#', kw: 'h1 heading' },
  { k: 'h2', label: '中標題', hint: '##', kw: 'h2 heading' },
  { k: 'h3', label: '小標題', hint: '###', kw: 'h3 heading' },
  { k: 'ul', label: '項目清單', hint: '-', kw: 'ul list bullet' },
  { k: 'ol', label: '編號清單', hint: '1.', kw: 'ol list number' },
  { k: 'todo', label: '待辦', hint: '[]', kw: 'todo check' },
  { k: 'quote', label: '引言', hint: '>', kw: 'quote' },
  { k: 'code', label: '程式碼', hint: '```', kw: 'code' },
  { k: 'divider', label: '分隔線', hint: '---', kw: 'divider hr line' },
  { k: 'schedule', label: '插入這天的時間表', hint: '', kw: 'schedule time' },
  { k: 'tasks', label: '插入這天的任務', hint: '', kw: 'tasks' },
];

const TOOLS = [
  ['h1', 'H1', '大標題'], ['h2', 'H2', '中標題'], ['h3', 'H3', '小標題'],
  ['bold', 'B', '粗體'], ['italic', 'I', '斜體'], ['strike', 'S', '刪除線'], ['code-inline', '&lt;/&gt;', '行內程式碼'], ['link', icon.link, '連結'],
  ['ul', '•', '項目清單'], ['ol', '1.', '編號清單'], ['todo', icon.list, '待辦'], ['quote', '”', '引言'], ['divider', '—', '分隔線'],
];

const ed = {
  date: null, body: '', blocks: [], active: -1, last: null, raw: false, slash: null,
};
let viewMonth = null;
let sideTimer = 0;

export const diaryDate = () => (focusDate.diary ||= todayStr());

/* ---------- Page ---------- */

function sideHTML() {
  const date = diaryDate();
  const ym = viewMonth || date.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const today = todayStr();
  const written = new Set(state.diary.filter((d) => d.body.trim()).map((d) => d.date));
  const cells = monthWeeks(ym).flatMap((monday) => Array.from({ length: 7 }, (_, i) => {
    const iso = fromDay(monday + i);
    return `<button type="button" class="mini-day ${iso.slice(0, 7) !== ym ? 'out' : ''} ${iso === date ? 'on' : ''} ${iso === today ? 'is-today' : ''} ${written.has(iso) ? 'has' : ''}" data-act="diary-open" data-date="${iso}" aria-label="${iso}">${Number(iso.slice(8))}</button>`;
  })).join('');
  const recent = state.diary
    .filter((d) => d.body.trim())
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30)
    .map((d) => {
      const [, dm, dd] = d.date.split('-').map(Number);
      return `<button type="button" class="diary-item ${d.date === date ? 'on' : ''}" data-act="diary-open" data-date="${d.date}">
        <b>${dm}/${dd} 星期${WEEKDAYS[weekdayIdx(toDay(d.date))]}</b><span>${esc(plainPreview(d.body)) || '&nbsp;'}</span></button>`;
    }).join('');
  return `<div class="card pad mini-cal">
      <div class="mini-head">
        <button type="button" class="icon-btn" data-act="diary-month" data-n="-1" aria-label="上個月">${icon.back}</button>
        <b>${y} 年 ${m} 月</b>
        <button type="button" class="icon-btn" data-act="diary-month" data-n="1" aria-label="下個月">${icon.chevR}</button>
      </div>
      <div class="mini-grid">${WEEKDAYS.map((d) => `<small>${d}</small>`).join('')}${cells}</div>
    </div>
    ${recent ? `<div class="card diary-list">${recent}</div>` : ''}`;
}

function refreshSide() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(() => {
    const host = document.getElementById('diary-side');
    if (host) host.innerHTML = sideHTML();
  }, 350);
}

export function renderDiary(main) {
  const date = diaryDate();
  const body = diaryBody(date);
  const mounted = main.querySelector('#md-root, #md-raw');
  const editing = ed.active >= 0 || document.activeElement?.id === 'md-raw';
  // Saving a keystroke also triggers a page render; the editor must survive that untouched.
  if (mounted && ed.date === date && (editing || ed.body === body)) {
    refreshSide();
    return;
  }

  ed.date = date;
  ed.body = body;
  ed.blocks = parseMarkdown(body);
  ed.active = -1;
  ed.last = null;
  ed.slash = null;

  const day = toDay(date);
  const [y, m, d] = date.split('-').map(Number);
  const tools = TOOLS.map(([k, label, name]) =>
    `<button type="button" data-md="${k}" class="md-tool tool-${k}" aria-label="${name}" title="${name}">${label}</button>`).join('');
  const modeSeg = `<div class="seg" role="group" aria-label="編輯模式">
    <button type="button" class="${ed.raw ? '' : 'on'}" data-act="diary-mode" data-v="blocks" aria-pressed="${!ed.raw}">編輯</button>
    <button type="button" class="${ed.raw ? 'on' : ''}" data-act="diary-mode" data-v="raw" aria-pressed="${ed.raw}">Markdown</button>
  </div>`;

  main.innerHTML = `<div class="view-body diary-body">
    <header class="large-head">
      <div class="large-title"><h1>日記</h1><p>${y} 年 ${m} 月 ${d} 日 星期${WEEKDAYS[weekdayIdx(day)]}</p></div>
      <div class="head-actions">
        <button type="button" class="text-btn today-btn" data-act="diary-today">今天</button>
        <button type="button" class="btn-circle" data-act="diary-export" aria-label="匯出 Markdown" title="匯出 Markdown">${icon.share}</button>
      </div>
    </header>
    <div class="diary-grid">
      <section class="diary-main">
        <div class="diary-nav">
          <button type="button" class="btn-circle" data-act="diary-shift" data-n="-1" aria-label="前一天">${icon.back}</button>
          <input type="date" class="field-date" value="${esc(date)}" data-ch="diary-date" aria-label="選擇日期">
          <button type="button" class="btn-circle" data-act="diary-shift" data-n="1" aria-label="後一天">${icon.chevR}</button>
          <span class="diary-mode">${modeSeg}</span>
        </div>
        ${ed.raw ? '' : `<div class="md-tools" id="md-tools" role="toolbar" aria-label="格式">${tools}</div>`}
        <div class="card md-card">
          ${ed.raw
            ? `<textarea id="md-raw" class="md-raw" spellcheck="false" placeholder="直接輸入 Markdown" aria-label="日記 Markdown">${esc(body)}</textarea>`
            : '<div id="md-root" class="md" aria-label="日記內容"></div>'}
        </div>
        <p class="group-foot">${ed.raw ? '這裡看到的就是匯出的內容。' : '輸入 / 開啟選單。# 標題、- 清單、[] 待辦、> 引言、--- 分隔線，也支援 **粗體** 和 *斜體*。'}</p>
      </section>
      <aside class="diary-side" id="diary-side">${sideHTML()}</aside>
    </div>
  </div>`;

  if (ed.raw) {
    const raw = main.querySelector('#md-raw');
    raw.addEventListener('input', () => {
      ed.body = raw.value;
      saveDiary(ed.date, raw.value);
    });
  } else {
    const root = main.querySelector('#md-root');
    bindEditor(root, main.querySelector('#md-tools'));
    paint();
  }
}

/* ---------- Editor rendering ---------- */

const root = () => document.getElementById('md-root');
const wrapOf = (i) => root()?.querySelector(`.mdb[data-i="${i}"]`);
const input = () => root()?.querySelector('.mdb-input');

function viewHTML(b) {
  if (!b.text) return '<br>';
  if (b.type === 'code') return `<code data-r="0">${esc(b.text)}</code>`;
  return inlineSegments(b.text).map((seg) => {
    const r = `data-r="${seg.rawStart}"`;
    const text = esc(seg.text);
    switch (seg.type) {
      case 'bold': return `<strong ${r}>${text}</strong>`;
      case 'italic': return `<em class="md-em" ${r}>${text}</em>`;
      case 'strike': return `<s ${r}>${text}</s>`;
      case 'code': return `<code ${r}>${text}</code>`;
      case 'link': return `<a ${r} href="${esc(seg.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      default: return `<span ${r}>${text}</span>`;
    }
  }).join('');
}

function blockHTML(b, i, numbers) {
  if (b.type === 'divider') return `<div class="mdb t-divider" data-i="${i}"><hr></div>`;
  let mark = '';
  if (b.type === 'ul') mark = '<span class="mdb-mark">•</span>';
  else if (b.type === 'ol') mark = `<span class="mdb-mark num">${numbers[i]}.</span>`;
  else if (b.type === 'todo') mark = `<button type="button" class="check small mdb-check ${b.checked ? 'on' : ''}" data-check role="checkbox" aria-checked="${!!b.checked}" aria-label="完成"></button>`;
  const placeholder = ed.blocks.length === 1 && !b.text && b.type === 'p' ? ' is-placeholder' : '';
  return `<div class="mdb t-${b.type} ${b.checked ? 'is-checked' : ''}${placeholder}" data-i="${i}" style="--in:${b.indent || 0}">${mark}<div class="mdb-view">${viewHTML(b)}</div></div>`;
}

function paint() {
  const host = root();
  if (!host) return;
  const last = ed.blocks[ed.blocks.length - 1];
  if (!last || last.type === 'divider' || last.type === 'code') ed.blocks.push(makeBlockNode());
  const numbers = olNumbers(ed.blocks);
  host.innerHTML = ed.blocks.map((b, i) => blockHTML(b, i, numbers)).join('');
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function activate(i, start = null, end = start) {
  const b = ed.blocks[i];
  if (!b || b.type === 'divider') return;
  if (ed.active !== i) {
    if (ed.active >= 0) deactivate();
    const wrap = wrapOf(i);
    const view = wrap?.querySelector('.mdb-view');
    if (!view) return;
    wrap.classList.remove('is-placeholder');
    const ta = document.createElement('textarea');
    ta.className = 'mdb-input';
    ta.rows = 1;
    ta.spellcheck = false;
    ta.value = b.text;
    ta.placeholder = ed.blocks.length === 1 && b.type === 'p' ? '今天發生了什麼？輸入 / 開啟選單' : b.type.startsWith('h') ? '標題' : '';
    ta.setAttribute('aria-label', '編輯內容');
    view.replaceWith(ta);
    ed.active = i;
    autosize(ta);
  }
  const ta = input();
  ta.focus({ preventScroll: false });
  const s = start ?? ta.value.length;
  ta.setSelectionRange(s, end ?? s);
}

function deactivate() {
  const i = ed.active;
  const ta = input();
  if (i < 0 || !ta) {
    ed.active = -1;
    return;
  }
  ed.last = { i, start: ta.selectionStart, end: ta.selectionEnd };
  ed.active = -1;
  closeSlash();
  const b = ed.blocks[i];
  const view = document.createElement('div');
  view.className = 'mdb-view';
  view.innerHTML = viewHTML(b);
  ta.replaceWith(view);
}

function save() {
  const body = serializeMarkdown(ed.blocks);
  if (body === ed.body) return;
  ed.body = body;
  saveDiary(ed.date, body);
}

function repaintAt(i, caret = 0) {
  ed.active = -1;
  paint();
  activate(i, caret);
  save();
}

/* ---------- Commands ---------- */

function setType(i, type, extra = {}) {
  const b = ed.blocks[i];
  b.type = type;
  if (!isListType(type)) b.indent = 0;
  if (type !== 'todo') delete b.checked;
  Object.assign(b, extra);
  if (type === 'divider') {
    b.text = '';
    if (!ed.blocks[i + 1] || ed.blocks[i + 1].type === 'divider') ed.blocks.splice(i + 1, 0, makeBlockNode());
    repaintAt(i + 1, 0);
    return;
  }
  repaintAt(i, b.text.length);
}

const WRAPS = { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], 'code-inline': ['`', '`'] };

function wrapSelection(kind) {
  const ta = input();
  if (!ta) return;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  if (kind === 'link') {
    const label = value.slice(s, e) || '連結文字';
    const text = `[${label}](https://)`;
    ta.setRangeText(text, s, e, 'end');
    const urlStart = s + label.length + 3;
    ta.setSelectionRange(urlStart, urlStart + 8);
  } else {
    const [open, close] = WRAPS[kind];
    if (value.slice(s - open.length, s) === open && value.slice(e, e + close.length) === close) {
      ta.setRangeText(value.slice(s, e), s - open.length, e + close.length, 'select');
    } else {
      ta.setRangeText(`${open}${value.slice(s, e)}${close}`, s, e, 'select');
      ta.setSelectionRange(s + open.length, e + open.length);
    }
  }
  syncFromInput(ta);
}

function ensureActive() {
  if (ed.active >= 0) return true;
  const last = ed.last;
  if (last && ed.blocks[last.i] && ed.blocks[last.i].type !== 'divider') activate(last.i, last.start, last.end);
  else activate(ed.blocks.length - 1);
  return ed.active >= 0;
}

function runTool(kind) {
  if (!ensureActive()) return;
  if (kind in WRAPS || kind === 'link') {
    wrapSelection(kind);
    return;
  }
  const i = ed.active;
  const current = ed.blocks[i].type;
  setType(i, current === kind ? 'p' : kind);
}

function insertLines(i, lines) {
  if (!lines.length) {
    toast('這天沒有可插入的內容');
    return;
  }
  const text = ed.blocks[i].text;
  const nodes = lines;
  if (!text.trim() || /^[/／]/.test(text)) ed.blocks.splice(i, 1, ...nodes);
  else ed.blocks.splice(i + 1, 0, ...nodes);
  repaintAt(Math.min(i + nodes.length, ed.blocks.length - 1), 0);
}

function runSlash(item) {
  const i = ed.slash?.i ?? ed.active;
  closeSlash();
  if (item.k === 'schedule') {
    insertLines(i, blocksOn(state, ed.date).map((b) => makeBlockNode('todo', `${fmtMinute(b.start)}–${fmtMinute(b.end)} ${blockInfo(b).title}`, { checked: b.done })));
    return;
  }
  if (item.k === 'tasks') {
    insertLines(i, state.tasks.filter((t) => isActiveOn(t, ed.date)).map((t) => makeBlockNode('todo', t.title || '未命名任務', { checked: percent(t) >= 100 })));
    return;
  }
  ed.blocks[i].text = '';
  setType(i, item.k);
}

/* ---------- Slash menu ---------- */

function closeSlash() {
  ed.slash = null;
  document.getElementById('md-slash')?.remove();
}

function drawSlash() {
  document.getElementById('md-slash')?.remove();
  const { items, sel, i } = ed.slash;
  if (!items.length) return;
  const wrap = wrapOf(i);
  const menu = document.createElement('div');
  menu.id = 'md-slash';
  menu.className = 'md-slash';
  menu.setAttribute('role', 'listbox');
  menu.innerHTML = items.map((it, n) =>
    `<button type="button" class="${n === sel ? 'on' : ''}" data-slash="${n}" role="option" aria-selected="${n === sel}"><span>${esc(it.label)}</span><small>${esc(it.hint)}</small></button>`).join('');
  menu.style.top = `${wrap.offsetTop + wrap.offsetHeight + 4}px`;
  root().append(menu);
  menu.children[sel]?.scrollIntoView({ block: 'nearest' });
}

function updateSlash(b, i) {
  const m = b.type === 'p' && b.text.match(/^[/／](\S*)$/);
  if (!m) {
    if (ed.slash) closeSlash();
    return;
  }
  const q = m[1].toLowerCase();
  const items = SLASH_ITEMS.filter((it) => !q || it.label.includes(q) || it.kw.includes(q));
  ed.slash = { i, items, sel: 0 };
  drawSlash();
}

/* ---------- Editor events ---------- */

function syncFromInput(ta, e) {
  const i = ed.active;
  const b = ed.blocks[i];
  if (!b) return;
  b.text = b.type === 'code' ? ta.value : ta.value.replace(/\n/g, ' ');
  autosize(ta);
  if (!e?.isComposing) {
    if (b.type === 'p') {
      const hit = detectShortcut(b.text);
      if (hit) {
        b.text = hit.rest;
        setType(i, hit.type, hit.type === 'todo' ? { checked: hit.checked } : {});
        return;
      }
    }
    updateSlash(b, i);
  }
  save();
}

function pasteLines(e, ta) {
  const text = e.clipboardData?.getData('text/plain') || '';
  const b = ed.blocks[ed.active];
  if (!text.includes('\n') || b.type === 'code') return;
  e.preventDefault();
  const i = ed.active;
  const before = ta.value.slice(0, ta.selectionStart);
  const after = ta.value.slice(ta.selectionEnd);
  const parsed = parseMarkdown(text);
  if (before && parsed[0].type === 'p') {
    parsed[0].text = before + parsed[0].text;
  } else if (before) parsed.unshift(makeBlockNode(b.type, before));
  const tail = parsed[parsed.length - 1];
  const caret = tail.text.length;
  tail.text += after;
  ed.blocks.splice(i, 1, ...parsed);
  repaintAt(i + parsed.length - 1, caret);
}

function onKey(e, ta) {
  const composing = e.isComposing || e.keyCode === 229;
  const i = ed.active;
  const b = ed.blocks[i];

  if (ed.slash && !composing) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = ed.slash.items.length;
      ed.slash.sel = (ed.slash.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      drawSlash();
      return;
    }
    if (e.key === 'Enter' && ed.slash.items.length) {
      e.preventDefault();
      runSlash(ed.slash.items[ed.slash.sel]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlash();
      return;
    }
  }
  if (composing) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    const key = e.key.toLowerCase();
    const map = { b: 'bold', i: 'italic', e: 'code-inline', k: 'link' };
    if (map[key]) {
      e.preventDefault();
      wrapSelection(map[key]);
      return;
    }
    if (key === 's' && e.shiftKey) {
      e.preventDefault();
      wrapSelection('strike');
      return;
    }
  }

  const { selectionStart: s, selectionEnd: end } = ta;

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (j < 0 || j >= ed.blocks.length) return;
    [ed.blocks[i], ed.blocks[j]] = [ed.blocks[j], ed.blocks[i]];
    repaintAt(j, s);
    return;
  }

  if (e.key === 'Tab' && isListType(b.type)) {
    e.preventDefault();
    b.indent = Math.max(0, Math.min(4, (b.indent || 0) + (e.shiftKey ? -1 : 1)));
    repaintAt(i, s);
    return;
  }

  if (e.key === 'Enter') {
    if (b.type === 'code' && !mod) return; // a newline inside the code block
    e.preventDefault();
    if (b.type === 'code') {
      ed.blocks.splice(i + 1, 0, makeBlockNode());
      repaintAt(i + 1, 0);
      return;
    }
    if ((isListType(b.type) || b.type === 'quote') && !b.text) {
      if (b.indent) b.indent -= 1;
      else setType(i, 'p');
      if (b.type !== 'p') repaintAt(i, 0);
      return;
    }
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(end);
    b.text = before;
    const keeps = isListType(b.type) || b.type === 'quote';
    const next = makeBlockNode(keeps ? b.type : 'p', after, keeps && b.indent ? { indent: b.indent } : {});
    if (b.type === 'todo') next.checked = false;
    ed.blocks.splice(i + 1, 0, next);
    repaintAt(i + 1, 0);
    return;
  }

  if (e.key === 'Backspace' && s === 0 && end === 0) {
    if (b.indent) {
      e.preventDefault();
      b.indent -= 1;
      repaintAt(i, 0);
      return;
    }
    if (b.type !== 'p') {
      e.preventDefault();
      setType(i, 'p');
      return;
    }
    if (i === 0) return;
    e.preventDefault();
    const prev = ed.blocks[i - 1];
    if (prev.type === 'divider') {
      ed.blocks.splice(i - 1, 1);
      repaintAt(i - 1, 0);
      return;
    }
    const caret = prev.text.length;
    prev.text += b.text;
    ed.blocks.splice(i, 1);
    repaintAt(i - 1, caret);
    return;
  }

  // Leave the block only when the arrow key had nowhere left to go inside it.
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    const before = ta.selectionStart;
    setTimeout(() => {
      if (input() !== ta || ta.selectionStart !== before) return;
      let j = i + dir;
      while (ed.blocks[j]?.type === 'divider') j += dir;
      if (!ed.blocks[j]) return;
      activate(j, dir < 0 ? ed.blocks[j].text.length : 0);
    }, 0);
  }
}

function caretFromPoint(x, y, view, text) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    node = p?.offsetNode;
    offset = p?.offset ?? 0;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    node = r?.startContainer;
    offset = r?.startOffset ?? 0;
  }
  if (!node || !view.contains(node) || node.nodeType !== 3) return text.length;
  const span = node.parentElement.closest('[data-r]');
  return span ? Number(span.dataset.r) + offset : text.length;
}

function bindEditor(host, tools) {
  host.addEventListener('click', (e) => {
    const slashBtn = e.target.closest('[data-slash]');
    if (slashBtn) {
      runSlash(ed.slash.items[Number(slashBtn.dataset.slash)]);
      return;
    }
    if (e.target.closest('a[href]')) return;
    const wrap = e.target.closest('.mdb');
    if (!wrap) {
      if (e.target === host) activate(ed.blocks.length - 1);
      return;
    }
    const i = Number(wrap.dataset.i);
    if (e.target.closest('[data-check]')) {
      ed.blocks[i].checked = !ed.blocks[i].checked;
      ed.active = -1;
      paint();
      save();
      return;
    }
    if (ed.blocks[i].type === 'divider') {
      const next = ed.blocks[i + 1];
      if (next) activate(i + 1, 0);
      return;
    }
    if (e.target.classList.contains('mdb-input')) return;
    const view = wrap.querySelector('.mdb-view');
    const caret = view && view.contains(e.target) ? caretFromPoint(e.clientX, e.clientY, view, ed.blocks[i].text) : ed.blocks[i].text.length;
    activate(i, caret);
  });
  host.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-slash], [data-check]')) e.preventDefault();
  });
  host.addEventListener('input', (e) => {
    if (e.target.classList.contains('mdb-input')) syncFromInput(e.target, e);
  });
  host.addEventListener('compositionend', (e) => {
    if (e.target.classList.contains('mdb-input')) syncFromInput(e.target);
  });
  host.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('mdb-input')) onKey(e, e.target);
  });
  host.addEventListener('paste', (e) => {
    if (e.target.classList.contains('mdb-input')) pasteLines(e, e.target);
  });
  host.addEventListener('focusout', (e) => {
    if (!e.target.classList.contains('mdb-input')) return;
    if (e.relatedTarget && (tools?.contains(e.relatedTarget) || e.relatedTarget.closest?.('#md-slash'))) return;
    if (e.relatedTarget?.classList?.contains('mdb-input')) return;
    deactivate();
  });
  // Tool buttons keep the caret where it is.
  tools?.addEventListener('mousedown', (e) => e.preventDefault());
  tools?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md]');
    if (btn) runTool(btn.dataset.md);
  });
}

/* ---------- Export ---------- */

const exp = { from: null, to: null, skip: new Set(), schedule: false };

function presetRange(kind) {
  const today = todayStr();
  if (kind === 'today') return [today, today];
  if (kind === 'week') {
    const monday = addDays(today, -weekdayIdx(toDay(today)));
    return [monday, addDays(monday, 6)];
  }
  if (kind === 'month') {
    const ym = today.slice(0, 7);
    return [`${ym}-01`, addDays(`${addMonths(ym, 1)}-01`, -1)];
  }
  const dates = state.diary.filter((d) => d.body.trim()).map((d) => d.date).sort();
  return dates.length ? [dates[0], dates[dates.length - 1]] : [today, today];
}

function exportText() {
  return diaryToMarkdown(state.diary, {
    from: exp.from,
    to: exp.to,
    skip: exp.skip,
    blocksFor: exp.schedule
      ? (date) => blocksOn(state, date).map((b) => ({ start: b.start, end: b.end, done: b.done, title: blockInfo(b).title }))
      : null,
  });
}

function exportPanel() {
  const days = diaryDays(state.diary, exp.from, exp.to);
  const chosen = days.filter((d) => !exp.skip.has(d.date)).length;
  const dayRows = days.map((d) => {
    const [, m, dd] = d.date.split('-').map(Number);
    return `<label class="row form-row export-day">
      <input type="checkbox" class="export-check" data-ch="exp-day" data-date="${d.date}" ${exp.skip.has(d.date) ? '' : 'checked'}>
      <span class="export-date">${m}/${dd} ${WEEKDAYS[weekdayIdx(toDay(d.date))]}</span>
      <span class="export-preview">${esc(plainPreview(d.body))}</span>
    </label>`;
  }).join('');
  const presets = [['today', '今天'], ['week', '本週'], ['month', '本月'], ['all', '全部']]
    .map(([k, label]) => `<button type="button" data-act="exp-preset" data-v="${k}">${label}</button>`).join('');
  openPanel('匯出日記', `
    <div class="card pad"><div class="seg wide" role="group" aria-label="快速選擇">${presets}</div></div>
    <div class="card">
      <label class="row form-row"><span class="form-label">從</span><input type="date" class="field-date" value="${esc(exp.from)}" data-ch="exp-from"></label>
      <label class="row form-row"><span class="form-label">到</span><input type="date" class="field-date" value="${esc(exp.to)}" data-ch="exp-to"></label>
      <label class="row form-row"><span class="form-label">一併輸出時間表</span><input type="checkbox" class="switch" data-ch="exp-schedule" ${exp.schedule ? 'checked' : ''}></label>
    </div>
    <h3 class="group-head in-sheet">要匯出的日子 <span class="group-count">${chosen}/${days.length}</span></h3>
    <div class="card">${dayRows || '<p class="tray-empty">這段期間還沒有寫日記。</p>'}</div>
    <div class="export-actions">
      <button type="button" class="btn primary" data-act="exp-download" ${chosen ? '' : 'disabled'}>下載 .md</button>
      <button type="button" class="btn" data-act="exp-copy" ${chosen ? '' : 'disabled'}>複製內容</button>
    </div>`);
}

let requestRender = () => {};
export const setDiaryRender = (fn) => (requestRender = fn);

function openDate(date) {
  focusDate.diary = date;
  viewMonth = date.slice(0, 7);
  requestRender();
}

Object.assign(actions, {
  'diary-open': (el) => openDate(el.dataset.date),
  'diary-shift': (el) => openDate(addDays(diaryDate(), Number(el.dataset.n))),
  'diary-today': () => openDate(todayStr()),
  'diary-month': (el) => {
    viewMonth = addMonths(viewMonth || diaryDate().slice(0, 7), Number(el.dataset.n));
    const host = document.getElementById('diary-side');
    if (host) host.innerHTML = sideHTML();
  },
  'diary-mode': (el) => {
    const raw = el.dataset.v === 'raw';
    if (raw === ed.raw) return;
    ed.raw = raw;
    ed.date = null; // forces a fresh mount
    requestRender();
  },
  'diary-export': () => {
    [exp.from, exp.to] = presetRange('month');
    exp.skip = new Set();
    exportPanel();
  },
  'exp-preset': (el) => {
    [exp.from, exp.to] = presetRange(el.dataset.v);
    exp.skip = new Set();
    exportPanel();
  },
  'exp-download': () => {
    const name = exp.from === exp.to ? `日記_${exp.from}.md` : `日記_${exp.from}_${exp.to}.md`;
    download(name, exportText(), 'text/markdown;charset=utf-8');
  },
  'exp-copy': async () => {
    try {
      await navigator.clipboard.writeText(exportText());
      toast('已複製 Markdown');
    } catch {
      toast('無法複製，請改用下載');
    }
  },
});

Object.assign(changes, {
  'diary-date': (el) => {
    if (el.value) openDate(el.value);
  },
  'exp-from': (el) => {
    if (!el.value) return;
    exp.from = el.value;
    if (exp.to < exp.from) exp.to = exp.from;
    exportPanel();
  },
  'exp-to': (el) => {
    if (!el.value) return;
    exp.to = el.value;
    if (exp.from > exp.to) exp.from = exp.to;
    exportPanel();
  },
  'exp-schedule': (el) => {
    exp.schedule = el.checked;
  },
  'exp-day': (el) => {
    if (el.checked) exp.skip.delete(el.dataset.date);
    else exp.skip.add(el.dataset.date);
    exportPanel();
  },
});
