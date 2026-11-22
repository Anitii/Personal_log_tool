// Month calendar: one continuous column of weeks that scrolls straight across month
// boundaries. A task with dated subtasks is drawn as those subtasks, the task acting as their
// category (its color, its importance); a task without them is drawn as itself.
import {
  FREE_BLOCK_COLOR, WEEKDAYS, fmtMD, fmtRange, fromDay, inkOn, isActiveOn, isDone, isImportant, layoutWeek, mondayOf, occursOn,
  subDoneOn, subFraction, subsForDay, toDay, todayStr, toggleFocusDay, toggleSubOn, weekNumber, weekdayIdx,
} from './core.js';
import { onPinch } from './pinch.js';
import { addTask, commit, focusDate, getTask, prefs, setPref, state, taskColor, touch, visibleTasks } from './store.js';
import { actions, esc, icon } from './ui.js';
import { closeSheet, openPanel, openTask } from './sheet.js';
import { chipsHTML, headerHTML, offerFinish, planSegHTML } from './views.js';
import { gcalBarHTML, gcalConnected, gcalEnsure, gcalEventsBetween, gcalEventsOn } from './gcal.js';

const LANE_H = 21;
const DAY_HEAD_H = 28;
const MORE_H = 15;
const MIN_ROW_H = 92;
const SPREAD = 26; // weeks rendered on each side of the anchor
const EDGE = 4; // weeks from either end that trigger rendering more

// The span zooms with a pinch: how many weeks fill the screen (a month is about five).
const SPANS = ['month', 3, 2];
const SPAN_LABEL = { month: '月', 3: '3 週', 2: '2 週' };
const ROWS = { month: 5, 3: 3, 2: 2 };

// top: the Monday of the week at the top of the screen; offset: pixels scrolled into it.
// target: where a smooth scroll is heading, so repeated taps on ‹ › add up.
const calendar = { top: null, offset: 0, from: 0, weeks: 0, rowH: 0, target: null };
let requestRender = () => {};
export const setCalendarRender = (fn) => (requestRender = fn);

const span = () => (SPANS.includes(prefs.calSpan) ? prefs.calSpan : 'month');
// The month being looked at: the one under the middle of the screen (in a month view, the
// first row usually still belongs to the month before).
const monthLabel = (top) => {
  const [y, m] = fromDay(top + Math.floor(ROWS[span()] / 2) * 7 + 3).split('-').map(Number);
  return `${y} 年 ${m} 月`;
};

// The week holding the 1st of the month `day` falls in (a month view starts there).
const monthStartWeek = (day) => mondayOf(toDay(`${fromDay(day).slice(0, 7)}-01`));

// Zooming keeps the place: into weeks it starts at this week if it was on screen; out to a
// month it starts at the month being looked at.
function setSpan(next) {
  const prev = span();
  if (next === prev) return;
  if (calendar.top != null) {
    const top = calendar.top;
    const thisWeek = mondayOf(toDay(todayStr()));
    if (next === 'month') calendar.top = monthStartWeek(top + Math.floor(ROWS[prev] / 2) * 7 + 3);
    else if (thisWeek >= top && thisWeek < top + ROWS[prev] * 7) calendar.top = thisWeek;
    calendar.offset = 0;
    calendar.target = null;
  }
  setPref({ calSpan: next });
}

let pinchAcc = 1;
let pinchQuietUntil = 0;
onPinch('.cal-view .cal-scroll', (f) => {
  if (performance.now() < pinchQuietUntil) return;
  pinchAcc *= f;
  const i = SPANS.indexOf(span());
  let next = null;
  if (pinchAcc > 1.3 && i < SPANS.length - 1) next = SPANS[i + 1];
  else if (pinchAcc < 0.77 && i > 0) next = SPANS[i - 1];
  else if (pinchAcc > 1.3 || pinchAcc < 0.77) pinchAcc = 1;
  if (next == null) return;
  pinchAcc = 1;
  pinchQuietUntil = performance.now() + 350; // one pinch, one step
  setSpan(next);
});

/* ---------- What the calendar draws ---------- */

const dated = (from, to) => !!from && !!to && to >= from;

// One item per bar. Subtasks with their own dates stand for their task; repeating ones span
// their range. `cat` is the task they belong to: it gives color and importance.
function calItems(tasks) {
  const out = [];
  for (const t of tasks) {
    const color = taskColor(t) || FREE_BLOCK_COLOR;
    const common = { cat: t, color, priority: t.priority, focusDays: t.focusDays, archived: !!t.archivedAt };
    const subs = t.subtasks.filter((s) => (s.repeat ? dated(s.start || t.start, s.end || t.end) : dated(s.start, s.end)));
    if (subs.length) {
      subs.forEach((s, i) => out.push({
        ...common,
        id: `${t.id}:${s.id}`,
        sub: s,
        title: s.title || '未命名子任務',
        start: s.start || t.start,
        end: s.end || t.end,
        order: t.order + (i + 1) / 1000,
        done: isDone(t) || (s.repeat ? subFraction(s, t) >= 1 : s.done),
      }));
    } else if (dated(t.start, t.end)) {
      out.push({ ...common, id: t.id, title: t.title || '未命名', start: t.start, end: t.end, order: t.order, done: isDone(t) });
    }
  }
  return out;
}

// One bar becomes several runs when its importance changes partway through the week.
function barRuns(bar, monday) {
  const runs = [];
  for (let d = bar.from; d <= bar.to; d++) {
    const important = isImportant(bar.task, fromDay(monday + d));
    const last = runs[runs.length - 1];
    if (last && last.important === important) last.to = d;
    else runs.push({ from: d, to: d, important });
  }
  return runs;
}

const clock = (ms) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Google Calendar events stand in as items so they share the week's lanes.
const eventItems = (monday) => gcalEventsBetween(fromDay(monday), fromDay(monday + 6)).map((e) => ({
  id: `g:${e.key}`, title: e.title, start: e.from, end: e.to, priority: 0, focusDays: [], order: e.allDay ? 0 : e.startMs, gev: e,
}));

function eventBarHTML(bar, monday) {
  const e = bar.task.gev;
  const realStart = toDay(e.from) === monday + bar.from;
  const realEnd = toDay(e.to) === monday + bar.to;
  const cls = ['cal-bar strong gev', realStart ? 'round-l' : '', realEnd ? 'round-r' : ''].join(' ');
  const style = `left:calc(${(bar.from / 7) * 100}% + 2px);width:calc(${((bar.to - bar.from + 1) / 7) * 100}% - 4px);top:${bar.lane * LANE_H}px;--st:${esc(e.soft)};--ink:${e.ink};--gc:${esc(e.color)}`;
  const time = !e.allDay && realStart ? `<small>${clock(e.startMs)}</small> ` : '';
  return `<div class="${cls}" style="${style}"><span>${time}${esc(e.title) || '（沒有標題）'}</span></div>`;
}

function barHTML(bar, monday) {
  const it = bar.task;
  if (it.gev) return eventBarHTML(bar, monday);
  const realStart = toDay(it.start) === monday + bar.from;
  const realEnd = toDay(it.end) === monday + bar.to;
  const runs = barRuns(bar, monday);
  return runs.map((run, i) => {
    const dim = (prefs.calDim && !run.important) || it.done || it.archived;
    const cls = [
      'cal-bar',
      dim ? 'dim' : 'strong',
      it.done ? 'is-done' : '',
      it.sub ? 'is-sub' : '',
      it.sub?.repeat ? 'is-repeat' : '',
      i === 0 && realStart ? 'round-l' : '',
      i === runs.length - 1 && realEnd ? 'round-r' : '',
    ].join(' ');
    const label = i === 0 || run.important;
    const gapL = i === 0 ? 2 : 0; // runs of one bar touch, so only its outer ends get a gap
    const gapR = i === runs.length - 1 ? 2 : 0;
    const style = `left:calc(${(run.from / 7) * 100}% + ${gapL}px);width:calc(${((run.to - run.from + 1) / 7) * 100}% - ${gapL + gapR}px);top:${bar.lane * LANE_H}px;--st:${esc(it.color)};--ink:${inkOn(it.color)}`;
    const text = `${run.important ? '★ ' : ''}${it.sub?.repeat ? '↻ ' : ''}${esc(it.title)}`;
    return `<div class="${cls}" style="${style}">${label ? `<span>${text}</span>` : ''}</div>`;
  }).join('');
}

/* ---------- Rendering ---------- */

function weekHTML(monday, items, today, lanes, rowH) {
  const bars = layoutWeek([...items, ...eventItems(monday)], monday);
  const visible = bars.filter((b) => b.lane < lanes);
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const n = monday + i;
    const iso = fromDay(n);
    const month = Number(iso.slice(5, 7));
    const first = iso.endsWith('-01');
    const hidden = bars.filter((b) => b.lane >= lanes && b.from <= i && i <= b.to).length;
    cells.push(`<button type="button" class="cal-day ${month % 2 ? 'm-odd' : 'm-even'} ${first ? 'm-first' : ''} ${iso === today ? 'is-today' : ''} ${i >= 5 ? 'weekend' : ''}" data-act="cal-day" data-date="${iso}" aria-label="${iso}">
      <b>${first ? `${month} 月 1` : Number(iso.slice(8))}</b>
      ${hidden ? `<small class="cal-more">+${hidden}</small>` : ''}
    </button>`);
  }
  return `<div class="cal-week" style="height:${rowH}px" data-monday="${monday}">
    <div class="cal-weeknum">${weekNumber(monday, state.settings)}</div>
    <div class="cal-week-body">
      <div class="cal-cells">${cells.join('')}</div>
      <div class="cal-bars" aria-hidden="true">${visible.map((b) => barHTML(b, monday)).join('')}</div>
    </div>
  </div>`;
}

export function renderCalendar(main) {
  const today = todayStr();
  const todayN = toDay(today);
  if (calendar.top == null) calendar.top = span() === 'month' ? monthStartWeek(todayN) : mondayOf(todayN);
  const avail = (main.clientHeight || innerHeight) - (innerWidth < 768 ? 200 : 150);
  const rowH = Math.max(MIN_ROW_H, Math.floor(avail / ROWS[span()]));
  const lanes = Math.max(2, Math.floor((rowH - DAY_HEAD_H - MORE_H) / LANE_H));

  // Keep the rendered weeks around the anchor; scrolling near an end renders more.
  if (!calendar.weeks || calendar.top < calendar.from + EDGE * 7 || calendar.top > calendar.from + (calendar.weeks - EDGE - ROWS[span()]) * 7) {
    calendar.from = calendar.top - SPREAD * 7;
    calendar.weeks = SPREAD * 2 + 1;
  }
  calendar.rowH = rowH;
  const first = calendar.from;
  const last = first + calendar.weeks * 7 - 1;
  const items = calItems(visibleTasks(today, { archived: true })); // the calendar is also the record of what happened
  gcalEnsure(fromDay(calendar.top), fromDay(calendar.top + ROWS[span()] * 7 + 6));

  const weekRows = Array.from({ length: calendar.weeks }, (_, i) => weekHTML(first + i * 7, items, today, lanes, rowH)).join('');
  const marked = items.some((it) => isActiveOn(it, today) && isImportant(it, today));
  const hint = !marked && prefs.calDim && state.tasks.length ? '｜點日期把任務加星號' : '';

  main.innerHTML = `<div class="cal-view">
    <div class="g-head-wrap">
      ${headerHTML('計畫', `月曆｜上下捲動跨月，雙指縮放${hint}`, '<button type="button" class="text-btn today-btn" data-act="plan-today">今天</button>')}
      <div class="g-controls">
        ${planSegHTML()}
        <div class="tb-nav">
          <button type="button" class="btn-circle" data-act="cal-shift" data-n="-1" aria-label="往前">${icon.back}</button>
          <b id="cal-title">${monthLabel(calendar.top)}</b>
          <button type="button" class="btn-circle" data-act="cal-shift" data-n="1" aria-label="往後">${icon.chevR}</button>
        </div>
        <div class="seg span-seg" role="group" aria-label="範圍">${SPANS.map((k) => `<button type="button" class="${span() === k ? 'on' : ''}" data-act="cal-span" data-v="${k}" aria-pressed="${span() === k}">${SPAN_LABEL[k]}</button>`).join('')}</div>
        ${chipsHTML()}
        <button type="button" class="chip tb-toggle ${prefs.calDim ? 'on' : ''}" data-act="cal-dim" aria-pressed="${prefs.calDim}">淡化不重要</button>
        ${gcalBarHTML()}
      </div>
    </div>
    <div class="cal-scroll">
      <div class="cal-head"><span class="cal-weeknum">週</span><div class="cal-head-days">${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}</div></div>
      <div class="cal-weeks" data-range="${fromDay(first)}–${fromDay(last)}">${weekRows}</div>
    </div>
  </div>`;

  const scroller = main.querySelector('.cal-scroll');
  scroller.scrollTop = ((calendar.top - first) / 7) * rowH + calendar.offset;
  scroller.addEventListener('scroll', onScroll, { passive: true });
}

let fetchTimer = 0;
let extending = false;
function onScroll(e) {
  const el = e.currentTarget;
  const { rowH, from, weeks } = calendar;
  if (!rowH) return;
  const idx = Math.max(0, Math.min(weeks - 1, Math.floor(el.scrollTop / rowH)));
  calendar.top = from + idx * 7;
  calendar.offset = el.scrollTop - idx * rowH;
  if (calendar.target != null && Math.abs(el.scrollTop - ((calendar.target - from) / 7) * rowH) < 2) calendar.target = null;
  const title = document.getElementById('cal-title');
  if (title) title.textContent = monthLabel(calendar.top + (calendar.offset > rowH / 2 ? 7 : 0));
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => gcalEnsure(fromDay(calendar.top), fromDay(calendar.top + ROWS[span()] * 7 + 6)), 250);
  if (extending) return;
  if (idx < EDGE || idx > weeks - EDGE - ROWS[span()]) {
    extending = true;
    requestAnimationFrame(() => {
      requestRender();
      extending = false;
    });
  }
}

// Move the view so `monday` is the top week, smoothly when it is already rendered.
function scrollToWeek(monday) {
  const scroller = document.querySelector('.cal-scroll');
  const inRange = monday >= calendar.from && monday <= calendar.from + (calendar.weeks - ROWS[span()]) * 7;
  if (scroller && inRange) {
    calendar.target = monday;
    scroller.scrollTo({ top: ((monday - calendar.from) / 7) * calendar.rowH, behavior: 'smooth' });
    return;
  }
  calendar.target = null;
  calendar.top = monday;
  calendar.offset = 0;
  requestRender();
}

/* ---------- Day panel ---------- */

function dayPanel(iso) {
  const day = toDay(iso);
  const today = todayStr();
  const list = state.tasks
    .filter((t) => isActiveOn(t, iso))
    .sort((a, b) => Number(isImportant(b, iso)) - Number(isImportant(a, iso)) || a.order - b.order);
  const rows = list.map((t) => {
    const important = isImportant(t, iso);
    const color = taskColor(t) || FREE_BLOCK_COLOR;
    const subs = subsForDay(t, iso, today, { withDone: true }).filter((s) => s.start || s.repeat);
    const subRows = subs.map((s) => {
      const daily = !!s.repeat && occursOn(s, iso, t);
      const done = daily ? subDoneOn(s, iso) : s.done;
      return `<div class="row day-sub ${done ? 'is-done' : ''}">
        <button type="button" class="check small ${done ? 'on' : ''}" data-act="cal-sub" data-id="${esc(t.id)}" data-sub="${esc(s.id)}" data-date="${iso}" ${daily ? 'data-daily="1"' : ''} role="checkbox" aria-checked="${done}" aria-label="完成：${esc(s.title)}"></button>
        <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}">
          <span class="row-title">${s.repeat ? '<span class="repeat-mark">↻</span> ' : ''}${esc(s.title) || '<em>未命名子任務</em>'}</span>
          <span class="row-meta"><span>${esc(s.repeat ? '重複' : fmtRange(s.start, s.end))}</span></span>
        </button>
      </div>`;
    }).join('');
    return `<div class="row day-row ${isDone(t) ? 'is-done' : ''}">
      <button type="button" class="star-btn ${important ? 'on' : ''}" data-act="cal-star" data-id="${esc(t.id)}" data-date="${iso}" ${t.priority === 3 ? 'disabled title="優先度為高的任務每天都算最重要"' : ''} aria-pressed="${important}" aria-label="標為這天最重要">${important ? icon.starOn : icon.star}</button>
      <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}">
        <span class="row-title"><i class="dot" style="background:${esc(color)}"></i> ${esc(t.title) || '<em>未命名任務</em>'}</span>
        <span class="row-meta"><span>${esc(fmtRange(t.start, t.end))}</span>${t.priority === 3 ? '<span>優先度高</span>' : ''}</span>
      </button>
    </div>${subRows}`;
  }).join('');
  const [, m, d] = iso.split('-').map(Number);
  const fmt = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  const events = gcalConnected() ? `<h3 class="group-head in-sheet">Google 日曆</h3>
    <div class="card">${gcalEventsOn(iso).map((e) => `<button type="button" class="row form-row link-row gev-row" data-act="gev-open" data-gev="${esc(e.key)}" data-date="${iso}">
        <span class="row-title"><i class="dot" style="background:${esc(e.color)}"></i> ${esc(e.title) || '（沒有標題）'}</span>
        <span class="form-value">${e.allDay ? '整天' : `${fmt(e.start)}–${fmt(e.end)}`}</span></button>`).join('')}
      <button type="button" class="row form-row link-row" data-act="gev-new" data-date="${iso}">新增 Google 行程</button>
    </div>` : '';
  openPanel(`${m} 月 ${d} 日 星期${WEEKDAYS[weekdayIdx(day)]}`, `
    <div class="card">${rows || '<p class="tray-empty">這天沒有任務。</p>'}</div>
    <p class="group-foot">任務底下是它在這天的子任務。星號只影響這一天；要讓任務每天都算最重要，把優先度設為「高」。</p>
    ${events}
    <div class="card panel-actions">
      <button type="button" class="row form-row link-row" data-act="cal-open-day" data-date="${iso}">開啟這天的時間表</button>
      <button type="button" class="row form-row link-row" data-act="cal-open-diary" data-date="${iso}">寫這天的日記</button>
      <button type="button" class="row form-row link-row" data-act="cal-new-task" data-date="${iso}">在這天新增任務</button>
    </div>`);
}

Object.assign(actions, {
  'cal-dim': () => setPref({ calDim: !prefs.calDim }),
  'cal-shift': (el) => {
    const n = Number(el.dataset.n);
    const top = calendar.target ?? calendar.top ?? mondayOf(toDay(todayStr()));
    if (span() === 'month') {
      // To the first week of the previous or next month.
      const [y, m] = fromDay(top + Math.floor(ROWS[span()] / 2) * 7 + 3).split('-').map(Number);
      const next = new Date(y, m - 1 + n, 1);
      const iso = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
      scrollToWeek(mondayOf(toDay(iso)));
    } else scrollToWeek(top + 7 * n * span());
  },
  'cal-span': (el) => setSpan(el.dataset.v === 'month' ? 'month' : Number(el.dataset.v)),
  'cal-day': (el) => dayPanel(el.dataset.date),
  'cal-star': (el) => {
    const t = getTask(el.dataset.id);
    if (!t) return;
    commit(() => {
      toggleFocusDay(t, el.dataset.date);
      touch(t);
    });
    dayPanel(el.dataset.date);
  },
  'cal-sub': (el) => {
    const t = getTask(el.dataset.id);
    const s = t?.subtasks.find((x) => x.id === el.dataset.sub);
    if (!s) return;
    commit(() => {
      if (el.dataset.daily) toggleSubOn(s, el.dataset.date);
      else s.done = !s.done;
      touch(t);
    });
    dayPanel(el.dataset.date);
    offerFinish(t);
  },
  'cal-open-day': (el) => {
    closeSheet();
    focusDate.plan = el.dataset.date;
    setPref({ view: 'gantt', plan: 'day' });
  },
  'cal-open-diary': (el) => {
    closeSheet();
    focusDate.diary = el.dataset.date;
    setPref({ view: 'diary' });
  },
  'cal-new-task': (el) => {
    const t = addTask({ start: el.dataset.date, end: el.dataset.date });
    openTask(t.id, { isNew: true });
  },
});

export function calendarToday() {
  const today = toDay(todayStr());
  scrollToWeek(span() === 'month' ? monthStartWeek(today) : mondayOf(today));
}
