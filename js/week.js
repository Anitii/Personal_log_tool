// Week planner: a notebook spread. Each day has its to-do list on top and its own timeline
// below. The timeline is the same state.blocks the day table edits, so both always agree, and
// like the day table it never changes a task's own dates.
import {
  DAY_MINUTES, FREE_BLOCK_COLOR, SLOT, WEEKDAYS, assignLanes, blocksOn, fmtDuration, fmtMD, fmtMinute, fromDay, inkOn, isActiveOn,
  isImportant, isSubOverdue, makeBlock, mondayOf, occursOn, percent, plannedMinutes, repeatLabel, subDoneOn, subsForDay, toDay, todayStr,
  weekNumber,
} from './core.js';
import { addTask, blockInfo, commit, focusDate, getTask, liveTasks, state, taskColor } from './store.js';
import { actions, enters, esc, icon } from './ui.js';
import { headerHTML, planSegHTML, shell } from './views.js';
import { openBlock } from './planner.js';
import { gantt } from './gantt.js';
import { gcalBarHTML, gcalDraggable, gcalEnsure, gcalEventsOn, gcalMove } from './gcal.js';

const TAP_MIN = 30;
const DROP_MIN = 60;
const LONG_PRESS_MS = 260;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 3;
const EDGE_ZONE = 40;
const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

const week = { monday: null, scroll: null, renderedFor: null };

let requestRender = () => {};
export const setWeekRender = (fn) => (requestRender = fn);

const currentMonday = () => (week.monday ??= mondayOf(toDay(focusDate.plan || todayStr())));
const hourH = () => (innerWidth < 768 ? 40 : 44);
const nowMinute = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/* ---------- The day's list ---------- */

function dayTasks(iso, today) {
  return liveTasks()
    .filter((t) => t.start && t.end && t.end >= t.start && (isActiveOn(t, iso)
      || (iso === today && percent(t) < 100 && (t.end < today || t.subtasks.some((s) => isSubOverdue(s, today))))))
    .sort((a, b) => Number(percent(a) >= 100) - Number(percent(b) >= 100)
      || Number(isImportant(b, iso)) - Number(isImportant(a, iso)) || a.end.localeCompare(b.end) || a.order - b.order);
}

function itemHTML(t, iso, today) {
  const done = percent(t) >= 100;
  const late = !done && t.end < iso;
  const color = taskColor(t) || FREE_BLOCK_COLOR;
  const subs = done ? [] : subsForDay(t, iso, today, { withDone: true });
  const subRows = subs.map((s) => {
    const daily = !!s.repeat && occursOn(s, iso, t);
    const sDone = daily ? subDoneOn(s, iso) : s.done;
    return `<div class="wk-item sub ${sDone ? 'is-done' : ''}" data-wk-drag data-id="${esc(t.id)}" data-sub="${esc(s.id)}">
      <button type="button" class="check small ${sDone ? 'on' : ''}" data-act="toggle-sub" data-id="${esc(t.id)}" data-sub="${esc(s.id)}" ${daily ? `data-date="${iso}"` : ''} role="checkbox" aria-checked="${sDone}" aria-label="完成：${esc(s.title)}"></button>
      <button type="button" class="wk-item-title" data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}" ${s.repeat ? `title="${esc(repeatLabel(s))}"` : ''}>${s.repeat ? '<span class="repeat-mark">↻</span> ' : ''}${esc(s.title) || '<em>未命名子任務</em>'}${isSubOverdue(s, today) ? ' <span class="text-late">逾期</span>' : ''}</button>
    </div>`;
  }).join('');
  return `<li class="wk-task">
    <div class="wk-item ${done ? 'is-done' : ''}" data-wk-drag data-id="${esc(t.id)}">
      <button type="button" class="check small ${done ? 'on' : ''}" data-act="toggle-task" data-id="${esc(t.id)}" role="checkbox" aria-checked="${done}" aria-label="完成：${esc(t.title)}"></button>
      <button type="button" class="wk-item-title" data-act="open-task" data-id="${esc(t.id)}"><i class="dot" style="background:${esc(color)}"></i>${isImportant(t, iso) ? '<b class="wk-star">★</b>' : ''}${esc(t.title) || '<em>未命名任務</em>'}${late ? ' <span class="text-late">逾期</span>' : ''}</button>
    </div>${subRows}</li>`;
}

/* ---------- Timeline ---------- */

function blockHTML(b, lane, lanes, h, { preview = false } = {}) {
  const info = blockInfo(b);
  const color = info.color || FREE_BLOCK_COLOR;
  const top = (b.start / 60) * h;
  const height = Math.max(((b.end - b.start) / 60) * h, 12);
  const style = `top:${top}px;height:${height - 1}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px);--st:${esc(color)};--ink:${inkOn(color)}`;
  const span = `${fmtMinute(b.start)}–${fmtMinute(b.end)}`;
  const attrs = preview ? 'aria-hidden="true"' : `data-block="${esc(b.id)}" data-act="wk-open" role="button" tabindex="0" aria-label="${esc(info.title)}，${span}"`;
  return `<div class="wk-block ${b.done ? 'is-done' : ''} ${preview ? 'preview' : ''} ${height < 30 ? 'short' : ''}" style="${style}" ${attrs}>
    <b>${esc(info.title)}</b>${height >= 30 ? `<small>${span}</small>` : ''}
    ${preview ? '' : '<i class="wk-h" aria-hidden="true"></i>'}
  </div>`;
}

function eventBlockHTML(e, iso, lane, lanes, h) {
  const top = (e.start / 60) * h;
  const height = Math.max(((e.end - e.start) / 60) * h, 12);
  const drag = gcalDraggable(e);
  const style = `top:${top}px;height:${height - 1}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px);--st:${esc(e.soft)};--ink:${e.ink};--gc:${esc(e.color)}`;
  const span = `${fmtMinute(e.start)}–${fmtMinute(e.end)}`;
  return `<div class="wk-block gev ${drag ? '' : 'locked'} ${height < 30 ? 'short' : ''}" style="${style}" data-gev="${esc(e.key)}" data-date="${esc(iso)}" data-act="gev-open" role="button" tabindex="0" aria-label="Google 日曆：${esc(e.title)}，${span}">
    <b>${esc(e.title) || '（沒有標題）'}</b>${height >= 30 ? `<small>${span}</small>` : ''}
    ${drag ? '<i class="wk-h" aria-hidden="true"></i>' : ''}
  </div>`;
}

// All-day events head the day's list; timed ones live on the timeline.
const allDayHTML = (e, iso) => `<li class="wk-task"><div class="wk-item gev-item" data-act="gev-open" data-gev="${esc(e.key)}" data-date="${esc(iso)}" role="button" tabindex="0">
    <i class="gev-mark" style="background:${esc(e.color)}"></i><span class="wk-item-title">${esc(e.title) || '（沒有標題）'}</span></div></li>`;

export function renderWeek(main) {
  const today = todayStr();
  const monday = currentMonday();
  const h = hourH();
  const days = Array.from({ length: 7 }, (_, i) => fromDay(monday + i));
  const isThisWeek = days.includes(today);
  const now = nowMinute();
  gcalEnsure(days[0], days[6]);

  const prev = main.querySelector('.wk-scroll');
  if (prev && week.renderedFor === monday) week.scroll = { top: prev.scrollTop, left: prev.scrollLeft };
  else if (week.renderedFor !== monday) week.scroll = null;
  week.renderedFor = monday;

  let weekPlanned = 0;
  const heads = [];
  const lists = [];
  const cols = [];
  days.forEach((iso, i) => {
    const blocks = blocksOn(state, iso);
    const planned = plannedMinutes(blocks);
    weekPlanned += planned;
    const [, m, d] = iso.split('-').map(Number);
    heads.push(`<button type="button" class="wk-dayhead ${iso === today ? 'is-today' : ''} ${i >= 5 ? 'weekend' : ''}" data-act="go-day" data-date="${iso}" aria-label="開啟 ${iso} 的時間表">
      <small>${DAY_NAMES[i]}</small><b>${m}.${String(d).padStart(2, '0')}</b><span>${planned ? esc(fmtDuration(planned)) : ''}</span></button>`);
    const events = gcalEventsOn(iso);
    const timed = events.filter((e) => !e.allDay);
    const items = events.filter((e) => e.allDay).map((e) => allDayHTML(e, iso)).join('') + dayTasks(iso, today).map((t) => itemHTML(t, iso, today)).join('');
    lists.push(`<ol class="wk-list ${i >= 5 ? 'weekend' : ''}" data-date="${iso}">${items}
      <li class="wk-add"><input type="text" class="bare" placeholder="＋" enterkeyhint="done" data-enter="wk-add" data-date="${iso}" data-keep="wk-add-${iso}" aria-label="在 ${m}/${d} 新增任務" maxlength="300"></li></ol>`);
    const lanes = assignLanes([...blocks, ...timed.map((e) => ({ id: `g:${e.key}`, start: e.start, end: e.end }))]);
    const blockEls = blocks.map((b) => {
      const pos = lanes.get(b.id);
      return blockHTML(b, pos.lane, pos.lanes, h);
    }).join('') + timed.map((e) => {
      const pos = lanes.get(`g:${e.key}`);
      return eventBlockHTML(e, iso, pos.lane, pos.lanes, h);
    }).join('');
    const nowLine = iso === today ? `<i class="wk-now" style="top:${(now / 60) * h}px"></i>` : '';
    cols.push(`<div class="wk-col ${iso === today ? 'is-today' : ''} ${i >= 5 ? 'weekend' : ''}" data-date="${iso}" data-act="wk-col">${blockEls}${nowLine}<div class="wk-preview"></div></div>`);
  });

  const hours = Array.from({ length: 24 }, (_, hr) => `<div class="wk-hour ${isThisWeek && Math.floor(now / 60) === hr ? 'now' : ''}"><span>${String(hr).padStart(2, '0')}:00</span></div>`).join('');

  const head = `<div class="g-head-wrap">
      ${headerHTML('計畫', `週計畫｜第 ${weekNumber(monday, state.settings)} 週`, '<button type="button" class="text-btn today-btn" data-act="plan-today">本週</button>')}
      <div class="g-controls">
        ${planSegHTML()}
        <div class="tb-nav">
          <button type="button" class="btn-circle" data-act="wk-shift" data-n="-1" aria-label="上一週">${icon.back}</button>
          <b>W${weekNumber(monday, state.settings)}・${fmtMD(days[0])}–${fmtMD(days[6])}</b>
          <button type="button" class="btn-circle" data-act="wk-shift" data-n="1" aria-label="下一週">${icon.chevR}</button>
        </div>
        <span class="dp-stats">本週已排 ${esc(fmtDuration(weekPlanned))}</span>
        ${gcalBarHTML()}
      </div>
    </div>`;

  main.innerHTML = `<div class="wk-view">
    ${head}
    <div class="wk-wrap"><div class="wk-card card">
      <div class="wk-scroll">
        <div class="wk-inner" style="--hh:${h}px">
          <div class="wk-head"><div class="wk-corner">W${weekNumber(monday, state.settings)}</div>${heads.join('')}</div>
          <div class="wk-tasks"><div class="wk-corner wk-corner-label">待辦</div>${lists.join('')}</div>
          <div class="wk-body"><div class="wk-hours">${hours}</div>${cols.join('')}</div>
        </div>
      </div>
    </div></div>
  </div>`;

  const scroller = main.querySelector('.wk-scroll');
  if (week.scroll) {
    scroller.scrollTop = week.scroll.top;
    scroller.scrollLeft = week.scroll.left;
  } else {
    const firstBlock = Math.min(...days.flatMap((iso) => blocksOn(state, iso).map((b) => b.start)), DAY_MINUTES);
    const target = isThisWeek ? now - 60 : firstBlock < DAY_MINUTES ? firstBlock - 30 : 8 * 60;
    scroller.scrollTop = (Math.max(0, target) / 60) * h;
    if (isThisWeek && innerWidth < 768) {
      const col = scroller.querySelector('.wk-col.is-today');
      scroller.scrollLeft = Math.max(0, col.offsetLeft - scroller.querySelector('.wk-hours').offsetWidth);
    }
  }
}

/* ---------- Actions ---------- */

function addBlock(date, start, end, brush) {
  const t = brush?.taskId ? getTask(brush.taskId) : null;
  const sub = t && brush.subId ? t.subtasks.find((s) => s.id === brush.subId) : null;
  const block = makeBlock({
    date, start, end: Math.min(end, DAY_MINUTES),
    ...(t ? { taskId: t.id, subId: sub?.id || '', title: sub?.title || t.title } : { title: '' }),
  });
  commit((s) => s.blocks.push(block));
  return block;
}

Object.assign(actions, {
  'wk-shift': (el) => {
    week.monday = currentMonday() + 7 * Number(el.dataset.n);
    focusDate.plan = null;
    requestRender();
  },
  'wk-open': (el) => openBlock(el.dataset.block),
  'wk-col': (el, e) => {
    if (e.target.closest('.wk-block')) return;
    const at = pointAt(e.clientX, e.clientY);
    if (!at) return;
    const b = addBlock(at.date, at.minute, at.minute + TAP_MIN, null);
    openBlock(b.id, { isNew: true });
  },
});

Object.assign(enters, {
  'wk-add': (el) => {
    const title = el.value.trim();
    if (!title) return;
    el.value = '';
    shell.refocus = el.dataset.keep;
    addTask({ title, start: el.dataset.date, end: el.dataset.date });
  },
});

export function weekToday() {
  week.monday = mondayOf(toDay(todayStr()));
  week.scroll = null;
  week.renderedFor = null;
  requestRender();
}

/* ---------- Gestures: move and resize blocks across days, drag list items in ---------- */

function pointAt(x, y) {
  for (const col of document.querySelectorAll('.wk-col')) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x < r.right) {
      const minute = Math.floor(((y - r.top) / r.height) * DAY_MINUTES / SLOT) * SLOT;
      return { date: col.dataset.date, col, minute: Math.max(0, Math.min(DAY_MINUTES - SLOT, minute)) };
    }
  }
  return null;
}

function overTimeline(x, y) {
  const body = document.querySelector('.wk-body');
  const scroller = document.querySelector('.wk-scroll');
  if (!body || !scroller) return false;
  const s = scroller.getBoundingClientRect();
  const tasks = document.querySelector('.wk-tasks').getBoundingClientRect();
  return x >= s.left && x <= s.right && y > tasks.bottom && y <= s.bottom;
}

function rangeFor(d) {
  const at = pointAt(d.x, d.y);
  if (!at) return null;
  if (d.mode === 'move') {
    const start = Math.max(0, Math.min(at.minute - d.grab, DAY_MINUTES - d.duration));
    return { date: at.date, start, end: start + d.duration };
  }
  if (d.mode === 'resize') return { date: d.date, start: d.start, end: Math.max(d.start + SLOT, at.minute + SLOT) };
  if (d.mode === 'paint') return { date: d.date, start: Math.min(d.anchor, at.minute), end: Math.max(d.anchor, at.minute) + SLOT };
  const start = Math.min(at.minute, DAY_MINUTES - DROP_MIN);
  return { date: at.date, start, end: start + DROP_MIN };
}

let g = null;
let suppressUntil = 0;
export const weekSuppressClick = () => performance.now() < suppressUntil;

function begin() {
  g.active = true;
  gantt.dragging = true;
  document.body.classList.add('is-dragging');
  if (g.pointerType !== 'mouse') navigator.vibrate?.(8);
  if (g.blockId) document.querySelector(`.wk-block[data-block="${CSS.escape(g.blockId)}"]`)?.classList.add('ghost');
  if (g.gev) document.querySelector(`.wk-block[data-gev="${CSS.escape(g.gev.key)}"]`)?.classList.add('ghost');
  g.tip = document.createElement('div');
  g.tip.className = 'drag-tip';
  document.body.append(g.tip);
  g.raf = requestAnimationFrame(tick);
}

function tick() {
  if (!g?.active) return;
  const r = g.scroller.getBoundingClientRect();
  if (g.y > r.bottom - EDGE_ZONE) g.scroller.scrollTop += 8;
  else if (g.mode !== 'place' && g.y < document.querySelector('.wk-tasks').getBoundingClientRect().bottom + EDGE_ZONE) g.scroller.scrollTop -= 8;
  if (g.x > r.right - EDGE_ZONE) g.scroller.scrollLeft += 8;
  else if (g.x < r.left + 60 + EDGE_ZONE) g.scroller.scrollLeft -= 8;

  const over = g.mode !== 'place' || overTimeline(g.x, g.y);
  const range = over ? rangeFor(g) : null;
  const key = range ? `${range.date}|${range.start}|${range.end}` : '';
  if (key !== g.lastKey) {
    g.lastKey = key;
    document.querySelectorAll('.wk-preview').forEach((p) => (p.innerHTML = ''));
    if (range) {
      const host = document.querySelector(`.wk-col[data-date="${range.date}"] .wk-preview`);
      const b = makeBlock({ ...range, taskId: g.brush?.taskId || g.block?.taskId || '', subId: g.brush?.subId || g.block?.subId || '', title: g.block?.title || '', color: g.block?.color || '' });
      if (host) host.innerHTML = blockHTML(b, 0, 1, hourH(), { preview: true });
    }
  }
  const [, m, d] = (range?.date || '').split('-').map(Number);
  g.tip.textContent = range ? `${m}/${d} ${fmtMinute(range.start)}–${fmtMinute(range.end)}` : g.label || '拖到時間軸上';
  g.tip.style.transform = `translate(${Math.min(g.x, innerWidth - 90)}px, ${Math.max(g.y - 52, 8)}px) translateX(-50%)`;
  g.raf = requestAnimationFrame(tick);
}

function finish(apply) {
  const d = g;
  g = null;
  clearTimeout(d.timer);
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  d.tip?.remove();
  document.body.classList.remove('is-dragging');
  gantt.dragging = false;
  suppressUntil = performance.now() + 350;
  const over = d.mode !== 'place' || overTimeline(d.x, d.y);
  const range = apply && over ? rangeFor(d) : null;
  if (!range) {
    requestRender();
    return;
  }
  if (d.gev) {
    gcalMove(d.gev, range.date, range.start, range.end);
    return;
  }
  if (d.blockId) {
    const b = state.blocks.find((x) => x.id === d.blockId);
    if (!b) return;
    commit(() => Object.assign(b, { date: range.date, start: range.start, end: range.end, updatedAt: Date.now() }));
    return;
  }
  if (d.brush) {
    addBlock(range.date, range.start, range.end, d.brush);
    return;
  }
  const b = addBlock(range.date, range.start, range.end, null);
  openBlock(b.id, { isNew: true });
}

export function initWeekGestures() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || g || !e.target.closest?.('.wk-view')) return;
    const blockEl = e.target.closest('.wk-block[data-block]');
    const gevEl = e.target.closest('.wk-block[data-gev]');
    const item = e.target.closest('[data-wk-drag]');
    const col = e.target.closest('.wk-col');
    if (e.target.closest('.check, input')) return;
    if (!blockEl && !item && !col) return;
    const ev = gevEl ? gcalEventsOn(gevEl.dataset.date).find((x) => x.key === gevEl.dataset.gev) : null;
    if (gevEl && !gcalDraggable(ev)) {
      // Read-only events only open on tap. A drag off one must not land as a tap on the column.
      const sx = e.clientX;
      const sy = e.clientY;
      document.addEventListener('pointerup', (u) => {
        if (Math.hypot(u.clientX - sx, u.clientY - sy) > MOUSE_SLOP) suppressUntil = performance.now() + 350;
      }, { once: true });
      return;
    }
    const scroller = document.querySelector('.wk-scroll');
    const base = {
      scroller, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      pointerId: e.pointerId, pointerType: e.pointerType, active: false, timer: 0, lastKey: null,
    };
    if (ev) {
      const at = pointAt(e.clientX, e.clientY);
      g = {
        ...base, mode: e.target.closest('.wk-h') ? 'resize' : 'move', gev: ev, block: { title: ev.title, color: ev.soft },
        date: gevEl.dataset.date, start: ev.start, duration: ev.end - ev.start, grab: (at?.minute ?? ev.start) - ev.start,
      };
    } else if (blockEl) {
      const block = state.blocks.find((b) => b.id === blockEl.dataset.block);
      if (!block) return;
      const at = pointAt(e.clientX, e.clientY);
      g = {
        ...base, mode: e.target.closest('.wk-h') ? 'resize' : 'move', blockId: block.id, block, date: block.date,
        start: block.start, duration: block.end - block.start, grab: (at?.minute ?? block.start) - block.start,
      };
    } else if (item) {
      const t = getTask(item.dataset.id);
      const sub = t?.subtasks.find((s) => s.id === item.dataset.sub);
      g = { ...base, mode: 'place', brush: { taskId: item.dataset.id, subId: item.dataset.sub || '' }, label: sub?.title || t?.title || '' };
    } else {
      const at = pointAt(e.clientX, e.clientY);
      if (!at) return;
      g = { ...base, mode: 'paint', date: at.date, anchor: at.minute };
    }
    if (e.pointerType !== 'mouse') g.timer = setTimeout(() => g && !g.active && begin(), LONG_PRESS_MS);
  });
  document.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.pointerId) return;
    g.x = e.clientX;
    g.y = e.clientY;
    if (g.active) return;
    const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    if (g.pointerType === 'mouse') {
      if (moved > MOUSE_SLOP) begin();
    } else if (moved > TOUCH_SLOP) finish(false);
  });
  document.addEventListener('pointerup', (e) => {
    if (g && e.pointerId === g.pointerId) finish(true);
  });
  document.addEventListener('pointercancel', (e) => {
    if (g && e.pointerId === g.pointerId) finish(false);
  });
  document.addEventListener('touchmove', (e) => {
    if (g?.active) e.preventDefault();
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('.wk-col, [data-wk-drag]')) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && g?.active) finish(false);
  });
}
