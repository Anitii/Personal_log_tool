// Gantt view. Geometry is plain date→pixel arithmetic; while dragging, only the affected
// bars are touched inside requestAnimationFrame and state changes once on release.
import {
  STATUS, WEEKDAYS, clampSubsToParent, fitParentToSubs, fmtMD, fmtRange, fromDay, inkOn, mondayOf, percent, shiftTask,
  statusOf, subStatusOf, toDay, todayStr, weekNumber, weekdayIdx,
} from './core.js';
import { commit, getProject, getTask, prefs, setPref, state, touch, visibleTasks } from './store.js';
import { actions, changes, esc, icon } from './ui.js';
import { chipsHTML, emptyHTML, headerHTML, planSegHTML } from './views.js';

// Week scale shows every day; month scale shows whole weeks, grouped by month.
const ZOOM = { week: { w: 44, phone: 38 }, month: { w: 11, phone: 9 } };
const ROW_H = 48;
const SUB_H = 38;
const NARROW = 768;
const DETAIL_MIN = 1200; // below this width the extra columns squeeze out the timeline

export const gantt = {
  anchor: null, // leftmost visible day; survives re-renders, zooms and range changes
  scrollTop: 0,
  extraBefore: 0,
  extraAfter: 0,
  menuOpen: false,
  dragging: false,
  pendingToday: true,
};

let view = null; // geometry of the current render

function layout() {
  const w = innerWidth;
  const phone = w < NARROW;
  const canDetail = w >= DETAIL_MIN;
  const detail = canDetail && !prefs.compact;
  return {
    phone,
    canDetail,
    detail,
    dayW: phone ? ZOOM[prefs.plan].phone : ZOOM[prefs.plan].w,
    labelW: detail ? 500 : phone ? 136 : 228,
  };
}

function range(items, today) {
  let min = today - 21;
  let max = today + 84;
  for (const t of items) {
    if (t.start) min = Math.min(min, toDay(t.start) - 7);
    if (t.end) max = Math.max(max, toDay(t.end) + 14);
  }
  const start = mondayOf(min) - gantt.extraBefore * 7;
  const end = mondayOf(max) + 6 + gantt.extraAfter * 7;
  return { start, end, days: end - start + 1 };
}

function barGeom(startDay, endDay) {
  const left = (startDay - view.start) * view.dayW;
  const width = (endDay - startDay + 1) * view.dayW;
  return { left: left + 2, width: Math.max(width - 4, 4) };
}

function placeBar(el, startDay, endDay) {
  if (el.classList.contains('diamond')) {
    const size = el.offsetWidth || 16;
    el.style.left = `${(startDay - view.start) * view.dayW + view.dayW / 2 - size / 2}px`;
    return;
  }
  const g = barGeom(startDay, endDay);
  el.style.left = `${g.left}px`;
  el.style.width = `${g.width}px`;
}

// A task's own color always wins; otherwise bars follow status, or the project if chosen.
function barColorStyle(t) {
  const c = t.color || (prefs.barColor === 'project' ? getProject(t.projectId)?.color : '');
  return c ? `--st:${esc(c)};--ink:${inkOn(c)};` : '';
}

function barHTML({ taskId, subId, title, start, end, st, pct, isSub, range: rangeLabel, colorStyle = '' }) {
  const s = toDay(start);
  const e = toDay(end);
  const common = `data-bar data-act="open-task" data-id="${esc(taskId)}" ${subId ? `data-sub="${esc(subId)}" data-focus-sub="${esc(subId)}"` : ''} role="button" tabindex="0"
    aria-label="${esc(title)}，${esc(rangeLabel)}，${esc(STATUS[st].label)}"`;
  if (s === e) {
    const size = isSub ? 13 : 17;
    const left = (s - view.start) * view.dayW + view.dayW / 2 - size / 2;
    return `<div class="bar diamond s-${STATUS[st].cls} ${isSub ? 'is-sub' : ''}" style="${colorStyle}left:${left}px;width:${size}px;height:${size}px" ${common}></div>`;
  }
  const g = barGeom(s, e);
  const fits = !isSub && g.width > title.length * 13 + 18;
  return `<div class="bar s-${STATUS[st].cls} ${isSub ? 'is-sub' : ''}" style="${colorStyle}left:${g.left}px;width:${g.width}px" ${common}>
    ${pct > 0 && pct < 100 ? `<i class="bar-fill" style="width:${pct}%"></i>` : ''}
    ${fits ? `<span class="bar-text">${esc(title)}</span>` : ''}
  </div>`;
}

function labelHTML(t, st, pct, l) {
  const hasSubs = t.subtasks.length > 0;
  const collapsed = !!prefs.collapsed[t.id];
  const project = getProject(t.projectId);
  const twisty = hasSubs
    ? `<button type="button" class="twisty ${collapsed ? '' : 'open'}" data-act="gantt-collapse" data-id="${esc(t.id)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展開' : '收合'}子任務">${icon.chevR}</button>`
    : '<span class="twisty-gap"></span>';
  const main = `<button type="button" class="g-title" data-act="open-task" data-id="${esc(t.id)}">
      <span class="g-name">${project ? `<i class="dot" style="background:${esc(project.color)}"></i>` : ''}${esc(t.title) || '<em>未命名任務</em>'}</span>
      ${l.detail ? '' : `<span class="g-meta">${esc(fmtRange(t.start, t.end))}${pct ? ` · ${pct}%` : ''}</span>`}
    </button>`;
  const cols = l.detail
    ? `<span class="g-col c-project">${esc(project?.name || '—')}</span>
       <span class="g-col c-date">${esc(fmtRange(t.start, t.end))}</span>
       <span class="g-col c-num">${pct}%</span>
       <span class="g-col c-status"><span class="pill s-${STATUS[st].cls}">${esc(STATUS[st].label)}</span></span>`
    : '';
  return `<div class="g-label">${twisty}${main}${cols}</div>`;
}

function headerRows(l, today) {
  const { start, days } = view;
  const { dayW } = l;
  let groups = '';
  if (prefs.plan === 'month') {
    let i = 0;
    while (i < days) {
      const iso = fromDay(start + i);
      const [y, m] = iso.split('-').map(Number);
      let n = 0;
      while (i + n < days && fromDay(start + i + n).slice(0, 7) === iso.slice(0, 7)) n++;
      groups += `<div class="g-group" style="width:${n * dayW}px"><span>${y} 年 ${m} 月</span></div>`;
      i += n;
    }
  } else {
    for (let i = 0; i < days; i += 7) {
      const a = start + i;
      groups += `<div class="g-group" style="width:${7 * dayW}px"><span>第 ${weekNumber(a, state.settings)} 週｜${fmtMD(fromDay(a))}–${fmtMD(fromDay(a + 6))}</span></div>`;
    }
  }

  let cells = '';
  if (prefs.plan === 'month') {
    for (let i = 0; i < days; i += 7) {
      const isThisWeek = today >= start + i && today < start + i + 7;
      cells += `<div class="g-day week-cell ${isThisWeek ? 'is-today-week' : ''}" style="width:${7 * dayW}px">${fmtMD(fromDay(start + i))}</div>`;
    }
  } else {
    for (let i = 0; i < days; i++) {
      const n = start + i;
      const wd = weekdayIdx(n);
      const dateNum = Number(fromDay(n).slice(8));
      cells += `<div class="g-day ${wd === 5 ? 'sat' : wd === 6 ? 'sun' : ''} ${n === today ? 'is-today' : ''}" style="width:${dayW}px">
        <small>${WEEKDAYS[wd]}</small><b>${dateNum}</b></div>`;
    }
  }
  return { groups, cells };
}

function weekendStripes(l) {
  if (prefs.plan === 'month') return '';
  let html = '';
  const first = view.start; // always a Monday
  for (let i = 5; i < view.days; i += 7) {
    html += `<i class="g-we sat" style="left:${(first + i - view.start) * l.dayW}px;width:${l.dayW}px"></i>`;
    html += `<i class="g-we sun" style="left:${(first + i + 1 - view.start) * l.dayW}px;width:${l.dayW}px"></i>`;
  }
  return html;
}

export function renderGantt(main) {
  const todayIso = todayStr();
  const today = toDay(todayIso);
  const items = visibleTasks(todayIso);
  const l = layout();
  const r = range(state.tasks, today);
  view = { ...r, dayW: l.dayW, labelW: l.labelW };

  const menu = gantt.menuOpen ? `<div class="menu" role="menu">
      ${l.canDetail ? `<label class="menu-item">精簡模式：只看行動事項<input type="checkbox" class="switch" data-ch="gantt-compact" ${prefs.compact ? 'checked' : ''}></label>` : ''}
      <label class="menu-item">隱藏已完成<input type="checkbox" class="switch" data-ch="hide-done" ${prefs.hideDone ? 'checked' : ''}></label>
      <label class="menu-item">依開始日期排序<input type="checkbox" class="switch" data-ch="gantt-sort" ${prefs.sort === 'start' ? 'checked' : ''}></label>
      <label class="menu-item">色條依專案上色<input type="checkbox" class="switch" data-ch="gantt-bar-color" ${prefs.barColor === 'project' ? 'checked' : ''}></label>
    </div>` : '';

  const trailing = `<button type="button" class="text-btn today-btn" data-act="plan-today">今天</button>
    <div class="menu-wrap"><button type="button" class="btn-circle" data-act="gantt-menu" aria-label="顯示選項" aria-expanded="${gantt.menuOpen}">${icon.more}</button>${menu}</div>`;

  const legend = `<div class="legend" aria-label="圖例">
    ${['todo', 'doing', 'done', 'late'].map((k) => `<span><i class="lg s-${k}"></i>${STATUS[k].label}</span>`).join('')}
    <span><i class="lg-diamond"></i>單日任務</span>
    <span class="legend-hint">${l.phone ? '長按色條可拖曳' : '拖曳色條改日期，拖邊緣改長度'}</span>
  </div>`;

  const week = weekNumber(today, state.settings);
  const headHTML = `<div class="g-head-wrap">
      ${headerHTML('計畫', `本週第 ${week} 週`, trailing)}
      <div class="g-controls">${planSegHTML()}${chipsHTML()}</div>
    </div>`;

  if (!state.tasks.length) {
    main.innerHTML = `<div class="view-body">${headHTML}${emptyHTML()}</div>`;
    return;
  }

  // Preserve position across re-renders by anchoring to a date rather than to pixels.
  const prev = main.querySelector('.g-scroll');
  if (prev && gantt.anchor != null) gantt.scrollTop = prev.scrollTop;

  const tw = r.days * l.dayW;
  const { groups, cells } = headerRows(l, today);
  const rows = [];
  for (const t of items) {
    const st = statusOf(t, todayIso);
    const pct = percent(t);
    const dated = t.start && t.end && t.end >= t.start;
    rows.push(`<div class="g-row is-task" style="height:${ROW_H}px" data-task="${esc(t.id)}">
      ${labelHTML(t, st, pct, l)}
      <div class="g-track" style="width:${tw}px" ${dated ? '' : `data-act="gantt-set-date" data-id="${esc(t.id)}"`}>
        ${dated ? barHTML({ taskId: t.id, title: t.title, start: t.start, end: t.end, st, pct, range: fmtRange(t.start, t.end), colorStyle: barColorStyle(t) }) : `<span class="g-hint" style="left:${(today - r.start) * l.dayW + 6}px">${t.start || t.end ? '日期有誤，點此重設' : '點時間軸設定日期'}</span>`}
      </div>
    </div>`);
    if (t.subtasks.length && !prefs.collapsed[t.id]) {
      for (const s of t.subtasks) {
        const sst = subStatusOf(s, todayIso);
        const sDated = s.start && s.end && s.end >= s.start;
        rows.push(`<div class="g-row is-sub" style="height:${SUB_H}px">
          <div class="g-label sub-label"><button type="button" class="g-title" data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}">
            <span class="g-name ${s.done ? 'struck' : ''}">${esc(s.title) || '<em>未命名子任務</em>'}</span></button></div>
          <div class="g-track" style="width:${tw}px">${sDated ? barHTML({ taskId: t.id, subId: s.id, title: s.title, start: s.start, end: s.end, st: sst, pct: 0, isSub: true, range: fmtRange(s.start, s.end), colorStyle: barColorStyle(t) }) : ''}</div>
        </div>`);
      }
    }
  }

  const detailHead = l.detail
    ? '<span class="g-col c-project">專案</span><span class="g-col c-date">起訖</span><span class="g-col c-num">完成</span><span class="g-col c-status">狀態</span>'
    : '';

  const showToday = today >= r.start && today <= r.end;
  main.innerHTML = `<div class="gantt-view">
    ${headHTML}
    <div class="g-scroll" tabindex="-1">
      <div class="g-canvas" style="--lw:${l.labelW}px;--tw:${tw}px;--dw:${l.dayW}px;width:${l.labelW + tw}px">
        <div class="g-head">
          <div class="g-corner"><span class="g-corner-title">行動事項</span>${detailHead}</div>
          <div class="g-head-time" style="width:${tw}px">
            <div class="g-groups">${groups}</div>
            <div class="g-days ${prefs.plan}">${cells}</div>
          </div>
        </div>
        <div class="g-body">
          <div class="g-bg ${prefs.plan}" aria-hidden="true">${weekendStripes(l)}${showToday ? `<i class="g-now" style="left:${(today - r.start) * l.dayW + l.dayW / 2}px"></i>` : ''}</div>
          ${rows.join('') || '<div class="g-none">這個篩選條件下沒有任務</div>'}
          <div class="g-row g-add" style="height:${ROW_H}px"><div class="g-label"><button type="button" class="g-add-btn" data-act="new-task">${icon.plus}<span>新增任務</span></button></div><div class="g-track" style="width:${tw}px"></div></div>
        </div>
      </div>
    </div>
    ${legend}
  </div>`;

  const scroller = main.querySelector('.g-scroll');
  if (gantt.pendingToday || gantt.anchor == null) {
    gantt.anchor = today - (l.phone ? 1 : 2);
    gantt.pendingToday = false;
  }
  scroller.scrollLeft = (gantt.anchor - r.start) * l.dayW;
  scroller.scrollTop = gantt.scrollTop;
  scroller.addEventListener('scroll', onScroll, { passive: true });
}

let extending = false;
function onScroll(e) {
  const el = e.currentTarget;
  if (gantt.dragging || !view) return;
  gantt.anchor = view.start + el.scrollLeft / view.dayW;
  gantt.scrollTop = el.scrollTop;
  if (extending) return;
  // The time axis never runs out: reaching either end adds eight more weeks.
  const nearLeft = el.scrollLeft < 40;
  const nearRight = el.scrollLeft + el.clientWidth > el.scrollWidth - 40;
  if (nearLeft || nearRight) {
    extending = true;
    if (nearLeft) gantt.extraBefore += 8;
    else gantt.extraAfter += 8;
    requestAnimationFrame(() => {
      requestRender();
      extending = false;
    });
  }
}

let requestRender = () => {};
export const setGanttRender = (fn) => (requestRender = fn);

/* ---------- Actions ---------- */

Object.assign(actions, {
  'gantt-menu': () => {
    gantt.menuOpen = !gantt.menuOpen;
    requestRender();
  },
  'gantt-collapse': (el) => {
    const collapsed = { ...prefs.collapsed };
    if (collapsed[el.dataset.id]) delete collapsed[el.dataset.id];
    else collapsed[el.dataset.id] = 1;
    setPref({ collapsed });
  },
  'gantt-set-date': (el, e) => {
    const rect = el.getBoundingClientRect();
    const iso = fromDay(view.start + Math.floor((e.clientX - rect.left) / view.dayW));
    const t = getTask(el.dataset.id);
    commit(() => {
      t.start = iso;
      t.end = iso;
      fitParentToSubs(t);
      touch(t);
    });
  },
});

Object.assign(changes, {
  'gantt-compact': (el) => setPref({ compact: el.checked }),
  'gantt-sort': (el) => setPref({ sort: el.checked ? 'start' : 'manual' }),
  'gantt-bar-color': (el) => setPref({ barColor: el.checked ? 'project' : 'status' }),
});

/* ---------- Direct manipulation ---------- */

const LONG_PRESS_MS = 260;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 3;
const EDGE_SCROLL_ZONE = 44;

let drag = null;
let suppressClickUntil = 0;

export const shouldSuppressClick = () => performance.now() < suppressClickUntil;

function beginDrag() {
  drag.active = true;
  gantt.dragging = true;
  drag.el.classList.add('dragging');
  document.body.classList.add('is-dragging');
  if (drag.pointerType === 'touch') navigator.vibrate?.(8);
  const tip = document.createElement('div');
  tip.className = 'drag-tip';
  document.body.append(tip);
  drag.tip = tip;
  drag.raf = requestAnimationFrame(tick);
}

function dragDates(g) {
  const dx = g.x - g.startX + (g.scroller.scrollLeft - g.startScroll);
  const d = Math.round(dx / view.dayW);
  let { s, e } = g;
  if (g.mode === 'move') {
    s += d;
    e += d;
  } else if (g.mode === 'r') e = Math.max(s, e + d);
  else s = Math.min(e, s + d);
  return { s, e };
}

function tick() {
  if (!drag?.active) return;
  const rect = drag.scroller.getBoundingClientRect();
  const leftEdge = rect.left + view.labelW;
  if (drag.x > rect.right - EDGE_SCROLL_ZONE) drag.scroller.scrollLeft += 8;
  else if (drag.x < leftEdge + EDGE_SCROLL_ZONE) drag.scroller.scrollLeft -= 8;

  const { s, e } = dragDates(drag);
  placeBar(drag.el, s, e);
  // Moving a task carries its subtask bars along.
  for (const child of drag.children) placeBar(child.el, child.s + (s - drag.s), child.e + (s - drag.s));

  drag.tip.textContent = fmtRange(fromDay(s), fromDay(e));
  drag.tip.style.transform = `translate(${Math.min(drag.x, innerWidth - 90)}px, ${Math.max(drag.y - 52, 8)}px) translateX(-50%)`;
  drag.raf = requestAnimationFrame(tick);
}

function finish(commitChange) {
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  d.tip?.remove();
  d.el.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  gantt.dragging = false;
  suppressClickUntil = performance.now() + 350;

  const { s, e } = dragDates(d);
  gantt.anchor = view.start + d.scroller.scrollLeft / view.dayW;
  const changed = s !== d.s || e !== d.e;
  if (!commitChange || !changed) {
    requestRender();
    return;
  }
  const t = getTask(d.taskId);
  const startIso = fromDay(s);
  const endIso = fromDay(e);
  commit(() => {
    if (d.subId) {
      const sub = t.subtasks.find((x) => x.id === d.subId);
      sub.start = startIso;
      sub.end = endIso;
      fitParentToSubs(t);
    } else if (d.mode === 'move') {
      shiftTask(t, s - d.s);
    } else {
      t.start = startIso;
      t.end = endIso;
      clampSubsToParent(t);
    }
    touch(t);
  });
}

export function initGanttDrag() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const el = e.target.closest?.('[data-bar]');
    if (!el || !view) return;
    const t = getTask(el.dataset.id);
    if (!t) return;
    const subId = el.dataset.sub;
    const sub = subId ? t.subtasks.find((x) => x.id === subId) : null;
    const item = sub || t;
    const rect = el.getBoundingClientRect();
    const isTouch = e.pointerType !== 'mouse';
    const edge = isTouch ? 16 : 9;
    let mode = 'move';
    if (!el.classList.contains('diamond') && rect.width > edge * 2 + 8) {
      if (e.clientX - rect.left < edge) mode = 'l';
      else if (rect.right - e.clientX < edge) mode = 'r';
    }
    const children = !subId && mode === 'move' && !prefs.collapsed[t.id]
      ? collectSubBars(el, t)
      : [];
    drag = {
      el, taskId: t.id, subId, mode, children,
      s: toDay(item.start), e: toDay(item.end),
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
      scroller: el.closest('.g-scroll'),
      startScroll: el.closest('.g-scroll').scrollLeft,
      pointerId: e.pointerId, pointerType: e.pointerType,
      active: false, timer: 0,
    };
    if (isTouch) drag.timer = setTimeout(() => drag && !drag.active && beginDrag(), LONG_PRESS_MS);
    try {
      el.setPointerCapture(e.pointerId);
    } catch { /* the bar stays draggable through document-level listeners */ }
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.active) return;
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.pointerType === 'mouse') {
      if (moved > MOUSE_SLOP) beginDrag();
    } else if (moved > TOUCH_SLOP) {
      // Finger moved before the long press landed: that's a scroll, not a drag.
      finish(false);
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) finish(true);
  });
  document.addEventListener('pointercancel', (e) => {
    if (drag && e.pointerId === drag.pointerId) finish(false);
  });
  // Once a long press has lifted the bar, the page must stop scrolling under the finger.
  document.addEventListener('touchmove', (e) => {
    if (drag?.active) e.preventDefault();
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('[data-bar]')) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag?.active) finish(false);
  });
}

function collectSubBars(parentEl, t) {
  const canvas = parentEl.closest('.g-canvas');
  const out = [];
  for (const s of t.subtasks) {
    if (!s.start || !s.end) continue;
    const el = canvas.querySelector(`[data-bar][data-sub="${CSS.escape(s.id)}"]`);
    if (el) out.push({ el, s: toDay(s.start), e: toDay(s.end) });
  }
  return out;
}
