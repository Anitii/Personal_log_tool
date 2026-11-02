// Pure logic only (no DOM), so it can be unit-tested under Node.

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
export const PALETTE = ['#0071E3', '#248A3D', '#C93400', '#8944AB', '#00798C', '#D70015', '#B25000', '#636366'];

export const STATUS = {
  todo: { label: '未開始', cls: 'todo' },
  doing: { label: '進行中', cls: 'doing' },
  done: { label: '已完成', cls: 'done' },
  late: { label: '已逾期', cls: 'late' },
  nodate: { label: '待填日期', cls: 'warn' },
  bad: { label: '日期錯誤', cls: 'warn' },
};

/* ---------- Dates: calendar days as integers, so DST can never shift a bar ---------- */

export const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
export const toDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};
export const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const weekdayIdx = (n) => (((n + 3) % 7) + 7) % 7; // Monday = 0
export const mondayOf = (n) => n - weekdayIdx(n);
export const fmtMD = (s) => {
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}`;
};
export const fmtRange = (a, b) => {
  if (!a && !b) return '未排日期';
  if (!a || !b) return fmtMD(a || b);
  return a === b ? fmtMD(a) : `${fmtMD(a)}–${fmtMD(b)}`;
};
export const addDays = (s, n) => fromDay(toDay(s) + n);

export function weekNumber(day, settings) {
  return Math.floor((day - toDay(settings.baseMonday)) / 7) + settings.baseWeek;
}

/* ---------- Status and progress ---------- */

export function percent(task) {
  if (task.subtasks?.length) {
    return Math.round((task.subtasks.filter((s) => s.done).length / task.subtasks.length) * 100);
  }
  return task.progress || 0;
}

// Same rules as the spreadsheet's 狀態（自動） column, except that a finished item
// always reads as finished even when its dates were never filled in.
function statusFrom(done, start, end, today) {
  if (done) return 'done';
  if (!start || !end) return 'nodate';
  if (end < start) return 'bad';
  if (end < today) return 'late';
  if (start > today) return 'todo';
  return 'doing';
}
export const statusOf = (task, today) => statusFrom(percent(task) >= 100, task.start, task.end, today);
export const subStatusOf = (sub, today) => statusFrom(sub.done, sub.start, sub.end, today);

export function setDone(task, done) {
  task.progress = done ? 100 : 0;
  task.subtasks.forEach((s) => (s.done = done));
}

/* ---------- Keeping a task and its subtasks consistent ---------- */

// A subtask dated outside its parent widens the parent.
export function fitParentToSubs(task) {
  for (const s of task.subtasks) {
    if (s.start && (!task.start || s.start < task.start)) task.start = s.start;
    if (s.end && (!task.end || s.end > task.end)) task.end = s.end;
  }
}

// Shrinking a parent pulls its subtasks back inside.
export function clampSubsToParent(task) {
  if (!task.start || !task.end) return;
  const clamp = (d) => (d < task.start ? task.start : d > task.end ? task.end : d);
  for (const s of task.subtasks) {
    if (s.start) s.start = clamp(s.start);
    if (s.end) s.end = clamp(s.end);
  }
}

export function shiftTask(task, days) {
  if (task.start) task.start = addDays(task.start, days);
  if (task.end) task.end = addDays(task.end, days);
  for (const s of task.subtasks) {
    if (s.start) s.start = addDays(s.start, days);
    if (s.end) s.end = addDays(s.end, days);
  }
}

/* ---------- Data model ---------- */

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function makeTask(fields = {}) {
  const now = Date.now();
  return {
    id: newId(), title: '', projectId: '', start: null, end: null, progress: 0, priority: 0,
    notes: '', link: '', subtasks: [], order: now, createdAt: now, updatedAt: now, ...fields,
  };
}

export const makeSub = (fields = {}) => ({ id: newId(), title: '', start: null, end: null, done: false, notes: '', ...fields });

// Defaults carry timestamp 0 so a new device's first sync can never overwrite real edits.
export function defaultState() {
  return {
    version: 1,
    projects: ['實習', '學校', '活動', '個人事項', '其他'].map((name, i) => ({
      id: `p${i + 1}`, name, color: PALETTE[i], updatedAt: 0,
    })),
    tasks: [],
    settings: { baseMonday: '2026-10-19', baseWeek: 7, updatedAt: 0 },
    deleted: {},
  };
}

const str = (v, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');
const date = (v) => (isDate(v) ? v : null);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const validId = (v) => typeof v === 'string' && v.length > 0 && v.length < 64;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Everything arriving from a file or from sync passes through here.
export function normalize(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const now = Date.now();

  const projects = Array.isArray(raw.projects)
    ? raw.projects.filter((p) => p && validId(p.id)).map((p, i) => ({
        id: p.id,
        name: str(p.name, 60) || '未命名',
        color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : PALETTE[i % PALETTE.length],
        updatedAt: num(p.updatedAt, now),
      }))
    : base.projects;

  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.filter((t) => t && validId(t.id)).map((t) => ({
        id: t.id,
        title: str(t.title, 300),
        projectId: str(t.projectId, 64),
        start: date(t.start),
        end: date(t.end),
        progress: clamp(num(t.progress, 0), 0, 100),
        priority: clamp(num(t.priority, 0), 0, 3),
        notes: str(t.notes),
        link: /^https?:\/\//i.test(t.link) ? str(t.link, 2000) : '',
        subtasks: Array.isArray(t.subtasks)
          ? t.subtasks.filter((s) => s && validId(s.id)).map((s) => ({
              id: s.id, title: str(s.title, 300), start: date(s.start), end: date(s.end), done: s.done === true, notes: str(s.notes),
            }))
          : [],
        order: num(t.order, now),
        createdAt: num(t.createdAt, now),
        updatedAt: num(t.updatedAt, now),
      }))
    : [];

  const s = raw.settings || {};
  const deleted = {};
  if (raw.deleted && typeof raw.deleted === 'object') {
    for (const [k, v] of Object.entries(raw.deleted)) if (Number.isFinite(v)) deleted[k] = v;
  }
  return {
    version: 1,
    projects,
    tasks,
    settings: {
      baseMonday: date(s.baseMonday) || base.settings.baseMonday,
      baseWeek: num(s.baseWeek, base.settings.baseWeek),
      updatedAt: num(s.updatedAt, 0),
    },
    deleted,
  };
}

/* ---------- Merge for multi-device sync: newest edit per item wins, deletions are remembered ---------- */

export function merge(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, at] of Object.entries(b.deleted)) deleted[id] = Math.max(deleted[id] || 0, at);

  const mergeList = (la, lb) => {
    const byId = new Map(la.map((x) => [x.id, x]));
    for (const x of lb) {
      const cur = byId.get(x.id);
      if (!cur || x.updatedAt > cur.updatedAt) byId.set(x.id, x);
    }
    return [...byId.values()].filter((x) => {
      if (!(x.id in deleted)) return true;
      if (x.updatedAt > deleted[x.id]) {
        delete deleted[x.id]; // restored after the deletion
        return true;
      }
      return false;
    });
  };

  return {
    version: 1,
    projects: mergeList(a.projects, b.projects),
    tasks: mergeList(a.tasks, b.tasks),
    settings: b.settings.updatedAt > a.settings.updatedAt ? b.settings : a.settings,
    deleted,
  };
}

/* ---------- Export ---------- */

export function toCSV(state, today) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const projectName = (id) => state.projects.find((p) => p.id === id)?.name || '';
  const lines = [['專案', '行動事項', '子任務', '開始日期', '結束日期', '完成度', '狀態', '備註'].map(q).join(',')];
  for (const t of [...state.tasks].sort((x, y) => x.order - y.order)) {
    lines.push([projectName(t.projectId), t.title, '', t.start, t.end, `${percent(t)}%`, STATUS[statusOf(t, today)].label, t.notes].map(q).join(','));
    for (const s of t.subtasks) {
      lines.push([projectName(t.projectId), t.title, s.title, s.start, s.end, s.done ? '100%' : '0%', STATUS[subStatusOf(s, today)].label, s.notes].map(q).join(','));
    }
  }
  return '﻿' + lines.join('\r\n'); // BOM: lets Excel detect UTF-8
}
