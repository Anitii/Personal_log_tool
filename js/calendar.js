// Month calendar. Each day can mark its most important tasks; the rest fade by default.
import {
  FREE_BLOCK_COLOR, WEEKDAYS, addMonths, fmtMD, fmtRange, fromDay, inkOn, isActiveOn, isImportant, layoutWeek, mondayOf, monthWeeks, percent,
  toDay, todayStr, toggleFocusDay, weekNumber, weekdayIdx,
} from './core.js';
import { onPinch } from './pinch.js';
import { addTask, commit, focusDate, getTask, prefs, setPref, state, taskColor, touch, visibleTasks } from './store.js';
import { actions, esc, icon } from './ui.js';
import { closeSheet, openPanel, openTask } from './sheet.js';
import { chipsHTML, headerHTML, planSegHTML } from './views.js';
import { gcalBarHTML, gcalConnected, gcalEnsure, gcalEventsBetween, gcalEventsOn } from './gcal.js';

const LANE_H = 21;
const DAY_HEAD_H = 28;
const MORE_H = 15;
const MIN_ROW_H = 92;

// The span zooms with a pinch: the whole month, or a closer look at three or two weeks.
const SPANS = ['month', 3, 2];
const SPAN_LABEL = { month: '月', 3: '3 週', 2: '2 週' };
const calendar = { month: null, start: null };
let requestRender = () => {};
export const setCalendarRender = (fn) => (requestRender = fn);

const currentMonth = () => (calendar.month ||= todayStr().slice(0, 7));
const span = () => (SPANS.includes(prefs.calSpan) ? prefs.calSpan : 'month');

// The first Monday shown when zoomed in: this week if it falls in the month on screen.
function weekStart() {
  if (calendar.start == null) {
    const today = todayStr();
    const ym = currentMonth();
    calendar.start = mondayOf(toDay(today.slice(0, 7) === ym ? today : `${ym}-01`));
  }
  return calendar.start;
}

function setSpan(next) {
  if (next === span()) return;
  if (next === 'month') {
    calendar.month = fromDay(weekStart() + 3).slice(0, 7); // the month most of the first week falls in
  } else if (span() === 'month') calendar.start = null;
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

// Google Calendar events stand in as task-shaped items so they share the week's lanes.
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
  if (bar.task.gev) return eventBarHTML(bar, monday);
  const t = bar.task;
  const color = taskColor(t) || FREE_BLOCK_COLOR;
  const done = percent(t) >= 100;
  const realStart = toDay(t.start) === monday + bar.from;
  const realEnd = toDay(t.end) === monday + bar.to;
  const runs = barRuns(bar, monday);
  return runs.map((run, i) => {
    const dim = (prefs.calDim && !run.important) || done || !!t.archivedAt;
    const cls = [
      'cal-bar',
      dim ? 'dim' : 'strong',
      done ? 'is-done' : '',
      i === 0 && realStart ? 'round-l' : '',
      i === runs.length - 1 && realEnd ? 'round-r' : '',
    ].join(' ');
    const label = i === 0 || run.important;
    const gapL = i === 0 ? 2 : 0; // runs of one bar touch, so only its outer ends get a gap
    const gapR = i === runs.length - 1 ? 2 : 0;
    const style = `left:calc(${(run.from / 7) * 100}% + ${gapL}px);width:calc(${((run.to - run.from + 1) / 7) * 100}% - ${gapL + gapR}px);top:${bar.lane * LANE_H}px;--st:${esc(color)};--ink:${inkOn(color)}`;
    return `<div class="${cls}" style="${style}">${label ? `<span>${run.important ? '★ ' : ''}${esc(t.title) || '未命名'}</span>` : ''}</div>`;
  }).join('');
}

export function renderCalendar(main) {
  const today = todayStr();
  const ym = currentMonth();
  const [y, m] = ym.split('-').map(Number);
  const zoomed = span() !== 'month';
  const weeks = zoomed ? Array.from({ length: span() }, (_, i) => weekStart() + 7 * i) : monthWeeks(ym);
  const title = zoomed ? `${fmtMD(fromDay(weeks[0]))}–${fmtMD(fromDay(weeks[weeks.length - 1] + 6))}` : `${y} 年 ${m} 月`;
  const tasks = visibleTasks(today, { archived: true }); // the calendar is also the record of what happened
  gcalEnsure(fromDay(weeks[0]), fromDay(weeks[weeks.length - 1] + 6));

  const avail = (main.clientHeight || innerHeight) - (innerWidth < 768 ? 200 : 150);
  const rowH = Math.max(MIN_ROW_H, avail / weeks.length);
  const lanes = Math.max(2, Math.floor((rowH - DAY_HEAD_H - MORE_H) / LANE_H));

  let markedThisMonth = false;
  const weekRows = weeks.map((monday) => {
    const bars = layoutWeek([...tasks, ...eventItems(monday)], monday);
    const visible = bars.filter((b) => b.lane < lanes);
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const n = monday + i;
      const iso = fromDay(n);
      const hidden = bars.filter((b) => b.lane >= lanes && b.from <= i && i <= b.to).length;
      if ((zoomed || iso.slice(0, 7) === ym) && tasks.some((t) => isActiveOn(t, iso) && isImportant(t, iso))) markedThisMonth = true;
      cells.push(`<button type="button" class="cal-day ${!zoomed && iso.slice(0, 7) !== ym ? 'out' : ''} ${iso === today ? 'is-today' : ''} ${i >= 5 ? 'weekend' : ''}" data-act="cal-day" data-date="${iso}" aria-label="${iso}">
        <b>${zoomed && (iso.endsWith('-01') || n === weeks[0]) ? `${Number(iso.slice(5, 7))}/` : ''}${Number(iso.slice(8))}</b>
        ${hidden ? `<small class="cal-more">+${hidden}</small>` : ''}
      </button>`);
    }
    return `<div class="cal-week ${zoomed ? 'zoomed' : ''}" style="min-height:${MIN_ROW_H}px">
      <div class="cal-weeknum">${weekNumber(monday, state.settings)}</div>
      <div class="cal-week-body">
        <div class="cal-cells">${cells.join('')}</div>
        <div class="cal-bars" aria-hidden="true">${visible.map((b) => barHTML(b, monday)).join('')}</div>
      </div>
    </div>`;
  }).join('');

  const hint = !markedThisMonth && prefs.calDim && state.tasks.length ? '｜點日期把任務加星號' : '';

  main.innerHTML = `<div class="cal-view">
    <div class="g-head-wrap">
      ${headerHTML('計畫', `月曆｜雙指縮放看月、3 週或 2 週${hint}`, '<button type="button" class="text-btn today-btn" data-act="plan-today">今天</button>')}
      <div class="g-controls">
        ${planSegHTML()}
        <div class="tb-nav">
          <button type="button" class="btn-circle" data-act="cal-shift" data-n="-1" aria-label="往前">${icon.back}</button>
          <b>${title}</b>
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
      <div class="cal-weeks">${weekRows}</div>
    </div>
  </div>`;
}

/* ---------- Day panel ---------- */

function dayPanel(iso) {
  const day = toDay(iso);
  const list = state.tasks
    .filter((t) => isActiveOn(t, iso))
    .sort((a, b) => Number(isImportant(b, iso)) - Number(isImportant(a, iso)) || a.order - b.order);
  const rows = list.map((t) => {
    const important = isImportant(t, iso);
    const color = taskColor(t) || FREE_BLOCK_COLOR;
    return `<div class="row day-row ${percent(t) >= 100 ? 'is-done' : ''}">
      <button type="button" class="star-btn ${important ? 'on' : ''}" data-act="cal-star" data-id="${esc(t.id)}" data-date="${iso}" ${t.priority === 3 ? 'disabled title="優先度為高的任務每天都算最重要"' : ''} aria-pressed="${important}" aria-label="標為這天最重要">${important ? icon.starOn : icon.star}</button>
      <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}">
        <span class="row-title"><i class="dot" style="background:${esc(color)}"></i> ${esc(t.title) || '<em>未命名任務</em>'}</span>
        <span class="row-meta"><span>${esc(fmtRange(t.start, t.end))}</span>${t.priority === 3 ? '<span>優先度高</span>' : ''}</span>
      </button>
    </div>`;
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
    <p class="group-foot">星號只影響這一天。要讓任務每天都算最重要，把優先度設為「高」。</p>
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
    if (span() === 'month') calendar.month = addMonths(currentMonth(), n);
    else {
      calendar.start = weekStart() + 7 * n * span();
      calendar.month = fromDay(calendar.start + 3).slice(0, 7);
    }
    requestRender();
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
  calendar.month = todayStr().slice(0, 7);
  calendar.start = null;
  requestRender();
}
