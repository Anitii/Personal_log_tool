// Gantt view. Geometry is plain date→pixel arithmetic; while dragging, only the affected
// bars are touched inside requestAnimationFrame and state changes once on release.
import {
  STATUS, WEEKDAYS, clampSubsToParent, fitParentToSubs, fmtMD, fmtRange, fromDay, inkOn, isDone, isSubOverdue, mondayOf, occurrences, occursOn,
  percent, repeatLabel, shiftTask, statusOf, subDoneOn, subStatusOf, subsForDay, tasksForDay, toDay, todayStr, weekNumber, weekdayIdx,
} from './core.js';
import { commit, getProject, getTask, prefs, savePrefs, setPref, state, touch, visibleTasks } from './store.js';
import { onPinch } from './pinch.js';
import { actions, changes, esc, icon, resetters, resizers } from './ui.js';
import { chipsHTML, emptyHTML, headerHTML, planSegHTML } from './views.js';

// One continuous zoom, set by pinching. Wide enough days show one column per day, grouped by
// week; below DAY_MIN the smallest unit becomes the week, grouped by month.
const MIN_W = 6;
const MAX_W = 84;
const DAY_MIN = 18;
const TIGHT = 30; // narrower days drop the weekday name
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

// The task column's width is the user's once they drag its border (phones keep their own).
const labelKey = (phone) => (phone ? 'ganttLabelWPhone' : 'ganttLabelW');
const DETAIL_COLS_MIN = 420; // narrower than this, the extra columns would crush the names
const maxLabelW = () => Math.min(760, Math.round(innerWidth * 0.75));

function layout() {
  const w = innerWidth;
  const phone = w < NARROW;
  const canDetail = w >= DETAIL_MIN;
  const custom = Number(prefs[labelKey(phone)]);
  const wantDetail = canDetail && !prefs.compact;
  const labelW = Number.isFinite(custom) && custom > 0
    ? Math.min(maxLabelW(), Math.max(90, custom))
    : wantDetail ? 500 : phone ? 156 : 228;
  return {
    phone,
    canDetail,
    detail: wantDetail && labelW >= DETAIL_COLS_MIN,
    dayW: dayWidth(phone),
    labelW,
  };
}

export function dayWidth(phone = innerWidth < NARROW) {
  const w = Number(prefs.ganttDayW);
  return Number.isFinite(w) ? Math.min(MAX_W, Math.max(MIN_W, w)) : phone ? 38 : 44;
}
const coarse = (dayW) => dayW < DAY_MIN;

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

// Rough rendered width of a label: CJK glyphs are about one em wide, Latin about 0.6 em.
const textWidth = (str, px) => [...String(str)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? px : px * 0.6), 0);

// Every bar carries its name, so nobody has to look back at the left column: inside the bar
// when it fits, otherwise just to its right. Inside labels slide along while the bar's start
// is scrolled out of view (see syncBarLabels).
function barHTML({ taskId, subId, title, start, end, st, pct, isSub, range: rangeLabel, colorStyle = '', still = false }) {
  const s = toDay(start);
  const e = toDay(end);
  const name = title || (subId ? '未命名子任務' : '未命名任務');
  const common = `${still ? '' : 'data-bar'} data-act="open-task" data-id="${esc(taskId)}" ${subId ? `data-sub="${esc(subId)}" data-focus-sub="${esc(subId)}"` : ''} role="button" tabindex="0"
    aria-label="${esc(name)}，${esc(rangeLabel)}，${esc(STATUS[st].label)}"`;
  const out = (left) => `<span class="bar-out ${isSub ? 'is-sub' : ''} ${st === 'done' ? 'is-done' : ''}" style="left:${left}px" aria-hidden="true">${esc(name)}</span>`;
  if (s === e) {
    const size = isSub ? 13 : 17;
    const left = (s - view.start) * view.dayW + view.dayW / 2 - size / 2;
    return `<div class="bar diamond s-${STATUS[st].cls} ${isSub ? 'is-sub' : ''}" style="${colorStyle}left:${left}px;width:${size}px;height:${size}px" ${common}></div>${out(left + size + 7)}`;
  }
  const g = barGeom(s, e);
  const fits = g.width > textWidth(name, isSub ? 11.5 : 12.5) + 20;
  return `<div class="bar s-${STATUS[st].cls} ${isSub ? 'is-sub' : ''}" style="${colorStyle}left:${g.left}px;width:${g.width}px" ${common}>
    ${pct > 0 && pct < 100 ? `<i class="bar-fill" style="width:${pct}%"></i>` : ''}
    ${fits ? `<span class="bar-text">${esc(name)}</span>` : ''}
  </div>${fits ? '' : out(g.left + g.width + 6)}`;
}

function repeatHTML(t, s, colorStyle) {
  const attrs = `data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}"`;
  const occ = occurrences(s, t).filter((d) => toDay(d) >= view.start && toDay(d) <= view.end);
  if (coarse(view.dayW) || view.dayW < 12) {
    if (!occ.length) return '';
    const g = barGeom(toDay(occ[0]), toDay(occ[occ.length - 1]));
    return `<div class="rep-band" style="${colorStyle}left:${g.left}px;width:${g.width}px" ${attrs} role="button" tabindex="0" aria-label="${esc(s.title)}，${esc(repeatLabel(s))}"></div>`;
  }
  const size = Math.min(14, view.dayW - 6);
  return occ.map((d) => `<i class="rep-dot ${subDoneOn(s, d) ? 'on' : ''}" style="${colorStyle}left:${(toDay(d) - view.start) * view.dayW + view.dayW / 2 - size / 2}px;width:${size}px;height:${size}px" ${attrs} title="${esc(d)}"></i>`).join('');
}

// Rows can be dragged into a new order by their grip, unless the list is sorted by date.
const canReorder = () => prefs.sort !== 'start';
const gripHTML = (attrs) => (canReorder()
  ? `<span class="g-grip" data-grip ${attrs} title="拖曳調整順序" aria-hidden="true">${icon.grip}</span>`
  : '');

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
  return `<div class="g-label">${gripHTML(`data-id="${esc(t.id)}"`) || '<span class="g-grip-gap"></span>'}${twisty}${main}${cols}</div>`;
}

// The layer above everything: what today holds, across all tasks. A task with subtasks
// scheduled today is represented by those subtasks; otherwise by itself.
function todayLayerHTML(items, todayIso, tw) {
  const shown = new Set(items.map((t) => t.id));
  const tasks = tasksForDay(state, todayIso, todayIso).filter((t) => shown.has(t.id));
  const entries = [];
  for (const t of tasks) {
    const subs = subsForDay(t, todayIso, todayIso, { withDone: true });
    if (subs.length) for (const s of subs) entries.push({ t, s });
    else if (!t.subtasks.length || t.end < todayIso) entries.push({ t, s: null });
  }
  const open = !prefs.ganttTodayClosed;
  const isOff = ({ t, s }) => (s ? (s.repeat && occursOn(s, todayIso, t) ? subDoneOn(s, todayIso) : s.done) : isDone(t));
  const left = entries.filter((x) => !isOff(x)).length;
  const [, m, d] = todayIso.split('-').map(Number);
  const head = `<div class="g-row g-today-head" style="height:${SUB_H}px">
      <div class="g-label"><button type="button" class="twisty ${open ? 'open' : ''}" data-act="gantt-today-layer" aria-expanded="${open}" aria-label="${open ? '收合' : '展開'}今天">${icon.chevR}</button>
        <button type="button" class="g-today-title" data-act="gantt-today-layer"><b>今天 ${m}/${d}</b><span>${entries.length ? `${left} 項待完成，共 ${entries.length} 項` : '沒有排定的事'}</span></button></div>
      <div class="g-track" style="width:${tw}px"></div>
    </div>`;
  if (!open) return head;
  const rows = entries.map(({ t, s }) => {
    const color = barColorStyle(t);
    const project = getProject(t.projectId);
    const dot = `<i class="dot" style="background:${esc(t.color || project?.color || 'var(--label3)')}"></i>`;
    if (!s) {
      const st = statusOf(t, todayIso);
      return `<div class="g-row g-today-row" style="height:${SUB_H}px">
        <div class="g-label"><button type="button" class="check small ${isDone(t) ? 'on' : ''}" data-act="toggle-task" data-id="${esc(t.id)}" role="checkbox" aria-checked="${isDone(t)}" aria-label="完成：${esc(t.title)}"></button>
          <button type="button" class="g-title" data-act="open-task" data-id="${esc(t.id)}"><span class="g-name">${dot}${esc(t.title) || '<em>未命名任務</em>'}${st === 'late' ? ' <span class="text-late">逾期</span>' : ''}</span></button></div>
        <div class="g-track" style="width:${tw}px">${t.start && t.end && t.end >= t.start ? barHTML({ taskId: t.id, title: t.title, start: t.start, end: t.end, st, pct: percent(t), isSub: true, range: fmtRange(t.start, t.end), colorStyle: color, still: true }) : ''}</div>
      </div>`;
    }
    const daily = !!s.repeat && occursOn(s, todayIso, t);
    const done = isOff({ t, s });
    const st = subStatusOf(s, todayIso, t);
    const late = isSubOverdue(s, todayIso);
    const from = s.start || t.start;
    const to = s.end || t.end;
    const track = s.repeat ? repeatHTML(t, s, color)
      : from && to && to >= from ? barHTML({ taskId: t.id, subId: s.id, title: s.title, start: from, end: to, st, pct: 0, isSub: true, range: fmtRange(from, to), colorStyle: color, still: true }) : '';
    return `<div class="g-row g-today-row ${done ? 'is-done' : ''}" style="height:${SUB_H}px">
      <div class="g-label"><button type="button" class="check small ${done ? 'on' : ''}" data-act="toggle-sub" data-id="${esc(t.id)}" data-sub="${esc(s.id)}" ${daily ? `data-date="${todayIso}"` : ''} role="checkbox" aria-checked="${done}" aria-label="完成：${esc(s.title)}"></button>
        <button type="button" class="g-title" data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}">
          <span class="g-name ${done ? 'struck' : ''}">${dot}${s.repeat ? '<span class="repeat-mark">↻</span> ' : ''}${esc(s.title) || '<em>未命名子任務</em>'}${late ? ' <span class="text-late">逾期</span>' : ''}</span>
          <span class="g-meta">${esc(t.title || '未命名任務')}</span></button></div>
      <div class="g-track" style="width:${tw}px">${track}</div>
    </div>`;
  }).join('');
  return head + rows + '<div class="g-today-gap" aria-hidden="true"></div>';
}

function headerRows(l, today) {
  const { start, days } = view;
  const { dayW } = l;
  const weekly = coarse(dayW);
  let groups = '';
  if (weekly) {
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
      const label = 7 * dayW >= 170 ? `第 ${weekNumber(a, state.settings)} 週｜${fmtMD(fromDay(a))}–${fmtMD(fromDay(a + 6))}` : `W${weekNumber(a, state.settings)}`;
      groups += `<div class="g-group" style="width:${7 * dayW}px"><span>${label}</span></div>`;
    }
  }

  let cells = '';
  if (weekly) {
    for (let i = 0; i < days; i += 7) {
      const isThisWeek = today >= start + i && today < start + i + 7;
      const label = 7 * dayW >= 40 ? fmtMD(fromDay(start + i)) : '';
      cells += `<div class="g-day week-cell ${isThisWeek ? 'is-today-week' : ''}" style="width:${7 * dayW}px">${label}</div>`;
    }
  } else {
    for (let i = 0; i < days; i++) {
      const n = start + i;
      const wd = weekdayIdx(n);
      const dateNum = Number(fromDay(n).slice(8));
      cells += `<div class="g-day ${dayW < TIGHT ? 'tight' : ''} ${wd === 5 ? 'sat' : wd === 6 ? 'sun' : ''} ${n === today ? 'is-today' : ''}" style="width:${dayW}px">
        ${dayW < TIGHT ? '' : `<small>${WEEKDAYS[wd]}</small>`}<b>${dateNum}</b></div>`;
    }
  }
  return { groups, cells };
}

function weekendStripes(l) {
  if (coarse(l.dayW)) return '';
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
  const items = visibleTasks(todayIso, { archived: prefs.ganttArchived });
  const l = layout();
  const r = range(state.tasks, today);
  // The axis must reach past both edges of the screen around the anchor, or the browser clamps
  // the scroll position and a zoom drifts away from the day it was centered on.
  const want = gantt.pendingToday || gantt.anchor == null ? today - 2 : gantt.anchor;
  const viewW = Math.max(320, (main.clientWidth || innerWidth) - l.labelW);
  if (want < r.start + 1) r.start = mondayOf(Math.floor(want)) - 7;
  const needEnd = Math.ceil(want + viewW / l.dayW) + 7;
  if (needEnd > r.end) r.end = mondayOf(needEnd) + 6;
  r.days = r.end - r.start + 1;
  view ={ ...r, dayW: l.dayW, labelW: l.labelW };

  const menu = gantt.menuOpen ? `<div class="menu" role="menu">
      ${l.canDetail ? `<label class="menu-item">精簡模式：只看行動事項<input type="checkbox" class="switch" data-ch="gantt-compact" ${prefs.compact ? 'checked' : ''}></label>` : ''}
      <label class="menu-item">隱藏已完成<input type="checkbox" class="switch" data-ch="hide-done" ${prefs.hideDone ? 'checked' : ''}></label>
      <label class="menu-item">依開始日期排序<input type="checkbox" class="switch" data-ch="gantt-sort" ${prefs.sort === 'start' ? 'checked' : ''}></label>
      <label class="menu-item">顯示已封存<input type="checkbox" class="switch" data-ch="gantt-archived" ${prefs.ganttArchived ? 'checked' : ''}></label>
      <label class="menu-item">色條依專案上色<input type="checkbox" class="switch" data-ch="gantt-bar-color" ${prefs.barColor === 'project' ? 'checked' : ''}></label>
    </div>` : '';

  const withSubs = items.filter((t) => t.subtasks.length);
  const anyClosed = withSubs.some((t) => prefs.collapsed[t.id]);
  const foldAll = withSubs.length
    ? `<button type="button" class="btn-circle" data-act="gantt-fold-all" data-open="${anyClosed ? 1 : 0}" aria-label="${anyClosed ? '全部展開' : '全部收合'}" title="${anyClosed ? '全部展開' : '全部收合'}">${anyClosed ? icon.expandAll : icon.collapseAll}</button>`
    : '';
  const trailing = `${foldAll}<div class="zoom-btns" role="group" aria-label="縮放">
      <button type="button" data-act="gantt-zoom" data-f="0.7" aria-label="縮小，看更長的時間">−</button>
      <button type="button" data-act="gantt-zoom" data-f="1.43" aria-label="放大，看每一天">+</button></div>
    <button type="button" class="text-btn today-btn" data-act="plan-today">今天</button>
    <div class="menu-wrap"><button type="button" class="btn-circle" data-act="gantt-menu" aria-label="顯示選項" aria-expanded="${gantt.menuOpen}">${icon.more}</button>${menu}</div>`;

  const legend = `<div class="legend" aria-label="圖例">
    ${['todo', 'doing', 'done', 'late'].map((k) => `<span><i class="lg s-${k}"></i>${STATUS[k].label}</span>`).join('')}
    <span><i class="lg-diamond"></i>單日任務</span>
    <span><i class="lg-rep"></i>重複子任務</span>
    <span class="legend-hint">${l.phone ? '雙指縮放切換天／週｜長按色條可拖曳' : '觸控板雙指縮放切換天／週｜拖曳色條改日期'}</span>
  </div>`;

  const week = weekNumber(today, state.settings);
  const headHTML = `<div class="g-head-wrap">
      ${headerHTML('計畫', `甘特｜本週第 ${week} 週｜${coarse(l.dayW) ? '以週為單位' : '以天為單位'}`, trailing)}
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
    rows.push(`<div class="g-row is-task ${t.archivedAt ? 'is-archived' : ''} ${st === 'done' ? 'is-done-row' : ''}" style="height:${ROW_H}px" data-task="${esc(t.id)}">
      ${labelHTML(t, st, pct, l)}
      <div class="g-track" style="width:${tw}px" ${dated ? '' : `data-act="gantt-set-date" data-id="${esc(t.id)}"`}>
        ${dated ? barHTML({ taskId: t.id, title: t.title, start: t.start, end: t.end, st, pct, range: fmtRange(t.start, t.end), colorStyle: barColorStyle(t) }) : `<span class="g-hint" style="left:${(today - r.start) * l.dayW + 6}px">${t.start || t.end ? '日期有誤，點此重設' : '點時間軸設定日期'}</span>`}
      </div>
    </div>`);
    if (t.subtasks.length && !prefs.collapsed[t.id]) {
      t.subtasks.forEach((s, si) => {
        const sst = subStatusOf(s, todayIso, t);
        const late = isSubOverdue(s, todayIso);
        const sDated = s.start && s.end && s.end >= s.start;
        const track = s.repeat
          ? repeatHTML(t, s, barColorStyle(t))
          : sDated ? barHTML({ taskId: t.id, subId: s.id, title: s.title, start: s.start, end: s.end, st: sst, pct: 0, isSub: true, range: fmtRange(s.start, s.end), colorStyle: barColorStyle(t) }) : '';
        rows.push(`<div class="g-row is-sub ${si === t.subtasks.length - 1 ? 'is-last' : ''}" style="height:${SUB_H}px" data-parent="${esc(t.id)}" data-sub-row="${esc(s.id)}">
          <div class="g-label sub-label">${gripHTML(`data-id="${esc(t.id)}" data-sub="${esc(s.id)}"`) || '<span class="g-grip-gap"></span>'}<span class="g-tree" aria-hidden="true"></span><button type="button" class="g-title" data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}">
            <span class="g-name ${sst === 'done' ? 'struck' : ''}"><i class="sub-bullet ${sst === 'done' ? 'on' : ''}"></i>${s.repeat ? '<span class="repeat-mark">↻</span> ' : ''}${esc(s.title) || '<em>未命名子任務</em>'}${late ? ' <span class="text-late">逾期</span>' : ''}</span></button></div>
          <div class="g-track" style="width:${tw}px">${track}</div>
        </div>`);
      });
    }
  }

  const detailHead = l.detail
    ? '<span class="g-col c-project">專案</span><span class="g-col c-date">起訖</span><span class="g-col c-num">完成</span><span class="g-col c-status">狀態</span>'
    : '';

  const showToday = today >= r.start && today <= r.end;
  main.innerHTML = `<div class="gantt-view">
    ${headHTML}
    <div class="g-scroll-wrap">
    <div class="g-scroll" tabindex="-1">
      <div class="g-canvas" style="--lw:${l.labelW}px;--tw:${tw}px;--dw:${l.dayW}px;width:${l.labelW + tw}px">
        <div class="g-head">
          <div class="g-corner"><span class="g-corner-title">行動事項</span>${detailHead}</div>
          <div class="g-head-time" style="width:${tw}px">
            <div class="g-groups">${groups}</div>
            <div class="g-days ${coarse(l.dayW) ? 'month' : 'week'}">${cells}</div>
          </div>
        </div>
        <div class="g-body">
          <div class="g-bg ${coarse(l.dayW) ? 'month' : 'week'}" aria-hidden="true">${weekendStripes(l)}${showToday ? `<i class="g-now" style="left:${(today - r.start) * l.dayW + l.dayW / 2}px"></i>` : ''}</div>
          ${todayLayerHTML(items, todayIso, tw)}
          ${rows.join('') || '<div class="g-none">這個篩選條件下沒有任務</div>'}
          <i class="g-drop" hidden></i>
          <div class="g-row g-add" style="height:${ROW_H}px"><div class="g-label"><button type="button" class="g-add-btn" data-act="new-task">${icon.plus}<span>新增任務</span></button></div><div class="g-track" style="width:${tw}px"></div></div>
        </div>
      </div>
    </div>
    <div class="col-resizer" data-resize="gantt-label" style="left:${l.labelW}px" title="拖曳調整任務欄寬度，點兩下還原" aria-hidden="true"></div>
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
  syncBarLabels(scroller);
}

let extending = false;
// A bar whose start is scrolled off the left keeps its name at the visible edge.
let labelRaf = 0;
function syncBarLabels(scroller) {
  const visible = scroller.scrollLeft; // the timeline starts right after the sticky task column
  for (const text of scroller.querySelectorAll('.bar .bar-text')) {
    const bar = text.parentElement;
    const left = parseFloat(bar.style.left) || 0;
    const shift = Math.max(0, Math.min(visible - left, bar.offsetWidth));
    const remaining = bar.offsetWidth - shift - 4;
    text.style.transform = shift ? `translateX(${shift}px)` : '';
    // What is left of the bar may be shorter than the name: shorten it, or drop it if tiny.
    text.style.maxWidth = shift ? `${Math.max(0, remaining)}px` : '';
    text.style.visibility = shift && remaining < 26 ? 'hidden' : '';
  }
  // A name beside a bar that has scrolled away would point at nothing.
  for (const out of scroller.querySelectorAll('.bar-out')) {
    out.style.visibility = (parseFloat(out.style.left) || 0) < visible + 2 ? 'hidden' : '';
  }
}

function onScroll(e) {
  const el = e.currentTarget;
  if (!labelRaf) {
    labelRaf = requestAnimationFrame(() => {
      labelRaf = 0;
      syncBarLabels(el);
    });
  }
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

/* ---------- Zoom: keep the day under the fingers where it is ---------- */

let saveTimer = 0;
function zoomBy(factor, clientX) {
  const scroller = document.querySelector('.g-scroll');
  if (!view || !scroller || gantt.dragging) return;
  const cur = dayWidth();
  const next = Math.min(MAX_W, Math.max(MIN_W, cur * factor));
  if (Math.abs(next - cur) < 0.01) return;
  const rect = scroller.getBoundingClientRect();
  const px = clientX == null ? (rect.width - view.labelW) / 2 : Math.max(0, clientX - rect.left - view.labelW);
  const anchor = gantt.anchor ?? view.start + scroller.scrollLeft / cur;
  const dayAt = anchor + px / cur;
  gantt.anchor = dayAt - px / next;
  prefs.ganttDayW = next;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePrefs, 300);
  requestRender();
}
onPinch('.gantt-view .g-scroll', (f, x) => zoomBy(f, x));

/* ---------- Task column width ---------- */

resizers['gantt-label'] = (el) => {
  const canvas = document.querySelector('.gantt-view .g-canvas');
  if (!canvas || !view) return null;
  const start = view.labelW;
  const tw = view.days * view.dayW;
  let w = start;
  gantt.dragging = true;
  return {
    axis: 'x',
    onMove: (d) => {
      w = Math.min(maxLabelW(), Math.max(90, Math.round(start + d)));
      canvas.style.setProperty('--lw', `${w}px`);
      canvas.style.width = `${w + tw}px`;
      el.style.left = `${w}px`;
    },
    onEnd: () => {
      gantt.dragging = false;
      setPref({ [labelKey(innerWidth < NARROW)]: w });
    },
  };
};
resetters['gantt-label'] = () => setPref({ [labelKey(innerWidth < NARROW)]: null });

/* ---------- Actions ---------- */

Object.assign(actions, {
  'gantt-zoom': (el) => zoomBy(Number(el.dataset.f), null),
  'gantt-menu': () => {
    gantt.menuOpen = !gantt.menuOpen;
    requestRender();
  },
  'gantt-today-layer': () => setPref({ ganttTodayClosed: !prefs.ganttTodayClosed }),
  'gantt-fold-all': (el) => {
    if (el.dataset.open === '1') {
      setPref({ collapsed: {} });
      return;
    }
    const collapsed = {};
    for (const t of state.tasks) if (t.subtasks.length) collapsed[t.id] = 1;
    setPref({ collapsed });
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
  'gantt-archived': (el) => setPref({ ganttArchived: el.checked }),
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
  // Outside labels stay put while the bar moves; hide them until the re-render places them.
  for (const el of [drag.el, ...drag.children.map((c) => c.el)]) {
    if (el.nextElementSibling?.classList.contains('bar-out')) el.nextElementSibling.style.visibility = 'hidden';
  }
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

/* ---------- Reordering rows by their grip ---------- */

let reorder = null;

// Where the dragged row would land: the gap nearest the pointer among its siblings.
function reorderTarget(y) {
  const r = reorder;
  const top = r.body.getBoundingClientRect().top;
  let best = null;
  r.gaps.forEach((g, i) => {
    const d = Math.abs(top + g - y);
    if (!best || d < best.d) best = { i, d, y: g };
  });
  return best;
}

function reorderTick() {
  if (!reorder?.active) return;
  const r = reorder;
  const rect = r.scroller.getBoundingClientRect();
  if (r.y < rect.top + 60) r.scroller.scrollTop -= 8;
  else if (r.y > rect.bottom - 40) r.scroller.scrollTop += 8;
  r.target = reorderTarget(r.y);
  r.line.hidden = false;
  r.line.style.top = `${r.target.y - 1}px`;
  r.line.style.left = `${r.indent}px`;
  r.raf = requestAnimationFrame(reorderTick);
}

function beginReorder() {
  const r = reorder;
  r.active = true;
  gantt.dragging = true;
  document.body.classList.add('is-dragging');
  r.rowEls.forEach((el) => el.classList.add('reordering'));
  if (r.pointerType !== 'mouse') navigator.vibrate?.(8);
  r.raf = requestAnimationFrame(reorderTick);
}

function endReorder(apply) {
  const r = reorder;
  reorder = null;
  if (!r.active) return;
  cancelAnimationFrame(r.raf);
  r.line.hidden = true;
  r.rowEls.forEach((el) => el.classList.remove('reordering'));
  document.body.classList.remove('is-dragging');
  gantt.dragging = false;
  suppressClickUntil = performance.now() + 350;
  gantt.scrollTop = r.scroller.scrollTop;
  const i = r.target?.i;
  if (!apply || i == null || i === r.from || i === r.from + 1) {
    requestRender();
    return;
  }
  const t = getTask(r.taskId);
  if (!t) return;
  if (r.subId) {
    commit(() => {
      const list = t.subtasks;
      const [moved] = list.splice(r.from, 1);
      list.splice(i > r.from ? i - 1 : i, 0, moved);
      touch(t);
    });
    return;
  }
  // The task takes an order between its new neighbours; nothing else changes.
  const ids = r.ids.filter((id) => id !== r.taskId);
  const at = i > r.from ? i - 1 : i;
  const prev = getTask(ids[at - 1]);
  const next = getTask(ids[at]);
  commit(() => {
    t.order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next ? next.order - 1 : t.order;
    touch(t);
  });
}

export function initGanttReorder() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || reorder || drag) return;
    const grip = e.target.closest?.('[data-grip]');
    if (!grip) return;
    const scroller = grip.closest('.g-scroll');
    const body = scroller.querySelector('.g-body');
    const bodyTop = body.getBoundingClientRect().top;
    const offset = (el) => el.getBoundingClientRect().top - bodyTop;
    const subId = grip.dataset.sub || '';
    const taskId = grip.dataset.id;
    let rows;
    let ends;
    let rowEls;
    if (subId) {
      rows = [...body.querySelectorAll(`.g-row.is-sub[data-parent="${CSS.escape(taskId)}"]`)];
      ends = rows.map((el) => offset(el) + el.offsetHeight);
      rowEls = rows.filter((el) => el.dataset.subRow === subId);
    } else {
      rows = [...body.querySelectorAll('.g-row.is-task')];
      // A task's block runs to the next task: its subtasks travel with it.
      const add = body.querySelector('.g-add');
      ends = rows.map((el, i) => (rows[i + 1] ? offset(rows[i + 1]) : offset(add)));
      const self = rows.find((el) => el.dataset.task === taskId);
      rowEls = [self, ...body.querySelectorAll(`.g-row.is-sub[data-parent="${CSS.escape(taskId)}"]`)];
    }
    const ids = rows.map((el) => (subId ? el.dataset.subRow : el.dataset.task));
    const from = ids.indexOf(subId || taskId);
    if (from < 0) return;
    reorder = {
      taskId, subId, ids, from, rowEls, scroller, body,
      gaps: [offset(rows[0]), ...ends],
      line: body.querySelector('.g-drop'),
      indent: subId ? 22 : 0,
      y: e.clientY, startY: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType, active: false,
    };
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!reorder || e.pointerId !== reorder.pointerId) return;
    reorder.y = e.clientY;
    if (!reorder.active && Math.abs(e.clientY - reorder.startY) > 3) beginReorder();
  });
  document.addEventListener('pointerup', (e) => {
    if (reorder && e.pointerId === reorder.pointerId) endReorder(true);
  });
  document.addEventListener('pointercancel', (e) => {
    if (reorder && e.pointerId === reorder.pointerId) endReorder(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && reorder?.active) endReorder(false);
  });
}
