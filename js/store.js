// App state: one normalized document, persisted to localStorage, shared by every view.
import { DATA_VERSION, addDays, defaultState, makeSub, makeTask, merge, normalize, sameDocument, statusOf, todayStr } from './core.js';
import { toast } from './ui.js';

const DATA_KEY = 'dg.data.v1';
const PREFS_KEY = 'dg.prefs.v1';
const BACKUP_KEY = 'dg.data.before-v2';
const LAYERS_KEY = 'dg.data.layers';

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

// Upgrades keep the same storage key. A copy of the old document stays beside it as a safety net.
const saved = readJSON(DATA_KEY);
if (saved && !(saved.version >= DATA_VERSION) && localStorage.getItem(BACKUP_KEY) === null) {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(saved));
  } catch { /* the upgrade itself drops nothing, so this copy is only extra safety */ }
}

// A tab still running the first version rewrites the document without the time table and
// diary it has never heard of. This copy brings them back.
if (saved && !(saved.version >= DATA_VERSION)) {
  const layers = readJSON(LAYERS_KEY);
  if (layers) Object.assign(saved, { blocks: layers.blocks, diary: layers.diary });
}

export let state = normalize(saved || defaultState());

// Per-device view preferences. These are not synced.
export const prefs = {
  view: 'today', plan: 'week', compact: false, hideDone: false, sort: 'manual', group: 'project',
  project: '', status: '', theme: 'system', collapsed: {}, expanded: {}, barColor: 'status', calDim: true,
  ...readJSON(PREFS_KEY),
};
// The first version's zoom setting becomes the plan scale; its day zoom is now the time table.
if (prefs.zoom === 'month') prefs.plan = 'month';
delete prefs.zoom;
prefs.status = ''; // a status filter is a one-off drill-down, not a saved view

// Which day the planner and the diary are showing; null means today.
export const focusDate = { plan: null, diary: null };

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
const dataListeners = new Set();
export const onDataChange = (fn) => dataListeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

let persistTimer = 0;
function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(state));
    localStorage.setItem(LAYERS_KEY, JSON.stringify({ blocks: state.blocks, diary: state.diary }));
  } catch {
    toast('無法儲存到這個瀏覽器，請先匯出備份');
  }
}
window.addEventListener('pagehide', () => persistTimer && persistNow());

// Another tab saved. Merge rather than adopt, so neither tab's latest work is overwritten.
window.addEventListener('storage', (e) => {
  if (e.key !== DATA_KEY || !e.newValue) return;
  let incoming;
  try {
    incoming = normalize(JSON.parse(e.newValue));
  } catch {
    return;
  }
  const merged = merge(state, incoming);
  const differs = !sameDocument(merged, incoming);
  state = merged;
  if (differs) persistNow(); // the other tab is behind, or dropped something it doesn't know
  notify();
});

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* preferences are a convenience; losing them is harmless */ }
}

export function setPref(patch) {
  Object.assign(prefs, patch);
  savePrefs();
  notify();
}

// Writing to disk is deferred so a tap never waits on serialization.
export function commit(fn, { undo } = {}) {
  const before = undo ? JSON.stringify(state) : null;
  const result = fn(state);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 200);
  dataListeners.forEach((l) => l());
  notify();
  if (undo) toast(undo, () => restore(before));
  return result;
}

// Restored items get a fresh timestamp, otherwise sync would treat them as older
// than the deletion or edit being undone and bring that back.
// Undoing a task change must not rewind diary text typed since then, so only an undo that
// replaced the whole document brings the diary back too.
function restore(snapshot, { withDiary = false } = {}) {
  const next = normalize(JSON.parse(snapshot));
  if (!withDiary) next.diary = state.diary;
  const now = Date.now();
  for (const key of ['tasks', 'blocks', 'diary']) {
    const previous = new Map(state[key].map((x) => [x.id, JSON.stringify(x)]));
    for (const x of next[key]) {
      if (previous.get(x.id) !== JSON.stringify(x)) {
        x.updatedAt = now;
        delete next.deleted[x.id];
      }
    }
  }
  state = next;
  commit(() => {});
}

// Replaces the document without notifying sync (the change came from sync).
export function replaceFromSync(next) {
  state = next;
  persistNow();
  notify();
}

export function replaceAll(next, { undo } = {}) {
  const before = undo ? JSON.stringify(state) : null;
  state = normalize(next);
  commit(() => {});
  if (undo) toast(undo, () => restore(before, { withDiary: true }));
}

export function requestPersistentStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

/* ---------- Selectors ---------- */

export const getTask = (id) => state.tasks.find((t) => t.id === id);
export const getProject = (id) => state.projects.find((p) => p.id === id);

export function visibleTasks(today = todayStr()) {
  let list = state.tasks.filter((t) => {
    if (prefs.project === '__none') {
      if (t.projectId && getProject(t.projectId)) return false;
    } else if (prefs.project && t.projectId !== prefs.project) return false;
    const st = statusOf(t, today);
    if (prefs.status && st !== prefs.status) return false;
    if (prefs.hideDone && !prefs.status && st === 'done') return false;
    return true;
  });
  list = list.sort((a, b) => a.order - b.order);
  if (prefs.sort === 'start') {
    list.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.order - b.order);
  }
  return list;
}

/* ---------- Mutations used from several views ---------- */

export function touch(task) {
  task.updatedAt = Date.now();
}

export function addTask(fields) {
  return commit((s) => {
    const t = makeTask(fields);
    s.tasks.push(t);
    return t;
  });
}

export function saveDiary(date, body) {
  commit((s) => {
    const entry = s.diary.find((d) => d.date === date);
    if (entry) {
      entry.body = body;
      entry.updatedAt = Date.now();
    } else s.diary.push({ id: `diary-${date}`, date, body, updatedAt: Date.now() });
  });
}

export const diaryBody = (date) => state.diary.find((d) => d.date === date)?.body || '';

export const taskColor = (t) => t?.color || getProject(t?.projectId)?.color || '';

// A block shows its task's current name and color; its own title is the fallback once the
// task has been deleted.
export function blockInfo(b) {
  const t = b.taskId ? getTask(b.taskId) : null;
  const sub = t && b.subId ? t.subtasks.find((s) => s.id === b.subId) : null;
  return {
    title: sub?.title || t?.title || b.title || '未命名時段',
    color: b.color || taskColor(t) || '',
    task: t,
  };
}

export function deleteTask(id, { silent } = {}) {
  commit(
    (s) => {
      s.tasks = s.tasks.filter((t) => t.id !== id);
      s.deleted[id] = Date.now();
    },
    silent ? {} : { undo: '已刪除任務' },
  );
}

export function loadSample() {
  const d = todayStr();
  const at = (n) => addDays(d, n);
  const school = state.projects[1]?.id || '';
  const intern = state.projects[0]?.id || '';
  const personal = state.projects[3]?.id || '';
  const base = Date.now();
  const samples = [
    makeTask({
      title: '期末報告', projectId: school, start: at(-3), end: at(9), priority: 2, order: base,
      notes: '這是範例任務，可以直接刪除。',
      subtasks: [
        makeSub({ title: '蒐集資料', start: at(-3), end: at(-1), done: true }),
        makeSub({ title: '寫大綱', start: at(0), end: at(2) }),
        makeSub({ title: '完成初稿', start: at(3), end: at(7) }),
        makeSub({ title: '校對與繳交', start: at(8), end: at(9) }),
      ],
    }),
    makeTask({ title: '更新履歷', projectId: intern, start: at(-6), end: at(-1), progress: 60, priority: 3, order: base + 1 }),
    makeTask({ title: '面試準備', projectId: intern, start: at(4), end: at(10), order: base + 2 }),
    makeTask({ title: '繳交申請表', projectId: school, start: at(2), end: at(2), priority: 1, order: base + 3 }),
    makeTask({ title: '整理房間', projectId: personal, start: at(-8), end: at(-4), progress: 100, order: base + 4 }),
  ];
  commit((s) => s.tasks.push(...samples), { undo: '已載入範例' });
}
