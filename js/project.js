// One project's workspace: overview and progress, a timeline with milestones, the task list,
// links, inspiration notes and its Google Drive folder. Drive goes through the same Apps Script
// as Google Calendar (gcal.js), so it needs no Google Cloud project either.
import {
  STATUS, fmtMD, fmtRange, fromDay, isDone, makeMilestone, mondayOf, percent, statusOf, toDay, todayStr,
} from './core.js';
import { addTask, commit, getProject, prefs, setPref, state } from './store.js';
import { actions, changes, colorRowHTML, enters, esc, icon, inputs, toast } from './ui.js';
import { taskRow } from './views.js';
import { openTask } from './sheet.js';
import { gcalConnected, googleCall, isOutdatedScript } from './gcal.js';

let requestRender = () => {};
export const setProjectRender = (fn) => (requestRender = fn);

const current = () => getProject(prefs.projectPage);

export function openProject(id) {
  if (!getProject(id)) return;
  const back = prefs.view === 'project' ? prefs.projectBack : prefs.view;
  setPref({ view: 'project', projectPage: id, projectBack: back || 'tasks' });
}

/* ---------- Small helpers ---------- */

const RANK = { late: 0, doing: 1, todo: 2, nodate: 3, bad: 3, done: 4 };
const projectTasks = (p) => state.tasks.filter((t) => t.projectId === p.id && !t.archivedAt);
const dayCount = (a, b) => toDay(b) - toDay(a);
const shortDate = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Folder or file id out of anything a user might paste from Drive.
function driveIdFrom(text) {
  const s = String(text || '').trim();
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/\/d\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : '';
}

const KINDS = {
  'application/vnd.google-apps.folder': ['夾', 'folder', '資料夾'],
  'application/vnd.google-apps.document': ['文', 'doc', '文件'],
  'application/vnd.google-apps.spreadsheet': ['表', 'sheet', '試算表'],
  'application/vnd.google-apps.presentation': ['簡', 'slide', '簡報'],
  'application/pdf': ['PDF', 'pdf', 'PDF'],
};
export function fileBadge(mime) {
  const [mark, cls] = KINDS[mime] || (String(mime).startsWith('image/') ? ['圖', 'image'] : ['檔', 'file']);
  return `<span class="file-badge fb-${cls}" aria-hidden="true">${mark}</span>`;
}

function saveProject(fn, opts) {
  const p = current();
  if (!p) return;
  commit(() => {
    fn(p);
    p.updatedAt = Date.now();
  }, opts);
}

/* ---------- Google Drive state (per page visit) ---------- */

const drive = { projectId: '', files: null, loading: false, error: '', outdated: false, noteStatus: '', noteChecked: '' };

async function loadFiles(p, { force = false } = {}) {
  if (!gcalConnected() || !p.drive.folderId) return;
  if (drive.loading || (!force && drive.projectId === p.id && drive.files)) return;
  drive.projectId = p.id;
  drive.loading = true;
  drive.error = '';
  requestRender();
  try {
    const list = await googleCall('driveList', { id: p.drive.folderId });
    drive.files = list.sort((a, b) => Number(b.mime.endsWith('folder')) - Number(a.mime.endsWith('folder')) || b.updated - a.updated);
    drive.outdated = false;
  } catch (err) {
    drive.files = [];
    drive.outdated = isOutdatedScript(err);
    drive.error = drive.outdated ? '' : err.status === 404 ? '找不到這個資料夾，可能已被刪除或沒有權限' : '暫時無法讀取 Drive';
  } finally {
    drive.loading = false;
    requestRender();
  }
}

// The notes document may have been edited in Google Docs: bring that back once per visit.
async function pullNotes(p) {
  if (!gcalConnected() || !p.drive.docId || drive.noteChecked === p.id) return;
  drive.noteChecked = p.id;
  try {
    const doc = await googleCall('noteRead', { id: p.drive.docId });
    const text = doc.text.replace(/\n$/, '');
    if (doc.updated > p.drive.docSyncedAt + 3000 && text !== p.notes) {
      saveProject((x) => {
        x.notes = text;
        x.drive.docSyncedAt = doc.updated;
      });
      toast('已讀回在 Google 文件裡修改的筆記');
    }
  } catch (err) {
    if (isOutdatedScript(err)) drive.outdated = true;
    else if (err.status === 404) {
      saveProject((x) => Object.assign(x.drive, { docId: '', docUrl: '', docSyncedAt: 0 }), { silent: true });
    }
  }
}

let noteTimer = 0;
function pushNotesSoon() {
  clearTimeout(noteTimer);
  const p = current();
  if (!p || !gcalConnected()) return;
  setNoteStatus('編輯中…');
  noteTimer = setTimeout(async () => {
    const q = getProject(p.id);
    if (!q) return;
    setNoteStatus('正在存到 Drive…');
    try {
      const doc = await googleCall('noteWrite', { id: q.drive.docId || undefined, folderId: q.drive.folderId || undefined, name: `${q.name} 筆記`, text: q.notes });
      commit(() => {
        Object.assign(q.drive, { docId: doc.id, docUrl: doc.url, docSyncedAt: doc.updated });
      }, { silent: true });
      setNoteStatus('已存到 Google 文件');
      if (drive.projectId === q.id) drive.files = null; // the folder now holds the document
    } catch (err) {
      if (isOutdatedScript(err)) drive.outdated = true;
      setNoteStatus(drive.outdated ? '要先更新 Apps Script 才能存到 Drive' : '存到 Drive 失敗，稍後再編輯會再試一次');
    }
  }, 2500);
}

function setNoteStatus(text) {
  drive.noteStatus = text;
  const el = document.getElementById('pj-note-status');
  if (el) el.textContent = text;
}

/* ---------- Timeline ---------- */

const textWidth = (str, px) => [...String(str)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? px : px * 0.6), 0);

function timelineHTML(p, tasks, today, trackPx) {
  const dated = tasks.filter((t) => t.start && t.end && t.end >= t.start);
  const marks = p.milestones.filter((m) => m.date);
  const days = [today, ...dated.flatMap((t) => [t.start, t.end]), ...marks.map((m) => m.date), ...(p.deadline ? [p.deadline] : [])].map(toDay);
  if (dated.length + marks.length === 0) {
    return '<p class="pj-empty">任務有了日期、或新增里程碑之後，時程會畫在這裡。</p>';
  }
  const start = Math.min(...days) - 2;
  const end = Math.max(...days) + 2;
  const span = end - start + 1;
  const x = (d) => ((d - start) / span) * 100;
  const step = span <= 70 ? 7 : span <= 200 ? 14 : 30;
  const ticks = [];
  for (let d = mondayOf(start) + (mondayOf(start) < start ? 7 : 0); d <= end; d += step) ticks.push(d);
  const tickHTML = ticks.map((d) => `<span class="pj-tick" style="left:${x(d)}%">${fmtMD(fromDay(d))}</span>`).join('');
  const grid = ticks.map((d) => `<i class="pj-grid" style="left:${x(d)}%"></i>`).join('');
  const now = `<i class="pj-now" style="left:${x(toDay(today) + 0.5)}%" title="今天"></i>`;
  const deadline = p.deadline ? `<i class="pj-deadline" style="left:${x(toDay(p.deadline) + 1)}%"><span>截止 ${fmtMD(p.deadline)}</span></i>` : '';
  const flags = marks.map((m) => `<button type="button" class="pj-flag ${m.done ? 'is-done' : ''}" style="left:${x(toDay(m.date) + 0.5)}%" data-act="pj-ms-focus" data-id="${esc(m.id)}" title="${esc(m.title)}｜${esc(fmtMD(m.date))}">
      <i></i><span>${esc(m.title) || '里程碑'}</span></button>`).join('');
  const rows = dated.sort((a, b) => a.start.localeCompare(b.start) || a.order - b.order).map((t) => {
    const st = statusOf(t, today);
    const l = x(toDay(t.start));
    const w = Math.max(x(toDay(t.end) + 1) - l, 1.2);
    const name = esc(t.title) || '未命名任務';
    // Like the main Gantt: the name sits inside when it fits, otherwise right after the bar.
    const fits = (w / 100) * trackPx > textWidth(t.title || '未命名任務', 12) + 18;
    const outLeft = l + w;
    return `<div class="pj-row">
      <button type="button" class="pj-bar s-${STATUS[st].cls} ${st === 'done' ? 'is-done' : ''}" style="left:${l}%;width:${w}%" data-act="open-task" data-id="${esc(t.id)}" title="${name}｜${esc(fmtRange(t.start, t.end))}｜${STATUS[st].label}">
        ${fits ? `<span>${name}</span>` : ''}</button>
      ${fits ? '' : `<span class="pj-bar-out ${st === 'done' ? 'is-done' : ''} ${outLeft > 70 ? 'flip' : ''}" style="${outLeft > 70 ? `right:${100 - l}%` : `left:${outLeft}%`}">${name}</span>`}
    </div>`;
  }).join('');
  return `<div class="pj-timeline">
    <div class="pj-axis">${tickHTML}</div>
    <div class="pj-lanes">${grid}${now}${deadline}
      <div class="pj-flags">${flags}</div>
      ${rows}
    </div>
  </div>`;
}

/* ---------- Cards ---------- */

function overviewHTML(p, tasks, today) {
  const counts = { late: 0, doing: 0, todo: 0, done: 0 };
  for (const t of tasks) {
    const st = statusOf(t, today);
    if (st in counts) counts[st] += 1;
    else counts.todo += 1;
  }
  const total = tasks.length;
  const pct = total ? Math.round(tasks.reduce((n, t) => n + (isDone(t) ? 100 : percent(t)), 0) / total) : 0;
  let due = '';
  if (p.deadline) {
    const left = dayCount(today, p.deadline);
    due = left > 0 ? `還有 ${left} 天` : left === 0 ? '今天截止' : `已超過 ${-left} 天`;
  }
  const stat = (k, label) => `<div class="pj-stat ${k}"><b>${counts[k]}</b><span>${label}</span></div>`;
  return `<section class="card pj-overview">
    <div class="pj-progress">
      <div class="pj-pct"><b>${pct}</b><span>%</span></div>
      <div class="pj-progress-main">
        <div class="pj-meter"><i style="width:${pct}%;background:${esc(p.color)}"></i></div>
        <p>${total ? `已完成 ${counts.done}／${total} 項任務` : '還沒有任務'}${due ? `<span class="${p.deadline < today ? 'text-late' : ''}">｜${due}</span>` : ''}</p>
      </div>
    </div>
    <div class="pj-stats">${stat('late', '逾期')}${stat('doing', '進行中')}${stat('todo', '未開始')}${stat('done', '已完成')}</div>
    <label class="pj-field"><span>目標</span>
      <textarea class="notes-input pj-goal" rows="2" placeholder="這個專案要達成什麼？" data-in="pj-goal" data-keep="pj-goal-${esc(p.id)}" aria-label="專案目標">${esc(p.goal)}</textarea></label>
    <div class="pj-field-row">
      <label class="pj-field"><span>截止日期</span><input type="date" class="field-date" value="${esc(p.deadline || '')}" data-ch="pj-deadline"></label>
      <label class="pj-field grow"><span>名稱</span><input type="text" class="bare pj-name" value="${esc(p.name)}" data-in="pj-name" data-keep="pj-name-${esc(p.id)}" maxlength="60" aria-label="專案名稱"></label>
    </div>
  </section>`;
}

function milestonesHTML(p, today) {
  const list = [...p.milestones].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const rows = list.map((m) => {
    const late = !m.done && m.date && m.date < today;
    return `<div class="row pj-ms ${m.done ? 'is-done' : ''}" data-ms="${esc(m.id)}">
      <button type="button" class="check small ${m.done ? 'on' : ''}" data-act="pj-ms-done" data-id="${esc(m.id)}" role="checkbox" aria-checked="${m.done}" aria-label="完成：${esc(m.title)}"></button>
      <input type="text" class="bare pj-ms-title" value="${esc(m.title)}" placeholder="里程碑名稱" data-ch="pj-ms-title" data-id="${esc(m.id)}" maxlength="300" aria-label="里程碑名稱">
      <input type="date" class="field-date ${late ? 'late' : ''}" value="${esc(m.date || '')}" data-ch="pj-ms-date" data-id="${esc(m.id)}" aria-label="里程碑日期">
      <button type="button" class="icon-btn danger" data-act="pj-ms-delete" data-id="${esc(m.id)}" aria-label="刪除里程碑">${icon.trash}</button>
    </div>`;
  }).join('');
  return `<section class="group"><h2 class="group-head">里程碑<span class="group-count">${p.milestones.length || ''}</span></h2>
    <div class="card">${rows}
      <div class="row form-row"><span class="add-mark">${icon.plus}</span>
        <input type="text" class="bare" placeholder="新增里程碑，例如：期中報告" enterkeyhint="done" data-enter="pj-ms-add" data-keep="pj-ms-add" aria-label="新增里程碑" maxlength="300">
        <input type="date" class="field-date" id="pj-ms-date" value="${esc(p.deadline || today)}" aria-label="新里程碑的日期"></div>
    </div></section>`;
}

function tasksHTML(p, tasks, today) {
  const sorted = [...tasks].sort((a, b) => RANK[statusOf(a, today)] - RANK[statusOf(b, today)] || a.order - b.order);
  const open = sorted.filter((t) => !isDone(t));
  const done = sorted.filter(isDone);
  const rows = open.map((t) => taskRow(t, today)).join('');
  const doneRows = prefs.projectShowDone ? done.map((t) => taskRow(t, today)).join('') : '';
  return `<section class="group"><h2 class="group-head">任務<span class="group-count">${open.length}</span></h2>
    <div class="card">${rows || '<p class="pj-empty">還沒有進行中的任務。</p>'}
      <div class="row form-row"><span class="add-mark">${icon.plus}</span>
        <input type="text" class="bare" placeholder="新增任務到「${esc(p.name)}」，按 Enter" enterkeyhint="done" data-enter="pj-task-add" data-keep="pj-task-add" aria-label="新增任務" maxlength="300"></div>
    </div>
    ${done.length ? `<button type="button" class="group-head fold-head" data-act="pj-toggle-done" aria-expanded="${!!prefs.projectShowDone}">${icon.chevR}已完成<span class="group-count">${done.length}</span></button>
      ${doneRows ? `<div class="card">${doneRows}</div>` : ''}` : ''}
  </section>`;
}

function linksHTML(p) {
  const rows = p.links.map((l, i) => `<div class="row pj-link">
      <a class="pj-link-main" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${icon.link}<span><b>${esc(l.title || hostOf(l.url))}</b><small>${esc(hostOf(l.url))}</small></span></a>
      <button type="button" class="icon-btn danger" data-act="pj-link-delete" data-i="${i}" aria-label="移除連結">${icon.x}</button>
    </div>`).join('');
  return `<section class="group"><h2 class="group-head">連結<span class="group-count">${p.links.length || ''}</span></h2>
    <div class="card">${rows}
      <div class="row form-row"><span class="add-mark">${icon.plus}</span>
        <input type="url" class="bare" inputmode="url" placeholder="貼上網址，按 Enter" enterkeyhint="done" data-enter="pj-link-add" data-keep="pj-link-add" aria-label="新增連結"></div>
      <div class="row form-row"><input type="text" class="bare pj-link-title" id="pj-link-title" placeholder="名稱（選填）" maxlength="200" aria-label="連結名稱"></div>
    </div></section>`;
}

function notesHTML(p) {
  const status = drive.noteStatus || (p.drive.docId ? '同步到 Google 文件' : gcalConnected() ? '開始寫就會存成 Google 文件' : '');
  return `<section class="group"><h2 class="group-head">靈感筆記
      ${p.drive.docUrl ? `<a class="text-btn head-link" href="${esc(p.drive.docUrl)}" target="_blank" rel="noopener">在 Google 文件開啟</a>` : ''}</h2>
    <div class="card"><div class="row form-row notes-row">
      <textarea class="notes-input pj-notes" rows="8" placeholder="想法、參考、會議紀錄…都可以先丟在這裡" data-in="pj-notes" data-keep="pj-notes-${esc(p.id)}" aria-label="靈感筆記">${esc(p.notes)}</textarea>
    </div></div>
    ${status ? `<p class="group-foot" id="pj-note-status">${esc(status)}</p>` : '<p class="group-foot" id="pj-note-status"></p>'}
  </section>`;
}

function driveHTML(p) {
  let body;
  if (!gcalConnected()) {
    body = `<p class="pj-empty">先在設定連結 Google（Apps Script），就能把這個專案連到雲端硬碟資料夾。</p>
      <button type="button" class="row form-row link-row" data-act="nav" data-v="settings">前往設定</button>`;
  } else if (drive.outdated) {
    body = `<p class="pj-empty">你的 Apps Script 還是舊版，不認得雲端硬碟的指令。請到設定複製新版程式碼，貼回 Apps Script 後選「管理部署作業 → 編輯 → 新版本」。</p>
      <button type="button" class="row form-row link-row" data-act="gcal-copy-script">複製新版 Apps Script 程式碼</button>
      <button type="button" class="row form-row link-row" data-act="pj-drive-retry">更新好了，重新讀取</button>`;
  } else if (!p.drive.folderId) {
    body = `<button type="button" class="row form-row link-row" data-act="pj-drive-new">在雲端硬碟建立「${esc(p.name)}」資料夾</button>
      <div class="row form-row"><input type="url" class="bare" placeholder="或貼上已有的資料夾連結，按 Enter" enterkeyhint="done" data-enter="pj-drive-link" data-keep="pj-drive-link" aria-label="資料夾連結"></div>`;
  } else {
    const files = drive.projectId === p.id ? drive.files : null;
    const list = drive.loading && !files ? '<p class="pj-empty">讀取中…</p>'
      : drive.error ? `<p class="pj-empty text-late">${esc(drive.error)}</p>`
        : files && files.length ? files.map((f) => `<a class="row pj-file" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">
            ${fileBadge(f.mime)}<span class="pj-file-name">${esc(f.name)}</span><small>${esc(shortDate(f.updated))}</small></a>`).join('')
          : files ? '<p class="pj-empty">資料夾是空的。</p>' : '';
    body = `<div class="row pj-folder">${fileBadge('application/vnd.google-apps.folder')}
        <a class="pj-file-name" href="${esc(p.drive.folderUrl)}" target="_blank" rel="noopener noreferrer"><b>${esc(p.drive.folderName || '專案資料夾')}</b></a>
        <button type="button" class="icon-btn" data-act="pj-drive-refresh" aria-label="重新整理" title="重新整理">↻</button>
        <button type="button" class="text-btn" data-act="pj-drive-unlink">取消連結</button></div>
      <div class="pj-files">${list}</div>
      <div class="pj-create">
        <span>新增</span>
        <button type="button" class="chip" data-act="pj-drive-create" data-kind="doc">${fileBadge('application/vnd.google-apps.document')}文件</button>
        <button type="button" class="chip" data-act="pj-drive-create" data-kind="sheet">${fileBadge('application/vnd.google-apps.spreadsheet')}試算表</button>
        <button type="button" class="chip" data-act="pj-drive-create" data-kind="slide">${fileBadge('application/vnd.google-apps.presentation')}簡報</button>
      </div>`;
  }
  return `<section class="group"><h2 class="group-head">Google 雲端硬碟</h2><div class="card pj-drive">${body}</div></section>`;
}

/* ---------- Page ---------- */

// The timeline's width in pixels, to know which names fit inside their bars.
function trackWidth(main) {
  const w = main.clientWidth || innerWidth;
  return Math.max(240, w - (w >= 1100 ? 384 : 0) - 96);
}

export function renderProject(main) {
  const p = current();
  if (!p) {
    setPref({ view: 'tasks' });
    return;
  }
  const today = todayStr();
  const tasks = projectTasks(p);
  if (drive.projectId !== p.id) Object.assign(drive, { projectId: p.id, files: null, error: '', noteStatus: '' });
  loadFiles(p);
  pullNotes(p);

  const back = { tasks: '任務', gantt: '計畫', today: '今天', settings: '設定', diary: '日記' }[prefs.projectBack] || '任務';
  main.innerHTML = `<div class="view-body pj-view" data-scroll="project-${esc(p.id)}">
    <header class="large-head pj-head">
      <div class="large-title">
        <button type="button" class="text-btn pj-back" data-act="pj-back">${icon.back}${esc(back)}</button>
        <h1><i class="dot pj-dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</h1>
        ${p.goal ? `<p>${esc(p.goal.split('\n')[0])}</p>` : ''}
      </div>
      <div class="head-actions">
        <button type="button" class="btn-circle" data-act="pj-color" aria-label="專案顏色" title="專案顏色" aria-expanded="${!!prefs.projectColorOpen}"><i class="dot" style="background:${esc(p.color)};width:14px;height:14px"></i></button>
        <button type="button" class="btn-circle tint" data-act="pj-new-task" aria-label="新增任務" title="新增任務">${icon.plus}</button>
      </div>
    </header>
    ${prefs.projectColorOpen ? `<div class="card pad pj-colors">${colorRowHTML({ value: p.color, target: 'project', id: p.id })}</div>` : ''}
    <div class="pj-grid">
      <div class="pj-main">
        ${overviewHTML(p, tasks, today)}
        <section class="group"><h2 class="group-head">時程</h2><div class="card pad">${timelineHTML(p, tasks, today, trackWidth(main))}</div></section>
        ${milestonesHTML(p, today)}
        ${tasksHTML(p, tasks, today)}
      </div>
      <aside class="pj-side">
        ${driveHTML(p)}
        ${linksHTML(p)}
        ${notesHTML(p)}
      </aside>
    </div>
  </div>`;
}

/* ---------- Handlers ---------- */

Object.assign(actions, {
  'open-project': (el) => openProject(el.dataset.id),
  'pj-back': () => setPref({ view: prefs.projectBack || 'tasks' }),
  'pj-color': () => setPref({ projectColorOpen: !prefs.projectColorOpen }),
  'pj-new-task': () => {
    const p = current();
    if (!p) return;
    const today = todayStr();
    const t = addTask({ title: '', projectId: p.id, start: today, end: today });
    openTask(t.id, { isNew: true });
  },
  'pj-toggle-done': () => setPref({ projectShowDone: !prefs.projectShowDone }),
  'pj-ms-done': (el) => saveProject((p) => {
    const m = p.milestones.find((x) => x.id === el.dataset.id);
    if (m) m.done = !m.done;
  }),
  'pj-ms-delete': (el) => saveProject((p) => {
    p.milestones = p.milestones.filter((x) => x.id !== el.dataset.id);
  }, { undo: '已刪除里程碑' }),
  'pj-ms-focus': (el) => document.querySelector(`.pj-ms[data-ms="${CSS.escape(el.dataset.id)}"] .pj-ms-title`)?.focus(),
  'pj-link-delete': (el) => saveProject((p) => {
    p.links.splice(Number(el.dataset.i), 1);
  }, { undo: '已移除連結' }),
  'pj-drive-new': async () => {
    const p = current();
    if (!p) return;
    try {
      const f = await googleCall('driveNewFolder', { name: p.name });
      saveProject((x) => Object.assign(x.drive, { folderId: f.id, folderName: f.name, folderUrl: f.url }));
      drive.files = null;
      toast(`已在雲端硬碟建立「${f.name}」`);
    } catch (err) {
      drive.outdated = isOutdatedScript(err);
      toast(drive.outdated ? '要先更新 Apps Script' : '建立資料夾失敗');
      requestRender();
    }
  },
  'pj-drive-refresh': () => {
    const p = current();
    if (p) loadFiles(p, { force: true });
  },
  'pj-drive-retry': () => {
    drive.outdated = false;
    drive.files = null;
    drive.noteChecked = '';
    requestRender();
  },
  'pj-drive-unlink': () => saveProject((p) => Object.assign(p.drive, { folderId: '', folderName: '', folderUrl: '' }), { undo: '已取消連結資料夾（雲端硬碟裡的檔案不受影響）' }),
  'pj-drive-create': async (el) => {
    const p = current();
    if (!p) return;
    const label = { doc: '文件', sheet: '試算表', slide: '簡報' }[el.dataset.kind];
    const name = prompt(`新${label}的名稱`, `${p.name} ${label}`);
    if (!name) return;
    const win = window.open('', '_blank'); // opened now, while the tap still counts, so it isn't blocked
    try {
      const f = await googleCall('driveCreate', { kind: el.dataset.kind, name, folderId: p.drive.folderId });
      if (win) win.location = f.url;
      drive.files = [f, ...(drive.files || [])];
      requestRender();
    } catch (err) {
      win?.close();
      drive.outdated = isOutdatedScript(err);
      toast(drive.outdated ? '要先更新 Apps Script' : `建立${label}失敗`);
      requestRender();
    }
  },
});

Object.assign(inputs, {
  'pj-goal': (el) => saveProject((p) => (p.goal = el.value), { silent: true }),
  'pj-name': (el) => saveProject((p) => (p.name = el.value.slice(0, 60) || p.name), { silent: true }),
  'pj-notes': (el) => {
    saveProject((p) => (p.notes = el.value), { silent: true });
    pushNotesSoon();
  },
});

Object.assign(changes, {
  'pj-deadline': (el) => saveProject((p) => (p.deadline = el.value || null)),
  'pj-ms-title': (el) => saveProject((p) => {
    const m = p.milestones.find((x) => x.id === el.dataset.id);
    if (m) m.title = el.value;
  }),
  'pj-ms-date': (el) => saveProject((p) => {
    const m = p.milestones.find((x) => x.id === el.dataset.id);
    if (m) m.date = el.value || null;
  }),
});

Object.assign(enters, {
  'pj-task-add': (el) => {
    const p = current();
    const title = el.value.trim();
    if (!p || !title) return;
    el.value = '';
    const today = todayStr();
    addTask({ title, projectId: p.id, start: today, end: today });
  },
  'pj-ms-add': (el) => {
    const title = el.value.trim();
    if (!title) return;
    const date = document.getElementById('pj-ms-date')?.value || null;
    el.value = '';
    saveProject((p) => p.milestones.push(makeMilestone({ title, date })));
  },
  'pj-link-add': (el) => {
    let url = el.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const titleEl = document.getElementById('pj-link-title');
    const title = titleEl?.value.trim() || '';
    el.value = '';
    if (titleEl) titleEl.value = '';
    saveProject((p) => p.links.push({ url, title }));
  },
  'pj-drive-link': async (el) => {
    const id = driveIdFrom(el.value);
    if (!id) {
      toast('這看起來不是雲端硬碟資料夾的連結');
      return;
    }
    try {
      const f = await googleCall('driveFolder', { id });
      el.value = '';
      saveProject((p) => Object.assign(p.drive, { folderId: f.id, folderName: f.name, folderUrl: f.url }));
      drive.files = null;
    } catch (err) {
      drive.outdated = isOutdatedScript(err);
      toast(drive.outdated ? '要先更新 Apps Script' : '讀不到這個資料夾，請確認連結和權限');
      requestRender();
    }
  },
});

export { driveIdFrom };
