// Today, Tasks and Settings views, plus the row markup they share.
import {
  PALETTE, STATUS, WEEKDAYS, addDays, fitParentToSubs, fmtRange, makeSub, newId, normalize, percent, setDone,
  statusOf, subStatusOf, toCSV, toDay, todayStr, weekNumber, weekdayIdx,
} from './core.js';
import {
  addTask, commit, getProject, getTask, loadSample, prefs, replaceAll, setPref, state, touch, visibleTasks,
} from './store.js';
import { connect, disconnect, syncNow, syncStatus } from './sync.js';
import { actions, changes, download, enters, esc, icon, inputs, toast } from './ui.js';
import { openTask } from './sheet.js';

export const shell = {
  refocus: null, // data-keep key to put the caret back in after the next render
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

function taskRow(t, today, { subs = t.subtasks, expandable = true, showAdd = false } = {}) {
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
        </span>
      </button>
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

export function renderToday() {
  const today = todayStr();
  const day = toDay(today);
  const all = state.tasks;
  const [, m, d] = today.split('-').map(Number);
  const sub = `${m} 月 ${d} 日 星期${WEEKDAYS[weekdayIdx(day)]}｜第 ${weekNumber(day, state.settings)} 週`;
  const counts = { todo: 0, doing: 0, done: 0, late: 0 };
  for (const t of all) {
    const st = statusOf(t, today);
    if (st in counts) counts[st]++;
  }
  const tiles = ['doing', 'late', 'todo', 'done'].map((k) => `
    <button type="button" class="tile s-${k}" data-act="drill-status" data-status="${k}">
      <span class="tile-num">${counts[k]}</span><span class="tile-label"><i class="dot"></i>${STATUS[k].label}</span>
    </button>`).join('');

  // Subtasks already due or under way are the actual to-dos, so they show without expanding.
  const activeSubs = (t) => t.subtasks.filter((s) => !s.done && (!s.start || s.start <= today));
  const row = (t) => taskRow(t, today, { subs: activeSubs(t), expandable: false });
  const sorted = [...all].sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999') || a.order - b.order);
  const late = sorted.filter((t) => statusOf(t, today) === 'late');
  const doing = sorted.filter((t) => statusOf(t, today) === 'doing');
  const soon = sorted
    .filter((t) => statusOf(t, today) === 'todo' && t.start <= addDays(today, 7))
    .sort((a, b) => a.start.localeCompare(b.start));
  const nodate = sorted.filter((t) => ['nodate', 'bad'].includes(statusOf(t, today)));

  const quick = `<div class="quick-add card">
    <span class="add-mark">${icon.plus}</span>
    <input type="text" class="bare" placeholder="新增今天的任務，按 Enter" enterkeyhint="done" data-enter="quick-today" data-keep="today-add" aria-label="新增今天的任務">
  </div>`;

  const nothing = !late.length && !doing.length && !soon.length && !nodate.length;
  return `<div class="view-body" data-scroll="today">
    ${headerHTML('今天', sub)}
    ${all.length ? `<div class="tiles">${tiles}</div>${quick}` : emptyHTML()}
    ${late.length ? group('<span class="text-late">已逾期</span>', late.map(row).join('')) : ''}
    ${doing.length ? group('進行中', doing.map(row).join('')) : ''}
    ${soon.length ? group('接下來 7 天', soon.map(row).join('')) : ''}
    ${nodate.length ? group('需要補日期', nodate.map(row).join('')) : ''}
    ${all.length && nothing ? '<p class="all-clear">目前沒有待辦，今天很輕鬆。</p>' : ''}
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
      <button type="button" class="swatch" style="background:${esc(p.color)}" data-act="cycle-color" data-id="${esc(p.id)}" aria-label="更換 ${esc(p.name)} 的顏色"></button>
      <input type="text" class="bare" value="${esc(p.name)}" data-in="project-name" data-id="${esc(p.id)}" aria-label="專案名稱" maxlength="60">
      <button type="button" class="icon-btn danger" data-act="delete-project" data-id="${esc(p.id)}" aria-label="刪除專案 ${esc(p.name)}">${icon.trash}</button>
    </div>`).join('');

  const sync = connected
    ? `<div class="row form-row"><span class="form-label">狀態</span><span class="form-value ${syncStatus.state === 'error' ? 'text-late' : ''}" id="sync-line">${esc(syncLine())}</span></div>
       <button type="button" class="row form-row link-row" data-act="sync-now">立即同步</button>
       <button type="button" class="row form-row link-row destructive" data-act="sync-off">中斷連結</button>`
    : `<div class="row form-row"><input type="password" class="bare" id="gh-token" placeholder="貼上 GitHub 權杖" autocomplete="off" autocapitalize="off" spellcheck="false" data-enter="sync-on" aria-label="GitHub 權杖"></div>
       <button type="button" class="row form-row link-row" data-act="sync-on">連結同步</button>`;

  return `<div class="view-body narrow" data-scroll="settings">
    ${headerHTML('設定', '')}

    <section class="group"><h2 class="group-head">外觀</h2><div class="card pad"><div class="seg wide" role="group" aria-label="外觀">${theme}</div></div></section>

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
  'cycle-color': (el) => {
    const p = getProject(el.dataset.id);
    commit(() => {
      p.color = PALETTE[(PALETTE.indexOf(p.color) + 1) % PALETTE.length];
      p.updatedAt = Date.now();
    });
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
