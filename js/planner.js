// Day view: the 10-minute table plus a whole-day timeline. Everything here writes to
// state.blocks only. A task's own dates, status and progress are never touched, which is why
// rearranging today leaves the week and month plans exactly as they were.
import {
  DAY_MINUTES, FREE_BLOCK_COLOR, SLOT, WEEKDAYS, addDays, assignLanes, blockSegments, blocksOn, fmtDuration, fmtMinute,
  fitParentToSubs, inkOn, isImportant, isSubOverdue, makeBlock, makeSub, makeTask, parseMinute, percent, plannedMinutes, setDone, snapMinute,
  subsForDay, tasksForDay, toDay, todayStr, weekNumber, weekdayIdx,
} from './core.js';
import { blockInfo, commit, focusDate, getProject, getTask, state, taskColor, touch } from './store.js';
import { actions, changes, colorRowHTML, enters, esc, icon, inputs, toast } from './ui.js';
import { closeSheet, openPanel } from './sheet.js';
import { headerHTML, planSegHTML, stripHTML } from './views.js';
import { gantt } from './gantt.js';
import { gcalBarHTML, gcalConnected, gcalCreate, gcalDraggable, gcalEnsure, gcalEventsOn, gcalMove } from './gcal.js';

const NARROW = 768;
const DEFAULT_TAP_MIN = 30;
const DEFAULT_DROP_MIN = 60;
const LONG_PRESS_MS = 260;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 3;
const EDGE_ZONE = 36;

const planner = {
  brush: null, // { taskId, subId, title } waiting to be placed
  scrollTop: null,
  renderedFor: null,
  showHidden: false, // unfiled blocks the tray was told to hide
};

let requestRender = () => {};
export const setPlannerRender = (fn) => (requestRender = fn);

export const planDate = () => (focusDate.plan ||= todayStr());

const nowMinute = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/* ---------- Rendering ---------- */

function segmentsHTML(b, lane, lanes, { preview = false } = {}) {
  const info = blockInfo(b);
  const color = info.color || FREE_BLOCK_COLOR;
  const span = `${fmtMinute(b.start)}–${fmtMinute(b.end)}`;
  return blockSegments(b.start, b.end).map((seg) => {
    const pos = `left:${(seg.from / 60) * 100}%;width:${((seg.to - seg.from) / 60) * 100}%;top:calc(var(--rh) * ${seg.row + lane / lanes});height:calc(var(--rh) / ${lanes});--st:${esc(color)};--ink:${inkOn(color)}`;
    const cls = `dp-seg ${seg.first ? 'first' : ''} ${seg.last ? 'last' : ''} ${b.done ? 'is-done' : ''} ${preview ? 'preview' : ''}`;
    const attrs = preview ? 'aria-hidden="true"' : `data-block="${esc(b.id)}" data-act="dp-open" ${seg.first ? `role="button" tabindex="0" aria-label="${esc(info.title)}，${span}"` : 'aria-hidden="true"'}`;
    return `<div class="${cls}" style="${pos}" ${attrs}>
      ${seg.first ? `<span class="dp-seg-text">${esc(info.title)}</span>` : ''}
      ${seg.last && !preview ? '<i class="dp-h" aria-hidden="true"></i>' : ''}
    </div>`;
  }).join('');
}

// A Google Calendar event on the 10-minute table: same geometry as a block, its own look.
function eventSegmentsHTML(e, iso, lane, lanes) {
  const span = `${fmtMinute(e.start)}–${fmtMinute(e.end)}`;
  const drag = gcalDraggable(e);
  return blockSegments(e.start, e.end).map((seg) => {
    const pos = `left:${(seg.from / 60) * 100}%;width:${((seg.to - seg.from) / 60) * 100}%;top:calc(var(--rh) * ${seg.row + lane / lanes});height:calc(var(--rh) / ${lanes});--st:${esc(e.soft)};--ink:${e.ink};--gc:${esc(e.color)}`;
    const attrs = `data-gev="${esc(e.key)}" data-date="${esc(iso)}" data-act="gev-open" ${seg.first ? `role="button" tabindex="0" aria-label="Google 日曆：${esc(e.title)}，${span}"` : 'aria-hidden="true"'}`;
    return `<div class="dp-seg gev ${seg.first ? 'first' : ''} ${seg.last ? 'last' : ''} ${drag ? '' : 'locked'}" style="${pos}" ${attrs}>
      ${seg.first ? `<span class="dp-seg-text">${esc(e.title) || '（沒有標題）'}</span>` : ''}
      ${seg.last && drag ? '<i class="dp-h" aria-hidden="true"></i>' : ''}
    </div>`;
  }).join('');
}

// The day's Google Calendar events, listed under the tasks like the unfiled blocks.
function eventTrayHTML(events, iso) {
  if (!gcalConnected()) return '';
  const rows = events.map((e) => `<div class="tray-row free gev-row" data-act="gev-open" data-gev="${esc(e.key)}" data-date="${esc(iso)}" role="button" tabindex="0">
      <i class="dot" style="background:${esc(e.color)}"></i>
      <span class="tray-title">${esc(e.title) || '<em>（沒有標題）</em>'}</span>
      <small>${e.allDay ? '整天' : `${fmtMinute(e.start)}–${fmtMinute(e.end)}`}</small>
    </div>`).join('');
  return `<div class="tray-sep" role="separator"><span>Google 日曆</span>
      <button type="button" class="text-btn" data-act="gev-new" data-date="${esc(iso)}">新增行程</button></div>${rows}`;
}

function trayRow(t, iso, today, minutes) {
  const color = t.color || (state.projects.find((p) => p.id === t.projectId)?.color) || FREE_BLOCK_COLOR;
  const armed = planner.brush?.taskId === t.id && !planner.brush.subId;
  const important = isImportant(t, iso);
  const late = t.end < today;
  const subs = subsForDay(t, iso, today);
  const subRows = subs.map((s) => {
    const on = planner.brush?.subId === s.id;
    const overdue = isSubOverdue(s, today);
    return `<div class="tray-row sub ${on ? 'armed' : ''}" data-tray data-id="${esc(t.id)}" data-sub="${esc(s.id)}" data-act="dp-arm" role="button" tabindex="0">
      <i class="dot" style="background:${esc(color)}"></i><span class="tray-title">${s.repeat ? '<span class="repeat-mark">↻</span> ' : ''}${esc(s.title) || '<em>未命名子任務</em>'}</span>
      <small class="${overdue ? 'text-late' : ''}">${overdue ? '逾期' : minutes(t.id, s.id) ? esc(fmtDuration(minutes(t.id, s.id))) : ''}</small>
    </div>`;
  }).join('');
  const planned = minutes(t.id, '');
  return `<div class="tray-row ${armed ? 'armed' : ''}" data-tray data-id="${esc(t.id)}" data-act="dp-arm" role="button" tabindex="0">
      <i class="dot" style="background:${esc(color)}"></i>
      <span class="tray-title">${esc(t.title) || '<em>未命名任務</em>'}</span>
      <small class="${late ? 'text-late' : ''}">${late ? '逾期' : planned ? esc(fmtDuration(planned)) : '未排'}</small>
      <button type="button" class="star-btn ${important ? 'on' : ''}" data-act="toggle-focus" data-id="${esc(t.id)}" data-date="${esc(iso)}" ${t.priority === 3 ? 'disabled' : ''} aria-pressed="${important}" aria-label="標為這天最重要">${important ? icon.starOn : icon.star}</button>
      <button type="button" class="tray-info" data-act="open-task" data-id="${esc(t.id)}" aria-label="開啟任務內容">${icon.chevR}</button>
    </div>${subRows}`;
}

export function renderPlanner(main) {
  const today = todayStr();
  const iso = planDate();
  const day = toDay(iso);
  const blocks = blocksOn(state, iso);
  gcalEnsure(iso, iso);
  const events = gcalEventsOn(iso);
  const timed = events.filter((e) => !e.allDay);
  const lanes = assignLanes([...blocks, ...timed.map((e) => ({ id: `g:${e.key}`, start: e.start, end: e.end }))]);
  const isToday = iso === today;
  const [, m, d] = iso.split('-').map(Number);

  const minuteMap = new Map();
  for (const b of blocks) {
    if (!b.taskId) continue;
    const key = `${b.taskId}|${b.subId}`;
    minuteMap.set(key, (minuteMap.get(key) || 0) + (b.end - b.start));
  }
  const minutes = (taskId, subId) => minuteMap.get(`${taskId}|${subId}`) || 0;

  const dayTasks = tasksForDay(state, iso, today);
  const dayIds = new Set(dayTasks.map((t) => t.id));
  const others = state.tasks.filter((t) => !t.archivedAt && !dayIds.has(t.id) && percent(t) < 100);
  const unplaced = dayTasks.filter((t) => !minutes(t.id, '') && !t.subtasks.some((s) => minutes(t.id, s.id))).length;
  const planned = plannedMinutes(blocks);

  const prev = main.querySelector('.dp-scroll');
  if (prev && planner.renderedFor === iso) planner.scrollTop = prev.scrollTop;
  else if (planner.renderedFor !== iso) planner.scrollTop = null;
  planner.renderedFor = iso;

  const hours = Array.from({ length: 24 }, (_, h) => `<div class="dp-hour ${isToday && Math.floor(nowMinute() / 60) === h ? 'now' : ''}">${String(h).padStart(2, '0')}</div>`).join('');
  const colHead = [0, 10, 20, 30, 40, 50].map((n) => `<span>${n}</span>`).join('');
  const segs = blocks.map((b) => {
    const pos = lanes.get(b.id);
    return segmentsHTML(b, pos.lane, pos.lanes);
  }).join('') + timed.map((e) => {
    const pos = lanes.get(`g:${e.key}`);
    return eventSegmentsHTML(e, iso, pos.lane, pos.lanes);
  }).join('');

  const now = isToday ? nowMinute() : -1;
  const nowLine = isToday
    ? `<i class="dp-now" style="left:${((now % 60) / 60) * 100}%;top:calc(var(--rh) * ${Math.floor(now / 60)})"></i>`
    : '';

  const brushTitle = planner.brush ? brushLabel(planner.brush) : '';
  const banner = planner.brush
    ? `<div class="dp-banner"><span>點一下或拖曳時段，放入「${esc(brushTitle)}」</span><button type="button" class="text-btn" data-act="dp-disarm">取消</button></div>`
    : '';

  // Blocks filed under no task: listed under the tasks so nothing scheduled goes unseen.
  const unfiled = blocks.filter((b) => !b.taskId || !getTask(b.taskId));
  const hiddenCount = unfiled.filter((b) => b.trayHidden).length;
  const unfiledRows = unfiled.filter((b) => !b.trayHidden || planner.showHidden).map((b) => {
    const color = b.color || FREE_BLOCK_COLOR;
    return `<div class="tray-row free ${b.trayHidden ? 'is-hidden' : ''}" data-act="dp-open" data-block="${esc(b.id)}" role="button" tabindex="0">
      <i class="dot" style="background:${esc(color)}"></i>
      <span class="tray-title">${esc(b.title) || '<em>未命名時段</em>'}</span>
      <small>${fmtMinute(b.start)}–${fmtMinute(b.end)}</small>
      <button type="button" class="tray-icon" data-act="dp-file" data-block="${esc(b.id)}" aria-label="加入專案" title="加入專案">${icon.folder}</button>
      <button type="button" class="tray-icon" data-act="dp-hide" data-block="${esc(b.id)}" aria-label="${b.trayHidden ? '取消隱藏' : '從清單隱藏'}" title="${b.trayHidden ? '取消隱藏' : '從清單隱藏'}">${b.trayHidden ? icon.eye : icon.eyeOff}</button>
    </div>`;
  }).join('');
  const unfiledSection = unfiled.length ? `<div class="tray-sep" role="separator"><span>未歸檔的時段</span>
      ${hiddenCount ? `<button type="button" class="text-btn" data-act="dp-show-hidden">${planner.showHidden ? '收起隱藏的' : `顯示隱藏的 ${hiddenCount} 個`}</button>` : ''}</div>${unfiledRows}` : '';

  const trayBody = (dayTasks.map((t) => trayRow(t, iso, today, minutes)).join('')
    || '<p class="tray-empty">這天沒有排定的任務。可以從下方挑一個，或新增自由時段。</p>') + unfiledSection + eventTrayHTML(events, iso);

  const otherOptions = others.length
    ? `<select class="field-select tray-select" data-ch="dp-other" aria-label="排入其他任務">
        <option value="">排入其他任務…</option>
        ${others.map((t) => `<option value="${esc(t.id)}">${esc(t.title) || '未命名任務'}</option>`).join('')}
      </select>`
    : '';

  const head = `<div class="g-head-wrap">
      ${headerHTML('計畫', `${isToday ? '今天的時間表' : '時間表'}｜第 ${weekNumber(day, state.settings)} 週`, '<button type="button" class="text-btn today-btn" data-act="plan-today">今天</button>')}
      <div class="g-controls">
        ${planSegHTML()}
        <div class="tb-nav">
          <button type="button" class="btn-circle" data-act="dp-shift" data-n="-1" aria-label="前一天">${icon.back}</button>
          <label class="dp-date"><b>${m}/${d} 星期${WEEKDAYS[weekdayIdx(day)]}</b><input type="date" value="${esc(iso)}" data-ch="dp-date" aria-label="選擇日期"></label>
          <button type="button" class="btn-circle" data-act="dp-shift" data-n="1" aria-label="後一天">${icon.chevR}</button>
        </div>
        <span class="dp-stats">已排 ${esc(fmtDuration(planned))}${unplaced ? `｜${unplaced} 件未排` : ''}</span>
        ${gcalBarHTML()}
      </div>
    </div>`;

  main.innerHTML = `<div class="day-view">
    ${head}
    <div class="day-layout">
      <aside class="day-tray card" aria-label="這天的任務">
        <h2 class="tray-head">這天的任務</h2>
        <div class="tray-list">${trayBody}</div>
        <div class="tray-foot">
          ${otherOptions}
          <div class="tray-add"><span class="add-mark">${icon.plus}</span>
            <input type="text" class="bare" placeholder="自由時段，例如午餐" enterkeyhint="done" data-enter="dp-free" data-keep="dp-free" aria-label="新增自由時段" maxlength="300"></div>
        </div>
      </aside>
      <section class="day-main card" aria-label="10 分鐘時間表">
        ${stripHTML(blocks, now, 'dp-jump')}
        ${banner}
        <div class="dp-scroll">
          <div class="dp-colhead"><span class="dp-corner"></span><div class="dp-cols">${colHead}</div></div>
          <div class="dp-body">
            <div class="dp-hours">${hours}</div>
            <div class="dp-grid ${planner.brush ? 'armed' : ''}" data-act="dp-grid" style="--rh:var(--dp-row)">
              ${segs}${nowLine}<div class="dp-preview"></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>`;

  const scroller = main.querySelector('.dp-scroll');
  if (planner.scrollTop == null) {
    const target = isToday ? Math.max(0, now - 60) : blocks.length ? blocks[0].start - 30 : 8 * 60;
    scroller.scrollTop = (Math.max(0, target) / 60) * rowHeight(main);
  } else scroller.scrollTop = planner.scrollTop;
}

const rowHeight = (root = document) => (root.querySelector('.dp-grid')?.offsetHeight || 24 * 34) / 24;

function brushLabel(b) {
  if (b.taskId) {
    const t = getTask(b.taskId);
    return t?.subtasks.find((s) => s.id === b.subId)?.title || t?.title || '未命名任務';
  }
  return b.title;
}

/* ---------- Creating and editing blocks ---------- */

function addBlock(start, end, brush) {
  const fields = brush.taskId
    ? { taskId: brush.taskId, subId: brush.subId || '', title: brushLabel(brush) }
    : { title: brush.title || '' };
  const block = makeBlock({ date: planDate(), start, end: Math.min(end, DAY_MINUTES), ...fields });
  commit((s) => s.blocks.push(block));
  return block;
}

export function openBlock(id, { isNew = false } = {}) {
  const b = state.blocks.find((x) => x.id === id);
  if (!b) return;
  const info = blockInfo(b);
  const linked = b.taskId ? getTask(b.taskId) : null;
  const titleRow = linked
    ? `<div class="row form-row"><span class="form-label bs-linked">${esc(info.title)}</span>
        <button type="button" class="text-btn" data-act="open-task" data-id="${esc(linked.id)}">開啟任務</button></div>`
    : `<div class="row form-row"><input id="bs-title" type="text" class="bare" value="${esc(b.title)}" placeholder="時段名稱" data-in="bs-title" data-id="${esc(id)}" aria-label="時段名稱" maxlength="300"></div>`;
  const taskDone = linked && percent(linked) >= 100;
  openPanel(`${fmtMinute(b.start)}–${fmtMinute(b.end)}`, `
    <div class="card">${titleRow}</div>
    <div class="card">
      <label class="row form-row"><span class="form-label">開始</span><input id="bs-start" type="time" step="600" class="field-date" value="${fmtMinute(b.start)}" data-ch="bs-time" data-id="${esc(id)}"></label>
      <label class="row form-row"><span class="form-label">結束</span><input id="bs-end" type="time" step="600" class="field-date" value="${b.end >= DAY_MINUTES ? '23:59' : fmtMinute(b.end)}" data-ch="bs-time" data-id="${esc(id)}"></label>
      <label class="row form-row"><span class="form-label">這段時間已完成</span><input type="checkbox" class="switch" data-ch="bs-done" data-id="${esc(id)}" ${b.done ? 'checked' : ''}></label>
    </div>
    ${linked ? `<p class="group-foot">這裡只安排當天的時間，不會改變任務在週、月計畫上的日期。</p>` : `
    <h3 class="group-head in-sheet">顏色</h3>
    <div class="card pad">${colorRowHTML({ value: b.color, target: 'block', id, auto: true })}</div>`}
    <h3 class="group-head in-sheet">備註</h3>
    <div class="card"><div class="row form-row notes-row"><textarea class="notes-input" rows="2" placeholder="這段時間要做什麼" data-in="bs-notes" data-id="${esc(id)}" aria-label="備註">${esc(b.notes)}</textarea></div></div>
    <div class="card bs-actions">
      ${linked && !taskDone ? `<button type="button" class="row form-row link-row" data-act="bs-finish-task" data-id="${esc(id)}">把整個任務標為完成</button>` : ''}
      ${gcalConnected() ? `<button type="button" class="row form-row link-row" data-act="bs-to-gcal" data-id="${esc(id)}">移到 Google 日曆</button>` : ''}
      <button type="button" class="row form-row link-row destructive" data-act="bs-delete" data-id="${esc(id)}">刪除這個時段</button>
    </div>`, {
    onClose: () => {
      const cur = state.blocks.find((x) => x.id === id);
      if (isNew && cur && !cur.taskId && !cur.title.trim()) {
        commit((s) => {
          s.blocks = s.blocks.filter((x) => x.id !== id);
        });
      }
    },
  });
  if (isNew && !linked) document.getElementById('bs-title')?.focus();
}

const updateBlock = (id, fn) => {
  const b = state.blocks.find((x) => x.id === id);
  if (!b) return;
  commit(() => {
    fn(b);
    b.updatedAt = Date.now();
  });
};

/* ---------- Actions ---------- */

function fileBlockPanel(id) {
  const b = state.blocks.find((x) => x.id === id);
  if (!b) return;
  const title = b.title || '未命名時段';
  const tasksOf = (pid) => state.tasks.filter((t) => !t.archivedAt && percent(t) < 100 && t.projectId === pid);
  const sections = state.projects.map((p) => {
    const tasks = tasksOf(p.id).map((t) => `<button type="button" class="row form-row link-row file-task" data-act="dp-file-to" data-block="${esc(id)}" data-task="${esc(t.id)}">
        <span class="file-sub">成為「${esc(t.title || '未命名任務')}」的子任務</span></button>`).join('');
    return `<h3 class="group-head in-sheet"><i class="dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</h3>
      <div class="card">
        <button type="button" class="row form-row link-row" data-act="dp-file-to" data-block="${esc(id)}" data-project="${esc(p.id)}">新增為這個專案的任務</button>
        ${tasks}
      </div>`;
  }).join('');
  openPanel(`把「${title}」加入專案`, `<p class="group-foot">時段會連到新的任務或子任務，日期是 ${esc(b.date)}。時間表上的位置不變。</p>${sections}`);
}

Object.assign(actions, {
  'dp-open': (el) => openBlock(el.dataset.block),
  'dp-file': (el) => fileBlockPanel(el.dataset.block),
  'dp-file-to': (el) => {
    const b = state.blocks.find((x) => x.id === el.dataset.block);
    if (!b) return;
    const title = b.title || '未命名時段';
    closeSheet();
    if (el.dataset.task) {
      const t = getTask(el.dataset.task);
      if (!t) return;
      commit(() => {
        const sub = makeSub({ title, start: b.date, end: b.date });
        t.subtasks.push(sub);
        fitParentToSubs(t);
        touch(t);
        Object.assign(b, { taskId: t.id, subId: sub.id, color: '', trayHidden: false, updatedAt: Date.now() });
      }, { undo: `已加入「${t.title || '未命名任務'}」的子任務` });
      return;
    }
    const project = getProject(el.dataset.project);
    commit((s) => {
      const t = makeTask({ title, projectId: project?.id || '', start: b.date, end: b.date });
      s.tasks.push(t);
      Object.assign(b, { taskId: t.id, subId: '', color: '', trayHidden: false, updatedAt: Date.now() });
    }, { undo: `已加入「${project?.name || '未分類'}」` });
  },
  'dp-hide': (el) => updateBlock(el.dataset.block, (b) => (b.trayHidden = !b.trayHidden)),
  'dp-show-hidden': () => {
    planner.showHidden = !planner.showHidden;
    requestRender();
  },
  'dp-shift': (el) => {
    focusDate.plan = addDays(planDate(), Number(el.dataset.n));
    requestRender();
  },
  'dp-arm': (el, e) => {
    if (e.target.closest('button') !== null && e.target.closest('button') !== el) return;
    const { id, sub } = el.dataset;
    const same = planner.brush?.taskId === id && (planner.brush.subId || '') === (sub || '');
    planner.brush = same ? null : { taskId: id, subId: sub || '' };
    requestRender();
  },
  'dp-disarm': () => {
    planner.brush = null;
    requestRender();
  },
  'dp-grid': (el, e) => {
    const start = minuteAt(e.clientX, e.clientY);
    if (planner.brush) {
      addBlock(start, start + DEFAULT_TAP_MIN, planner.brush);
      planner.brush = null;
      requestRender();
      return;
    }
    const b = addBlock(start, start + DEFAULT_TAP_MIN, { title: '' });
    openBlock(b.id, { isNew: true });
  },
  'dp-jump': (el, e) => {
    const rect = el.getBoundingClientRect();
    const minute = ((e.clientX - rect.left) / rect.width) * DAY_MINUTES;
    const scroller = document.querySelector('.dp-scroll');
    if (scroller) scroller.scrollTo({ top: (Math.max(0, minute - 30) / 60) * rowHeight(), behavior: 'smooth' });
  },
  'bs-delete': (el) => {
    const { id } = el.dataset;
    closeSheet();
    commit((s) => {
      s.blocks = s.blocks.filter((x) => x.id !== id);
      s.deleted[id] = Date.now();
    }, { undo: '已刪除時段' });
  },
  // The block becomes a Google Calendar event at the same time; the local block goes away.
  'bs-to-gcal': async (el) => {
    const b = state.blocks.find((x) => x.id === el.dataset.id);
    if (!b) return;
    closeSheet();
    const e = await gcalCreate({ title: blockInfo(b).title, iso: b.date, start: b.start, end: b.end, notes: b.notes });
    if (!e) return;
    commit((s) => {
      s.blocks = s.blocks.filter((x) => x.id !== b.id);
      s.deleted[b.id] = Date.now();
    });
    toast('已移到 Google 日曆'); // no undo: the event already exists on Google's side
  },
  'bs-finish-task': (el) => {
    const b = state.blocks.find((x) => x.id === el.dataset.id);
    const t = b && getTask(b.taskId);
    if (!t) return;
    closeSheet();
    commit(() => {
      setDone(t, true);
      touch(t);
      b.done = true;
      b.updatedAt = Date.now();
    }, { undo: `已完成「${t.title || '未命名任務'}」` });
  },
});

Object.assign(changes, {
  'dp-date': (el) => {
    if (!el.value) return;
    focusDate.plan = el.value;
    requestRender();
  },
  'dp-other': (el) => {
    if (!el.value) return;
    planner.brush = { taskId: el.value, subId: '' };
    requestRender();
  },
  'bs-done': (el) => updateBlock(el.dataset.id, (b) => (b.done = el.checked)),
  'bs-time': (el) => {
    const startEl = document.getElementById('bs-start');
    const endEl = document.getElementById('bs-end');
    const start = parseMinute(startEl.value);
    const end = parseMinute(endEl.value);
    if (start == null || end == null) return;
    updateBlock(el.dataset.id, (b) => {
      const duration = b.end - b.start;
      b.start = Math.min(snapMinute(start), DAY_MINUTES - SLOT);
      // 23:59 is how a time field says "until midnight".
      const wanted = end >= DAY_MINUTES - SLOT + 9 ? DAY_MINUTES : snapMinute(end);
      if (el === startEl && wanted <= b.start) b.end = Math.min(DAY_MINUTES, b.start + duration);
      else b.end = Math.max(wanted, b.start + SLOT);
      startEl.value = fmtMinute(b.start);
      endEl.value = b.end >= DAY_MINUTES ? '23:59' : fmtMinute(b.end);
      const title = document.querySelector('#sheet .sheet-title');
      if (title) title.textContent = `${fmtMinute(b.start)}–${fmtMinute(b.end)}`;
    });
  },
});

Object.assign(inputs, {
  'bs-title': (el) => updateBlock(el.dataset.id, (b) => (b.title = el.value)),
  'bs-notes': (el) => updateBlock(el.dataset.id, (b) => (b.notes = el.value)),
});

Object.assign(enters, {
  'dp-free': (el) => {
    const title = el.value.trim();
    if (!title) return;
    el.value = '';
    planner.brush = { title };
    requestRender();
  },
});

/* ---------- Gestures: drag a tray task in, paint a range, move and resize blocks ---------- */

let g = null;
let suppressUntil = 0;
export const plannerSuppressClick = () => performance.now() < suppressUntil;

function minuteAt(x, y) {
  const grid = document.querySelector('.dp-grid');
  const r = grid.getBoundingClientRect();
  const row = Math.max(0, Math.min(23, Math.floor((y - r.top) / (r.height / 24))));
  const col = Math.max(0, Math.min(5, Math.floor((x - r.left) / (r.width / 6))));
  return row * 60 + col * SLOT;
}

function overGrid(x, y) {
  const r = document.querySelector('.dp-scroll').getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function rangeFor(gesture) {
  const cell = minuteAt(gesture.x, gesture.y);
  if (gesture.mode === 'move') {
    const start = Math.max(0, Math.min(cell - gesture.grab, DAY_MINUTES - gesture.duration));
    return { start, end: start + gesture.duration };
  }
  if (gesture.mode === 'resize') return { start: gesture.start, end: Math.max(gesture.start + SLOT, cell + SLOT) };
  if (gesture.mode === 'paint') return { start: Math.min(gesture.anchor, cell), end: Math.max(gesture.anchor, cell) + SLOT };
  const start = Math.min(cell, DAY_MINUTES - DEFAULT_DROP_MIN);
  return { start, end: start + DEFAULT_DROP_MIN };
}

function begin() {
  g.active = true;
  gantt.dragging = true; // holds back re-renders until the gesture ends
  document.body.classList.add('is-dragging');
  if (g.pointerType !== 'mouse') navigator.vibrate?.(8);
  if (g.blockId) {
    document.querySelectorAll(`[data-block="${CSS.escape(g.blockId)}"]`).forEach((el) => el.classList.add('ghost'));
  }
  if (g.gev) document.querySelectorAll(`.dp-seg[data-gev="${CSS.escape(g.gev.key)}"]`).forEach((el) => el.classList.add('ghost'));
  g.tip = document.createElement('div');
  g.tip.className = 'drag-tip';
  document.body.append(g.tip);
  g.raf = requestAnimationFrame(tick);
}

function tick() {
  if (!g?.active) return;
  const rect = g.scroller.getBoundingClientRect();
  if (g.y < rect.top + EDGE_ZONE) g.scroller.scrollTop -= 8;
  else if (g.y > rect.bottom - EDGE_ZONE) g.scroller.scrollTop += 8;

  const over = g.mode !== 'place' || overGrid(g.x, g.y);
  const range = over ? rangeFor(g) : null;
  const key = range ? `${range.start}-${range.end}` : '';
  if (key !== g.lastKey) {
    g.lastKey = key;
    const host = document.querySelector('.dp-preview');
    host.innerHTML = range
      ? segmentsHTML(makeBlock({ ...range, taskId: g.brush?.taskId || g.block?.taskId || '', subId: g.brush?.subId || g.block?.subId || '', title: g.block?.title || g.brush?.title || '', color: g.block?.color || '' }), 0, 1, { preview: true })
      : '';
  }
  g.tip.textContent = range ? `${fmtMinute(range.start)}–${fmtMinute(range.end)}` : g.label || '拖到時間表上';
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

  const over = d.mode !== 'place' || overGrid(d.x, d.y);
  if (!apply || !over) {
    requestRender();
    return;
  }
  const range = rangeFor(d);
  if (d.gev) {
    gcalMove(d.gev, planDate(), range.start, range.end);
    return;
  }
  if (d.blockId) {
    updateBlock(d.blockId, (b) => {
      b.start = range.start;
      b.end = range.end;
    });
    return;
  }
  const brush = d.brush || planner.brush;
  planner.brush = null;
  if (brush) {
    addBlock(range.start, range.end, brush);
    requestRender();
    return;
  }
  const b = addBlock(range.start, range.end, { title: '' });
  openBlock(b.id, { isNew: true });
}

export function initPlannerGestures() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || g || !e.target.closest?.('.day-view')) return;
    const seg = e.target.closest('.dp-seg[data-block]');
    const gseg = e.target.closest('.dp-seg[data-gev]');
    const tray = e.target.closest('[data-tray]');
    const grid = e.target.closest('.dp-grid');
    if (!seg && !grid && (!tray || e.target.closest('button'))) return;
    const ev = gseg ? gcalEventsOn(planDate()).find((x) => x.key === gseg.dataset.gev) : null;
    if (gseg && !gcalDraggable(ev)) {
      // Read-only events only open on tap. A drag off one must not land as a tap on the grid.
      const sx = e.clientX;
      const sy = e.clientY;
      document.addEventListener('pointerup', (u) => {
        if (Math.hypot(u.clientX - sx, u.clientY - sy) > MOUSE_SLOP) suppressUntil = performance.now() + 350;
      }, { once: true });
      return;
    }

    const scroller = document.querySelector('.dp-scroll');
    const base = {
      scroller, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      pointerId: e.pointerId, pointerType: e.pointerType, active: false, timer: 0, lastKey: null,
    };
    if (ev) {
      g = {
        ...base, mode: e.target.closest('.dp-h') ? 'resize' : 'move', gev: ev, block: { title: ev.title, color: ev.soft },
        start: ev.start, duration: ev.end - ev.start, grab: minuteAt(e.clientX, e.clientY) - ev.start,
      };
    } else if (seg) {
      const block = state.blocks.find((b) => b.id === seg.dataset.block);
      if (!block) return;
      const resize = !!e.target.closest('.dp-h');
      g = {
        ...base, mode: resize ? 'resize' : 'move', blockId: block.id, block,
        start: block.start, duration: block.end - block.start, grab: minuteAt(e.clientX, e.clientY) - block.start,
      };
    } else if (tray) {
      const brush = { taskId: tray.dataset.id, subId: tray.dataset.sub || '' };
      g = { ...base, mode: 'place', brush, label: brushLabel(brush) };
    } else {
      g = { ...base, mode: 'paint', anchor: minuteAt(e.clientX, e.clientY) };
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
    } else if (moved > TOUCH_SLOP) finish(false); // a finger moving early means scrolling
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
    if (e.target.closest?.('.dp-grid, [data-tray]')) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && g?.active) finish(false);
  });
}

export function planToday() {
  focusDate.plan = todayStr();
  planner.scrollTop = null;
  planner.renderedFor = null;
  requestRender();
}
