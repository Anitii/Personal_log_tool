// Month calendar. Each day can mark its most important tasks; the rest fade by default.
import {
  FREE_BLOCK_COLOR, WEEKDAYS, addMonths, fmtRange, fromDay, inkOn, isActiveOn, isImportant, layoutWeek, monthWeeks, percent,
  toDay, todayStr, toggleFocusDay, weekNumber, weekdayIdx,
} from './core.js';
import { addTask, commit, focusDate, getTask, prefs, setPref, state, taskColor, touch, visibleTasks } from './store.js';
import { actions, changes, esc, icon } from './ui.js';
import { closeSheet, openPanel, openTask } from './sheet.js';
import { chipsHTML, headerHTML, planSegHTML } from './views.js';

const LANE_H = 21;
const DAY_HEAD_H = 28;
const MORE_H = 15;
const MIN_ROW_H = 92;

const calendar = { month: null };
let requestRender = () => {};
export const setCalendarRender = (fn) => (requestRender = fn);

const currentMonth = () => (calendar.month ||= todayStr().slice(0, 7));

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

function barHTML(bar, monday) {
  const t = bar.task;
  const color = taskColor(t) || FREE_BLOCK_COLOR;
  const done = percent(t) >= 100;
  const realStart = toDay(t.start) === monday + bar.from;
  const realEnd = toDay(t.end) === monday + bar.to;
  const runs = barRuns(bar, monday);
  return runs.map((run, i) => {
    const dim = (prefs.calDim && !run.important) || done;
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
  const weeks = monthWeeks(ym);
  const tasks = visibleTasks(today);

  const avail = (main.clientHeight || innerHeight) - (innerWidth < 768 ? 176 : 196);
  const rowH = Math.max(MIN_ROW_H, avail / weeks.length);
  const lanes = Math.max(2, Math.floor((rowH - DAY_HEAD_H - MORE_H) / LANE_H));

  let markedThisMonth = false;
  const weekRows = weeks.map((monday) => {
    const bars = layoutWeek(tasks, monday);
    const visible = bars.filter((b) => b.lane < lanes);
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const n = monday + i;
      const iso = fromDay(n);
      const hidden = bars.filter((b) => b.lane >= lanes && b.from <= i && i <= b.to).length;
      if (iso.slice(0, 7) === ym && tasks.some((t) => isActiveOn(t, iso) && isImportant(t, iso))) markedThisMonth = true;
      cells.push(`<button type="button" class="cal-day ${iso.slice(0, 7) !== ym ? 'out' : ''} ${iso === today ? 'is-today' : ''} ${i >= 5 ? 'weekend' : ''}" data-act="cal-day" data-date="${iso}" aria-label="${iso}">
        <b>${Number(iso.slice(8))}</b>
        ${hidden ? `<small class="cal-more">+${hidden}</small>` : ''}
      </button>`);
    }
    return `<div class="cal-week" style="min-height:${MIN_ROW_H}px">
      <div class="cal-weeknum">${weekNumber(monday, state.settings)}</div>
      <div class="cal-week-body">
        <div class="cal-cells">${cells.join('')}</div>
        <div class="cal-bars" aria-hidden="true">${visible.map((b) => barHTML(b, monday)).join('')}</div>
      </div>
    </div>`;
  }).join('');

  const hint = !markedThisMonth && prefs.calDim && state.tasks.length
    ? '<p class="cal-hint">點某一天，把任務加上星號標成最重要。其他任務會自動變淡。</p>'
    : '';

  main.innerHTML = `<div class="cal-view">
    <div class="g-head-wrap">
      ${headerHTML('計畫', `${y} 年 ${m} 月`, '<button type="button" class="text-btn today-btn" data-act="plan-today">今天</button>')}
      <div class="g-controls">${planSegHTML()}${chipsHTML()}</div>
      <div class="cal-nav">
        <button type="button" class="btn-circle" data-act="cal-shift" data-n="-1" aria-label="上個月">${icon.back}</button>
        <b>${y} 年 ${m} 月</b>
        <button type="button" class="btn-circle" data-act="cal-shift" data-n="1" aria-label="下個月">${icon.chevR}</button>
        <label class="inline-switch cal-dim">淡化不重要<input type="checkbox" class="switch" data-ch="cal-dim" ${prefs.calDim ? 'checked' : ''}></label>
      </div>
      ${hint}
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
  openPanel(`${m} 月 ${d} 日 星期${WEEKDAYS[weekdayIdx(day)]}`, `
    <div class="card">${rows || '<p class="tray-empty">這天沒有任務。</p>'}</div>
    <p class="group-foot">星號只影響這一天。要讓任務每天都算最重要，把優先度設為「高」。</p>
    <div class="card panel-actions">
      <button type="button" class="row form-row link-row" data-act="cal-open-day" data-date="${iso}">開啟這天的時間表</button>
      <button type="button" class="row form-row link-row" data-act="cal-open-diary" data-date="${iso}">寫這天的日記</button>
      <button type="button" class="row form-row link-row" data-act="cal-new-task" data-date="${iso}">在這天新增任務</button>
    </div>`);
}

Object.assign(actions, {
  'cal-shift': (el) => {
    calendar.month = addMonths(currentMonth(), Number(el.dataset.n));
    requestRender();
  },
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

Object.assign(changes, {
  'cal-dim': (el) => setPref({ calDim: el.checked }),
});

export function calendarToday() {
  calendar.month = todayStr().slice(0, 7);
  requestRender();
}
