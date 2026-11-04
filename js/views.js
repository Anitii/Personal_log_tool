// Today, Tasks and Settings views, plus the row markup they share.
import {
  DAY_MINUTES, DEFAULT_STATUS_COLORS, FREE_BLOCK_COLOR, PALETTE, STATUS, WEEKDAYS, addDays, blocksOn, deferTask, fitParentToSubs, fmtDuration,
  fmtMinute, fmtRange, fromDay, inkOn, isActiveOn, isImportant, makeSub, mondayOf, newId, normalize, percent, plannedMinutes, setDone,
  statusOf, subStatusOf, tasksForDay, toCSV, toDay, todayStr, toggleFocusDay, weekNumber, weekdayIdx,
} from './core.js';
import { plainPreview } from './markdown.js';
import {
  addTask, blockInfo, commit, diaryBody, focusDate, getProject, getTask, loadSample, prefs, replaceAll, saveDiary, setPref, state, touch, visibleTasks,
} from './store.js';
import { connect, disconnect, syncNow, syncStatus } from './sync.js';
import { actions, changes, colorRowHTML, download, enters, esc, icon, inputs, toast } from './ui.js';
import { openTask } from './sheet.js';

export const shell = {
  refocus: null, // data-keep key to put the caret back in after the next render
  colorOpen: null, // project whose color row is expanded in Settings
};

const PRIORITY_MARK = ['', '!', '!!', '!!!'];

/* ---------- Shared pieces ---------- */

export function headerHTML(title, sub, trailing = '') {
  return `<header class="large-head">
    <div class="large-title"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <div class="head-actions">${trailing}
      <button type="button" class="btn-circle tint" data-act="new-task" aria-label="新增任務" title="新增任務 (N)">${icon.plus}</button>
    </div>
  </header>`;
}

export function chipsHTML() {
  const chip = (id, label, color) =>
    `<button type="button" class="chip ${prefs.project === id ? 'on' : ''}" data-act="filter-project" data-id="${esc(id)}" aria-pressed="${prefs.project === id}">
      ${color ? `<i class="dot" style="background:${esc(color)}"></i>` : ''}${esc(label)}</button>`;
  const statusChip = prefs.status
    ? `<button type="button" class="chip on status-chip s-${STATUS[prefs.status].cls}" data-act="clear-status">${esc(STATUS[prefs.status].label)} ${icon.x}</button>`
    : '';
  return `<div class="chips">${statusChip}${chip('', '全部')}${state.projects.map((p) => chip(p.id, p.name, p.color)).join('')}${chip('__none', '未分類')}</div>`;
}

export function emptyHTML() {
  return `<div class="empty">
    <div class="empty-mark">${icon.gantt}</div>
    <h2>還沒有任務</h2>
    <p>新增第一個任務，或把原本的 Excel 甘特圖匯入。</p>
    <div class="empty-actions">
      <button type="button" class="btn primary" data-act="new-task">新增任務</button>
      <button type="button" class="btn" data-act="import-xlsx">匯入 Excel</button>
      <button type="button" class="btn plain" data-act="load-sample">看範例</button>
    </div>
  </div>`;
}

function ring(pct, cls) {
  const c = 2 * Math.PI * 9;
  return `<svg class="ring s-${cls}" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" class="ring-bg"/>
    <circle cx="12" cy="12" r="9" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 12 12)"/>
  </svg>`;
}

export function starButton(t, iso) {
  const on = isImportant(t, iso);
  return `<button type="button" class="star-btn ${on ? 'on' : ''}" data-act="toggle-focus" data-id="${esc(t.id)}" data-date="${esc(iso)}" ${t.priority === 3 ? 'disabled title="優先度為高的任務每天都算最重要"' : ''} aria-pressed="${on}" aria-label="標為這天最重要">${on ? icon.starOn : icon.star}</button>`;
}

const PLAN_SCALES = [['day', '日'], ['week', '週'], ['month', '月'], ['cal', '月曆']];

export function planSegHTML() {
  return `<div class="seg plan-seg" role="group" aria-label="計畫檢視">${PLAN_SCALES.map(([k, label]) =>
    `<button type="button" class="${prefs.plan === k ? 'on' : ''}" data-act="plan-set" data-v="${k}" aria-pressed="${prefs.plan === k}">${label}</button>`).join('')}</div>`;
}

// The whole day on one line, shared by the Today page and the day table.
export function stripHTML(blocks, now, act) {
  const segs = blocks.map((b) => {
    const color = blockInfo(b).color || FREE_BLOCK_COLOR;
    return `<i class="strip-seg ${b.done ? 'is-done' : ''}" style="left:${(b.start / DAY_MINUTES) * 100}%;width:${((b.end - b.start) / DAY_MINUTES) * 100}%;background:${esc(color)}"></i>`;
  }).join('');
  const ticks = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${h}</span>`).join('');
  return `<button type="button" class="strip" data-act="${act}" aria-label="整天時間軸">
    <span class="strip-track">${segs}${now >= 0 ? `<i class="strip-now" style="left:${(now / DAY_MINUTES) * 100}%"></i>` : ''}</span>
    <span class="strip-ticks">${ticks}</span>
  </button>`;
}

function subRow(t, s, today) {
  const st = subStatusOf(s, today);
  return `<div class="row sub ${s.done ? 'is-done' : ''}">
    <button type="button" class="check small ${s.done ? 'on' : ''}" data-act="toggle-sub" data-id="${esc(t.id)}" data-sub="${esc(s.id)}" role="checkbox" aria-checked="${s.done}" aria-label="完成子任務：${esc(s.title)}"></button>
    <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}" data-focus-sub="${esc(s.id)}">
      <span class="row-title">${esc(s.title) || '<em>未命名子任務</em>'}</span>
    </button>
    <span class="date-chip ${st === 'late' ? 'late' : ''}">${esc(fmtRange(s.start, s.end))}</span>
  </div>`;
}

function taskRow(t, today, { subs = t.subtasks, expandable = true, showAdd = false, star = null, meta = '' } = {}) {
  const st = statusOf(t, today);
  const pct = percent(t);
  const project = getProject(t.projectId);
  const expanded = !!prefs.expanded[t.id];
  const count = t.subtasks.length;
  const open = expandable ? expanded : subs.length > 0;
  return `<div class="task-group">
    <div class="row task ${st === 'done' ? 'is-done' : ''}">
      <button type="button" class="check ${st === 'done' ? 'on' : ''}" data-act="toggle-task" data-id="${esc(t.id)}" role="checkbox" aria-checked="${st === 'done'}" aria-label="完成：${esc(t.title)}"></button>
      <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}">
        <span class="row-title">${t.priority ? `<b class="prio">${PRIORITY_MARK[t.priority]}</b> ` : ''}${esc(t.title) || '<em>未命名任務</em>'}</span>
        <span class="row-meta">
          ${project ? `<span class="meta-project"><i class="dot" style="background:${esc(project.color)}"></i>${esc(project.name)}</span>` : ''}
          <span class="${st === 'late' ? 'text-late' : ''}">${esc(fmtRange(t.start, t.end))}</span>
          ${count ? `<span>${t.subtasks.filter((s) => s.done).length}/${count} 子任務</span>` : ''}
          ${t.notes ? `<span class="meta-ic" aria-label="有備註">${icon.note}</span>` : ''}
          ${meta}
        </span>
      </button>
      ${star ? starButton(t, star) : ''}
      <span class="pill s-${STATUS[st].cls}">${esc(STATUS[st].label)}</span>
      <span class="ring-wrap" title="${pct}%">${ring(pct, STATUS[st].cls)}<span class="ring-num">${pct}</span></span>
      ${expandable ? `<button type="button" class="disclose ${expanded ? 'open' : ''}" data-act="toggle-expand" data-id="${esc(t.id)}" aria-expanded="${expanded}" aria-label="${expanded ? '收合子任務' : '展開子任務'}">${icon.chevR}</button>` : ''}
    </div>
    ${open ? `<div class="subs">
      ${subs.map((s) => subRow(t, s, today)).join('')}
      ${showAdd || expandable ? `<div class="row sub add-sub"><span class="add-mark">${icon.plus}</span>
        <input type="text" class="bare" placeholder="新增子任務" enterkeyhint="done" data-enter="quick-sub" data-id="${esc(t.id)}" data-keep="sub-${esc(t.id)}" aria-label="新增子任務"></div>` : ''}
    </div>` : ''}
  </div>`;
}

function group(title, body, extra = '') {
  return `<section class="group"><h2 class="group-head">${title}${extra}</h2><div class="card">${body}</div></section>`;
}

/* ---------- Today ---------- */

const daysBetween = (from, to) => toDay(to) - toDay(from);

function nowCard(today, blocks, minute) {
  const current = blocks.find((b) => b.start <= minute && minute < b.end);
  const next = blocks.find((b) => b.start > minute);
  const tasksLeft = tasksForDay(state, today, today);
  const unplaced = tasksLeft.filter((t) => !blocks.some((b) => b.taskId === t.id)).length;
  const planned = plannedMinutes(blocks);

  let headline;
  if (current) {
    const left = current.end - minute;
    const pct = ((minute - current.start) / (current.end - current.start)) * 100;
    headline = `<small class="now-label">現在</small>
      <h2 class="now-title">${esc(blockInfo(current).title)}</h2>
      <p class="now-meta">${fmtMinute(current.start)}–${fmtMinute(current.end)}｜還有 ${esc(fmtDuration(left))}</p>
      <div class="now-bar"><i style="width:${pct}%"></i></div>`;
  } else if (next) {
    headline = `<small class="now-label">下一段</small>
      <h2 class="now-title">${esc(blockInfo(next).title)}</h2>
      <p class="now-meta">${fmtMinute(next.start)} 開始｜再過 ${esc(fmtDuration(next.start - minute))}</p>`;
  } else if (blocks.length) {
    headline = `<small class="now-label">今天的時間表</small>
      <h2 class="now-title">排定的時段都過了</h2>
      <p class="now-meta">可以寫點日記，收個尾。</p>`;
  } else {
    headline = `<small class="now-label">今天的時間表</small>
      <h2 class="now-title">${tasksLeft.length ? `有 ${tasksLeft.length} 件事，還沒排時間` : '今天還沒有安排'}</h2>
      <p class="now-meta">把任務拉進 10 分鐘時間表，不會改動週、月計畫。</p>`;
  }
  const after = current && next
    ? `<p class="now-next">接著 ${fmtMinute(next.start)} ${esc(blockInfo(next).title)}</p>`
    : '';
  return `<section class="card now-card">
    <div class="now-main">${headline}${after}</div>
    ${stripHTML(blocks, minute, 'go-day')}
    <div class="now-foot">
      <span>已排 ${esc(fmtDuration(planned))}${unplaced ? `｜${unplaced} 件未排` : ''}</span>
      <button type="button" class="btn small" data-act="go-day">排時間</button>
    </div>
  </section>`;
}

function weekCard(today) {
  const day = toDay(today);
  const monday = mondayOf(day);
  const open = state.tasks.filter((t) => percent(t) < 100);
  const loads = Array.from({ length: 7 }, (_, i) => {
    const iso = fromDay(monday + i);
    return { iso, i, active: open.filter((t) => isActiveOn(t, iso)).length, due: open.filter((t) => t.end === iso).length };
  });
  const peak = Math.max(1, ...loads.map((l) => l.active));
  const bars = loads.map((l) => `<button type="button" class="load-day ${l.iso === today ? 'is-today' : ''} ${l.iso < today ? 'past' : ''}" data-act="go-day" data-date="${l.iso}" aria-label="${l.iso}，${l.active} 件進行，${l.due} 件到期">
      <span class="load-num">${l.active || ''}</span>
      <span class="load-track"><i style="height:${(l.active / peak) * 100}%"></i></span>
      <small>${WEEKDAYS[l.i]}</small>
      <span class="load-due">${l.due ? `${l.due} 到期` : ''}</span>
    </button>`).join('');
  const counts = { doing: 0, late: 0, todo: 0, done: 0 };
  for (const t of state.tasks) {
    const st = statusOf(t, today);
    if (st in counts) counts[st]++;
  }
  const stats = ['doing', 'late', 'todo', 'done'].map((k) =>
    `<button type="button" class="stat" data-act="drill-status" data-status="${k}"><b>${counts[k]}</b><span>${STATUS[k].label}</span></button>`).join('');
  return `<section class="group"><h2 class="group-head">本週負荷<span class="group-count">第 ${weekNumber(day, state.settings)} 週</span></h2>
    <div class="card week-card"><div class="load-grid">${bars}</div><div class="stats">${stats}</div></div>
  </section>`;
}

function overdueCard(today) {
  const late = state.tasks.filter((t) => statusOf(t, today) === 'late').sort((a, b) => a.end.localeCompare(b.end));
  const nodate = state.tasks.filter((t) => ['nodate', 'bad'].includes(statusOf(t, today)));
  if (!late.length && !nodate.length) return '';
  const lateRows = late.map((t) => `<div class="row triage">
      <button type="button" class="check" data-act="toggle-task" data-id="${esc(t.id)}" role="checkbox" aria-checked="false" aria-label="完成：${esc(t.title)}"></button>
      <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}">
        <span class="row-title">${esc(t.title) || '<em>未命名任務</em>'}</span>
        <span class="row-meta"><span class="text-late">逾期 ${daysBetween(t.end, today)} 天</span></span>
      </button>
      <div class="triage-actions">
        <button type="button" class="btn small" data-act="defer-task" data-id="${esc(t.id)}" data-to="today">改今天</button>
        <button type="button" class="btn small" data-act="defer-task" data-id="${esc(t.id)}" data-to="tomorrow">改明天</button>
      </div>
    </div>`).join('');
  const nodateRows = nodate.map((t) => `<div class="row triage">
      <span class="triage-gap"></span>
      <button type="button" class="row-main" data-act="open-task" data-id="${esc(t.id)}">
        <span class="row-title">${esc(t.title) || '<em>未命名任務</em>'}</span>
        <span class="row-meta"><span>${esc(STATUS[statusOf(t, today)].label)}</span></span>
      </button>
      <div class="triage-actions"><button type="button" class="btn small" data-act="defer-task" data-id="${esc(t.id)}" data-to="today">排今天</button></div>
    </div>`).join('');
  return group('<span class="text-late">需要處理</span>', lateRows + nodateRows, `<span class="group-count">${late.length + nodate.length}</span>`);
}

function soonCard(today) {
  const limit = addDays(today, 7);
  const soon = state.tasks
    .filter((t) => percent(t) < 100 && t.end && t.end > today && t.end <= limit && t.start && t.start <= t.end)
    .sort((a, b) => a.end.localeCompare(b.end));
  if (!soon.length) return '';
  const rows = soon.map((t) => {
    const project = getProject(t.projectId);
    return `<button type="button" class="row soon-row" data-act="open-task" data-id="${esc(t.id)}">
      <span class="d-count">D-${daysBetween(today, t.end)}</span>
      <span class="soon-title">${project ? `<i class="dot" style="background:${esc(project.color)}"></i>` : ''}${esc(t.title) || '<em>未命名任務</em>'}</span>
      <span class="date-chip">${esc(fmtRange(t.end, t.end))}</span>
    </button>`;
  }).join('');
  return group('即將到期', rows);
}

function diaryCard(today) {
  const preview = plainPreview(diaryBody(today), 80);
  return `<section class="group"><h2 class="group-head">日記</h2>
    <div class="card">
      <div class="quick-add flat"><span class="add-mark">${icon.book}</span>
        <input type="text" class="bare" placeholder="記一筆，按 Enter 存進今天的日記" enterkeyhint="done" data-enter="quick-diary" data-keep="today-diary" aria-label="記一筆到今天的日記"></div>
      <button type="button" class="row form-row link-row diary-open" data-act="go-diary"><span class="diary-preview">${preview ? esc(preview) : '打開今天的日記'}</span>${icon.chevR}</button>
    </div>
  </section>`;
}

export function renderToday() {
  const today = todayStr();
  const day = toDay(today);
  const [, m, d] = today.split('-').map(Number);
  const sub = `${m} 月 ${d} 日 星期${WEEKDAYS[weekdayIdx(day)]}｜第 ${weekNumber(day, state.settings)} 週`;
  const clock = new Date();
  const minute = clock.getHours() * 60 + clock.getMinutes();
  const blocks = blocksOn(state, today);

  // Subtasks already due or under way are the actual to-dos, so they show without expanding.
  const activeSubs = (t) => t.subtasks.filter((s) => !s.done && (!s.start || s.start <= today));
  const planned = (t) => {
    const total = plannedMinutes(blocks.filter((b) => b.taskId === t.id));
    return total ? `<span>已排 ${esc(fmtDuration(total))}</span>` : '';
  };
  const focusList = state.tasks
    .filter((t) => percent(t) < 100 && isActiveOn(t, today))
    .sort((a, b) => Number(isImportant(b, today)) - Number(isImportant(a, today)) || a.end.localeCompare(b.end) || a.order - b.order);
  const dueLabel = (t) => (t.end === today ? '<span class="text-late">今天到期</span>' : '');
  const rows = focusList.map((t) =>
    taskRow(t, today, { subs: activeSubs(t), expandable: false, star: today, meta: `${dueLabel(t)}${planned(t)}` })).join('');

  const quick = `<div class="quick-add flat">
    <span class="add-mark">${icon.plus}</span>
    <input type="text" class="bare" placeholder="新增今天的任務，按 Enter" enterkeyhint="done" data-enter="quick-today" data-keep="today-add" aria-label="新增今天的任務">
  </div>`;
  const todayCard = `<section class="group"><h2 class="group-head">今天要做<span class="group-count">${focusList.length}</span></h2>
    <div class="card">${rows}${quick}</div>
    ${focusList.length ? '<p class="group-foot">點星號標出今天最重要的事，它會排到最上面，也會在月曆上突顯。</p>' : ''}
  </section>`;

  return `<div class="view-body dash-body" data-scroll="today">
    ${headerHTML('今天', sub)}
    ${state.tasks.length ? '' : emptyHTML()}
    <div class="dash">
      <div class="dash-col">
        ${nowCard(today, blocks, minute)}
        ${overdueCard(today)}
        ${todayCard}
      </div>
      <div class="dash-col">
        ${weekCard(today)}
        ${soonCard(today)}
        ${diaryCard(today)}
      </div>
    </div>
  </div>`;
}

/* ---------- Tasks ---------- */

export function renderTasks() {
  const today = todayStr();
  const list = visibleTasks(today);
  let groups;
  if (prefs.group === 'status') {
    groups = ['late', 'doing', 'todo', 'nodate', 'bad', 'done']
      .map((k) => ({ title: STATUS[k].label, items: list.filter((t) => statusOf(t, today) === k) }));
  } else if (prefs.group === 'date') {
    const sorted = [...list].sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
    const byWeek = new Map();
    for (const t of sorted) {
      const key = t.start ? `第 ${weekNumber(toDay(t.start), state.settings)} 週` : '未排日期';
      if (!byWeek.has(key)) byWeek.set(key, []);
      byWeek.get(key).push(t);
    }
    groups = [...byWeek].map(([title, items]) => ({ title, items }));
  } else {
    groups = state.projects.map((p) => ({
      title: `<i class="dot" style="background:${esc(p.color)}"></i>${esc(p.name)}`,
      items: list.filter((t) => t.projectId === p.id),
    }));
    groups.push({ title: '未分類', items: list.filter((t) => !t.projectId || !getProject(t.projectId)) });
  }

  const seg = [['project', '專案'], ['status', '狀態'], ['date', '週次']].map(([k, label]) =>
    `<button type="button" class="${prefs.group === k ? 'on' : ''}" data-act="set-group" data-v="${k}" aria-pressed="${prefs.group === k}">${label}</button>`).join('');

  const body = groups.filter((g) => g.items.length).map((g) =>
    group(g.title, g.items.map((t) => taskRow(t, today)).join(''), `<span class="group-count">${g.items.length}</span>`)).join('');

  return `<div class="view-body" data-scroll="tasks">
    ${headerHTML('任務', `共 ${list.length} 項`)}
    ${chipsHTML()}
    <div class="seg-row"><div class="seg" role="group" aria-label="分組方式">${seg}</div>
      <label class="inline-switch">隱藏已完成<input type="checkbox" class="switch" data-ch="hide-done" ${prefs.hideDone ? 'checked' : ''}></label>
    </div>
    ${body || (state.tasks.length ? '<p class="all-clear">這個篩選條件下沒有任務。</p>' : emptyHTML())}
  </div>`;
}

/* ---------- Settings ---------- */

function syncLine() {
  if (syncStatus.state === 'syncing') return '同步中…';
  if (syncStatus.state === 'error') return syncStatus.message;
  if (syncStatus.at) {
    const t = new Date(syncStatus.at);
    return `上次同步 ${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }
  return '已連結';
}

export function renderSettings() {
  const s = state.settings;
  const connected = syncStatus.state !== 'off';
  const theme = [['system', '自動'], ['light', '淺色'], ['dark', '深色']].map(([k, label]) =>
    `<button type="button" class="${prefs.theme === k ? 'on' : ''}" data-act="set-theme" data-v="${k}" aria-pressed="${prefs.theme === k}">${label}</button>`).join('');

  const projects = state.projects.map((p) => `<div class="row form-row">
      <button type="button" class="swatch" style="background:${esc(p.color)}" data-act="toggle-color" data-id="${esc(p.id)}" aria-expanded="${shell.colorOpen === p.id}" aria-label="更換 ${esc(p.name)} 的顏色"></button>
      <input type="text" class="bare" value="${esc(p.name)}" data-in="project-name" data-id="${esc(p.id)}" data-keep="project-${esc(p.id)}" aria-label="專案名稱" maxlength="60">
      <button type="button" class="icon-btn danger" data-act="delete-project" data-id="${esc(p.id)}" aria-label="刪除專案 ${esc(p.name)}">${icon.trash}</button>
    </div>
    ${shell.colorOpen === p.id ? `<div class="color-drawer">${colorRowHTML({ value: p.color, target: 'project', id: p.id })}</div>` : ''}`).join('');

  const statusColors = ['todo', 'doing', 'done', 'late'].map((k) => {
    const value = s.statusColors[k];
    const open = shell.colorOpen === `status-${k}`;
    return `<div class="row form-row">
      <button type="button" class="swatch" style="background:${esc(value)}" data-act="toggle-color" data-id="status-${k}" aria-expanded="${open}" aria-label="更換${STATUS[k].label}的顏色"></button>
      <span class="form-label">${STATUS[k].label}</span>
    </div>
    ${open ? `<div class="color-drawer">${colorRowHTML({ value, target: 'status', id: k })}</div>` : ''}`;
  }).join('');

  const sync = connected
    ? `<div class="row form-row"><span class="form-label">狀態</span><span class="form-value ${syncStatus.state === 'error' ? 'text-late' : ''}" id="sync-line">${esc(syncLine())}</span></div>
       <button type="button" class="row form-row link-row" data-act="sync-now">立即同步</button>
       <button type="button" class="row form-row link-row destructive" data-act="sync-off">中斷連結</button>`
    : `<div class="row form-row"><input type="password" class="bare" id="gh-token" placeholder="貼上 GitHub 權杖" autocomplete="off" autocapitalize="off" spellcheck="false" data-enter="sync-on" aria-label="GitHub 權杖"></div>
       <button type="button" class="row form-row link-row" data-act="sync-on">連結同步</button>`;

  return `<div class="view-body narrow" data-scroll="settings">
    ${headerHTML('設定', '')}

    <section class="group"><h2 class="group-head">外觀</h2><div class="card pad"><div class="seg wide" role="group" aria-label="外觀">${theme}</div></div></section>

    <section class="group"><h2 class="group-head">狀態顏色</h2><div class="card">${statusColors}
      <button type="button" class="row form-row link-row" data-act="reset-status-colors">恢復預設馬卡龍色</button>
    </div><p class="group-foot">甘特圖的色條預設依狀態上色，也可以在甘特圖的 ⋯ 選單改成依專案。</p></section>

    <section class="group"><h2 class="group-head">專案</h2><div class="card">${projects}
      <div class="row form-row"><span class="add-mark">${icon.plus}</span>
        <input type="text" class="bare" placeholder="新增專案" enterkeyhint="done" data-enter="add-project" data-keep="add-project" aria-label="新增專案" maxlength="60"></div>
    </div></section>

    <section class="group"><h2 class="group-head">週次基準</h2><div class="card">
      <label class="row form-row"><span class="form-label">基準週的週一</span><input type="date" class="field-date" value="${esc(s.baseMonday)}" data-ch="base-monday"></label>
      <label class="row form-row"><span class="form-label">該週是第幾週</span><input type="number" class="field-num" inputmode="numeric" value="${esc(s.baseWeek)}" data-ch="base-week"></label>
    </div><p class="group-foot">甘特圖上方的「第 N 週」由此推算。</p></section>

    <section class="group"><h2 class="group-head">跨裝置同步</h2><div class="card">${sync}</div>
      <p class="group-foot">資料預設只存在這個瀏覽器。要讓手機、平板、電腦看到同一份，請到
      <a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=daily-gantt" target="_blank" rel="noopener">GitHub 建立權杖</a>（只勾 gist），
      在每台裝置貼上一次。資料會存進你帳號裡的秘密 Gist；權杖只存在這個瀏覽器，請勿在共用電腦上使用。</p>
    </section>

    <section class="group"><h2 class="group-head">資料</h2><div class="card">
      <button type="button" class="row form-row link-row" data-act="import-xlsx">匯入 Excel 甘特圖</button>
      <button type="button" class="row form-row link-row" data-act="export-csv">匯出 CSV（可用 Excel 開）</button>
      <button type="button" class="row form-row link-row" data-act="export-json">匯出備份</button>
      <button type="button" class="row form-row link-row" data-act="import-json">從備份還原</button>
      <button type="button" class="row form-row link-row destructive" data-act="clear-all">清除所有任務</button>
    </div></section>
  </div>`;
}

export function refreshSyncLine() {
  const el = document.getElementById('sync-line');
  if (el) {
    el.textContent = syncLine();
    el.classList.toggle('text-late', syncStatus.state === 'error');
  }
}

/* ---------- Handlers ---------- */

Object.assign(actions, {
  'new-task': () => {
    const today = todayStr();
    const projectId = prefs.project && prefs.project !== '__none' ? prefs.project : '';
    const t = addTask({ start: today, end: today, projectId });
    openTask(t.id, { isNew: true });
  },
  'open-task': (el) => openTask(el.dataset.id, { focusSub: el.dataset.focusSub }),
  'toggle-task': (el) => {
    const t = getTask(el.dataset.id);
    const done = percent(t) < 100;
    commit(() => {
      setDone(t, done);
      touch(t);
    }, done ? { undo: `已完成「${t.title || '未命名任務'}」` } : {});
  },
  'toggle-sub': (el) => {
    const t = getTask(el.dataset.id);
    const s = t.subtasks.find((x) => x.id === el.dataset.sub);
    commit(() => {
      s.done = !s.done;
      touch(t);
    });
  },
  'toggle-expand': (el) => {
    const expanded = { ...prefs.expanded };
    if (expanded[el.dataset.id]) delete expanded[el.dataset.id];
    else expanded[el.dataset.id] = 1;
    setPref({ expanded });
  },
  'filter-project': (el) => setPref({ project: el.dataset.id }),
  'clear-status': () => setPref({ status: '' }),
  'drill-status': (el) => setPref({ view: 'tasks', status: el.dataset.status, project: '', group: 'project' }),
  'set-group': (el) => setPref({ group: el.dataset.v }),
  'load-sample': () => loadSample(),
  'set-theme': (el) => {
    setPref({ theme: el.dataset.v });
    applyTheme();
  },
  'toggle-color': (el) => {
    shell.colorOpen = shell.colorOpen === el.dataset.id ? null : el.dataset.id;
    rerender();
  },
  'pick-color': (el) => {
    applyColor(el.dataset.target, el.dataset.id, el.dataset.v);
    // Inside a sheet nothing re-renders the row, so mark the choice right here.
    el.parentElement.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === el));
  },
  'reset-status-colors': () => {
    commit((s) => {
      s.settings.statusColors = { ...DEFAULT_STATUS_COLORS };
      s.settings.updatedAt = Date.now();
    });
  },
  'plan-set': (el) => setPref({ plan: el.dataset.v }),
  'toggle-focus': (el) => {
    const t = getTask(el.dataset.id);
    if (!t) return;
    commit(() => {
      toggleFocusDay(t, el.dataset.date);
      touch(t);
    });
  },
  'defer-task': (el) => {
    const t = getTask(el.dataset.id);
    if (!t) return;
    const to = el.dataset.to === 'tomorrow' ? addDays(todayStr(), 1) : todayStr();
    commit(() => {
      deferTask(t, to);
      touch(t);
    }, { undo: `已把「${t.title || '未命名任務'}」改到${el.dataset.to === 'tomorrow' ? '明天' : '今天'}` });
  },
  'go-day': (el) => {
    focusDate.plan = el.dataset.date || todayStr();
    setPref({ view: 'gantt', plan: 'day' });
  },
  'go-diary': () => {
    focusDate.diary = todayStr();
    setPref({ view: 'diary' });
  },
  'delete-project': (el) => {
    const id = el.dataset.id;
    commit((s) => {
      const now = Date.now();
      s.projects = s.projects.filter((p) => p.id !== id);
      s.deleted[id] = now;
      for (const t of s.tasks) {
        if (t.projectId === id) {
          t.projectId = '';
          t.updatedAt = now;
        }
      }
    }, { undo: '已刪除專案，任務移到未分類' });
    if (prefs.project === id) setPref({ project: '' });
  },
  'sync-now': () => syncNow(),
  'sync-on': async () => {
    const input = document.getElementById('gh-token');
    const token = input?.value.trim();
    if (!token) {
      input?.focus();
      return;
    }
    const ok = await connect(token);
    toast(ok ? '同步已開啟' : syncStatus.message);
    rerender();
  },
  'sync-off': () => {
    disconnect();
    toast('已中斷連結，資料仍留在這台裝置');
    rerender();
  },
  'export-csv': () => download(`日常甘特_${todayStr()}.csv`, toCSV(state, todayStr()), 'text/csv;charset=utf-8'),
  'export-json': () => download(`日常甘特備份_${todayStr()}.json`, JSON.stringify(state, null, 2), 'application/json'),
  'import-xlsx': () => pickFile('.xlsx', async (file) => {
    const { parseWorkbook, applyWorkbook } = await import('./xlsx.js');
    applyWorkbook(await parseWorkbook(await file.arrayBuffer()));
  }),
  'import-json': () => pickFile('.json,application/json', async (file) => {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tasks)) throw new Error('not a backup');
    if (!confirm(`要用這份備份（${data.tasks.length} 項任務）取代目前的資料嗎？`)) return;
    replaceAll(normalize(data), { undo: '已從備份還原' });
  }),
  'clear-all': () => {
    if (!state.tasks.length) return;
    if (!confirm(`要清除全部 ${state.tasks.length} 項任務嗎？`)) return;
    commit((s) => {
      const now = Date.now();
      for (const t of s.tasks) s.deleted[t.id] = now;
      s.tasks = [];
    }, { undo: '已清除所有任務' });
  },
});

let rerender = () => {};
export const setRerender = (fn) => (rerender = fn);

function pickFile(accept, handler) {
  const input = document.getElementById('file-input');
  input.value = '';
  input.accept = accept;
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      await handler(file);
    } catch {
      toast('無法讀取這個檔案');
    }
  };
  input.click();
}

function applyColor(target, id, value) {
  const now = Date.now();
  commit((s) => {
    if (target === 'project') {
      const p = getProject(id);
      if (p && value) {
        p.color = value;
        p.updatedAt = now;
      }
    } else if (target === 'status' && value) {
      s.settings.statusColors = { ...s.settings.statusColors, [id]: value };
      s.settings.updatedAt = now;
    } else if (target === 'task') {
      const t = getTask(id);
      if (t) {
        t.color = value;
        touch(t);
      }
    } else if (target === 'block') {
      const b = s.blocks.find((x) => x.id === id);
      if (b) {
        b.color = value;
        b.updatedAt = now;
      }
    }
  });
}

let appliedColors = '';
export function applyStatusColors() {
  const colors = state.settings.statusColors;
  const key = JSON.stringify(colors);
  if (key === appliedColors) return;
  appliedColors = key;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(colors)) {
    root.setProperty(`--s-${k}`, v);
    root.setProperty(`--ink-${k}`, inkOn(v));
  }
}

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
}

const quickAdd = (el, fn) => {
  const title = el.value.trim();
  if (!title) return;
  shell.refocus = el.dataset.keep;
  el.value = '';
  fn(title);
};

Object.assign(enters, {
  'quick-today': (el) => quickAdd(el, (title) => {
    const today = todayStr();
    addTask({ title, start: today, end: today });
  }),
  'quick-diary': (el) => quickAdd(el, (text) => {
    const date = todayStr();
    const d = new Date();
    const line = `- ${fmtMinute(d.getHours() * 60 + d.getMinutes())} ${text}`;
    const body = diaryBody(date).trimEnd();
    saveDiary(date, body ? `${body}${/^\s*- /.test(body.split('\n').pop()) ? '\n' : '\n\n'}${line}` : line);
    toast('已記到今天的日記');
  }),
  'quick-sub': (el) => quickAdd(el, (title) => {
    const t = getTask(el.dataset.id);
    commit(() => {
      t.subtasks.push(makeSub({ title, start: t.start, end: t.end }));
      fitParentToSubs(t);
      touch(t);
    });
  }),
  'add-project': (el) => quickAdd(el, (name) => {
    commit((s) => {
      s.projects.push({ id: newId(), name, color: PALETTE[s.projects.length % PALETTE.length], updatedAt: Date.now() });
    });
  }),
  'sync-on': () => actions['sync-on'](),
});

Object.assign(inputs, {
  'project-name': (el) => {
    const p = getProject(el.dataset.id);
    commit(() => {
      p.name = el.value;
      p.updatedAt = Date.now();
    });
  },
});

Object.assign(changes, {
  'pick-color-custom': (el) => {
    applyColor(el.dataset.target, el.dataset.id, el.value);
    el.parentElement.style.background = el.value;
    el.closest('.color-row').querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === el.parentElement));
  },
  'hide-done': (el) => setPref({ hideDone: el.checked }),
  'base-monday': (el) => {
    if (!el.value) return;
    commit((s) => {
      s.settings.baseMonday = el.value;
      s.settings.updatedAt = Date.now();
    });
  },
  'base-week': (el) => {
    const n = parseInt(el.value, 10);
    if (Number.isNaN(n)) return;
    commit((s) => {
      s.settings.baseWeek = n;
      s.settings.updatedAt = Date.now();
    });
  },
});
