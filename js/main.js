// App shell: navigation, render scheduling, global shortcuts, service worker.
import { getProject, prefs, requestPersistentStorage, setPref, state, subscribe } from './store.js';
import { gantt, initGanttDrag, renderGantt, setGanttRender, shouldSuppressClick } from './gantt.js';
import { initSheet } from './sheet.js';
import { initSync, onSyncStatus, syncStatus } from './sync.js';
import { actions, esc, icon, initDelegation, toast } from './ui.js';
import { applyStatusColors, applyTheme, refreshSyncLine, renderSettings, renderTasks, renderToday, setRerender, shell } from './views.js';
import { initPlannerGestures, planToday, plannerSuppressClick, renderPlanner, setPlannerRender } from './planner.js';
import { calendarToday, renderCalendar, setCalendarRender } from './calendar.js';
import { renderDiary, setDiaryRender } from './diary.js';

const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');

const TABS = [
  ['today', '今天', icon.today],
  ['gantt', '計畫', icon.gantt],
  ['diary', '日記', icon.book],
  ['tasks', '任務', icon.list],
  ['settings', '設定', icon.gear],
];

function navButtons(cls) {
  return TABS.map(([id, label, ic]) =>
    `<button type="button" class="${cls} ${prefs.view === id ? 'on' : ''}" data-act="nav" data-v="${id}" ${prefs.view === id ? 'aria-current="page"' : ''}>${ic}<span>${label}</span></button>`).join('');
}

function renderChrome() {
  const projects = state.projects.map((p) => {
    const count = state.tasks.filter((t) => t.projectId === p.id).length;
    const on = prefs.project === p.id;
    return `<button type="button" class="side-project ${on ? 'on' : ''}" data-act="side-project" data-id="${esc(p.id)}" aria-pressed="${on}">
      <i class="dot" style="background:${esc(p.color)}"></i><span>${esc(p.name)}</span><small>${count}</small></button>`;
  }).join('');
  const orphan = state.tasks.filter((t) => !t.projectId || !getProject(t.projectId)).length;
  sidebar.innerHTML = `<div class="brand"><span class="brand-mark">${icon.gantt}</span><b>日常甘特</b></div>
    <nav class="side-nav" aria-label="主選單">${navButtons('side-item')}</nav>
    <div class="side-section"><h2>專案</h2>${projects}
      ${orphan ? `<button type="button" class="side-project ${prefs.project === '__none' ? 'on' : ''}" data-act="side-project" data-id="__none"><i class="dot none"></i><span>未分類</span><small>${orphan}</small></button>` : ''}
    </div>
    <div class="side-foot" data-sync="${syncStatus.state}"></div>`;
  tabbar.innerHTML = navButtons('tab');
}

const scrollMemo = {};
let lastView = null;
let raf = 0;

function render() {
  raf = 0;
  if (gantt.dragging) return; // finishing the drag requests a fresh render

  applyStatusColors();
  renderChrome();

  const before = main.querySelector('.view-body');
  if (before?.dataset.scroll) scrollMemo[before.dataset.scroll] = before.scrollTop;

  // Unsent text and caret survive any re-render.
  const kept = new Map();
  main.querySelectorAll('[data-keep]').forEach((el) => kept.set(el.dataset.keep, el.value));
  const focused = document.activeElement?.dataset?.keep || shell.refocus;
  const caret = document.activeElement?.dataset?.keep ? document.activeElement.selectionStart : null;
  shell.refocus = null;

  switch (prefs.view) {
    case 'gantt':
      if (prefs.plan === 'day') renderPlanner(main);
      else if (prefs.plan === 'cal') renderCalendar(main);
      else renderGantt(main);
      break;
    case 'diary': renderDiary(main); break;
    case 'tasks': main.innerHTML = renderTasks(); break;
    case 'settings': main.innerHTML = renderSettings(); break;
    default: main.innerHTML = renderToday();
  }

  const body = main.querySelector('.view-body');
  if (body?.dataset.scroll && scrollMemo[body.dataset.scroll]) body.scrollTop = scrollMemo[body.dataset.scroll];
  for (const [key, value] of kept) {
    const el = main.querySelector(`[data-keep="${CSS.escape(key)}"]`);
    if (el) el.value = value;
  }
  if (focused) {
    const el = main.querySelector(`[data-keep="${CSS.escape(focused)}"]`);
    el?.focus();
    if (el && caret != null) el.setSelectionRange(caret, caret);
  }

  if (prefs.view !== lastView) {
    if (lastView !== null) main.firstElementChild?.classList.add('enter');
    lastView = prefs.view;
  }
}

let sheetTimer = 0;

// Frames can stop firing on a page that isn't being drawn; the timer guarantees the view
// still catches up.
function renderSoon() {
  if (raf) return;
  const run = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    clearTimeout(fallback);
    render();
  };
  raf = requestAnimationFrame(run);
  const fallback = setTimeout(run, 100);
}

const schedule = () => {
  // Typing in the sheet commits on every key; the view behind it can catch up a beat later.
  if (document.getElementById('sheet').open) {
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(renderSoon, 120);
    return;
  }
  renderSoon();
};

Object.assign(actions, {
  nav: (el) => {
    if (prefs.view === 'gantt' && el.dataset.v !== 'gantt') gantt.menuOpen = false;
    setPref({ view: el.dataset.v, status: '' });
  },
  'plan-today': () => {
    if (prefs.plan === 'day') planToday();
    else if (prefs.plan === 'cal') calendarToday();
    else {
      gantt.pendingToday = true;
      schedule();
    }
  },
  'side-project': (el) => {
    const id = el.dataset.id;
    const view = ['today', 'settings', 'diary'].includes(prefs.view) ? 'tasks' : prefs.view;
    setPref({ project: prefs.project === id ? '' : id, view });
  },
});

function init() {
  applyTheme();
  initDelegation({
    beforeClick: (e) => {
      if (shouldSuppressClick() && e.target.closest('[data-bar]')) return false;
      if (plannerSuppressClick() && e.target.closest('.day-view')) return false;
      if (gantt.menuOpen && !e.target.closest('.menu-wrap')) {
        gantt.menuOpen = false;
        schedule();
      }
      return true;
    },
  });
  initSheet();
  initGanttDrag();
  initPlannerGestures();
  setRerender(schedule);
  setGanttRender(schedule);
  setPlannerRender(schedule);
  setCalendarRender(schedule);
  setDiaryRender(schedule);
  subscribe(schedule);
  onSyncStatus(() => {
    refreshSyncLine();
    if (prefs.view === 'settings' && syncStatus.state === 'off') schedule();
  });
  initSync();
  requestPersistentStorage();

  // Statuses depend on today's date, so a tab left open overnight must refresh on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });

  // The "now" markers keep moving while the page sits open.
  setInterval(() => {
    const live = prefs.view === 'today' || (prefs.view === 'gantt' && prefs.plan === 'day');
    if (live && document.visibilityState === 'visible' && !gantt.dragging) schedule();
  }, 60000);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(schedule, 80);
  });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (e.key === 'Escape' && !typing && gantt.menuOpen) {
      gantt.menuOpen = false;
      schedule();
    }
    if (typing || document.getElementById('sheet').open) return;
    const map = { 1: 'today', 2: 'gantt', 3: 'diary', 4: 'tasks', 5: 'settings' };
    if (map[e.key]) setPref({ view: map[e.key], status: '' });
    else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      actions['new-task']();
    } else if ((e.key === 't' || e.key === 'T') && prefs.view === 'gantt') actions['plan-today']();
  });

  render();

  if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('新版本已就緒', () => location.reload(), '重新整理');
      hadController = true;
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
