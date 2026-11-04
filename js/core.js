// Pure logic only (no DOM), so it can be unit-tested under Node.

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
// Macaron pastels. Bars and pills on these colors use dark ink (see inkOn), never white.
export const PALETTE = [
  '#F7C5CC', '#BCDDF2', '#CFE6B8', '#FBD3B5', '#D5CCF0', '#F8E7A8',
  '#B8E3D3', '#E6C8E8', '#D9C2AB', '#C9D6DF', '#F4C9A0', '#EFB4C4',
];
export const DEFAULT_STATUS_COLORS = { todo: '#BCDDF2', doing: '#CFE6B8', done: '#D5CCF0', late: '#F4B6A6' };
export const FREE_BLOCK_COLOR = '#E8DCCB';

// The first version's saturated palette, mapped to the macaron of the same hue.
const LEGACY_COLORS = {
  '#0071E3': '#BCDDF2', '#248A3D': '#CFE6B8', '#C93400': '#FBD3B5', '#8944AB': '#D5CCF0',
  '#00798C': '#B8E3D3', '#D70015': '#F7C5CC', '#B25000': '#D9C2AB', '#636366': '#C9D6DF',
};
export const DATA_VERSION = 2;

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

/* ---------- Colors ---------- */

export const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// Whichever of dark ink or white reads better on this background.
export function inkOn(hex) {
  const l = luminance(hex);
  const onInk = (l + 0.05) / 0.0757; // #3A2E25
  const onWhite = 1.05 / (l + 0.05);
  return onInk >= onWhite ? '#3A2E25' : '#FFFFFF';
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

// Moves an overdue item's deadline only; when it started stays part of the record.
export function deferTask(task, iso) {
  task.end = iso;
  if (!task.start || task.start > iso) task.start = iso;
  for (const s of task.subtasks) if (!s.done && s.end && s.end < iso) s.end = iso;
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

/* Importance: high priority counts on every day; focusDays marks a task for single days. */

export const isImportant = (task, iso) => task.priority === 3 || (task.focusDays || []).includes(iso);
export const isActiveOn = (task, iso) => !!task.start && !!task.end && task.start <= iso && iso <= task.end;

export function toggleFocusDay(task, iso) {
  const days = task.focusDays || [];
  task.focusDays = days.includes(iso) ? days.filter((d) => d !== iso) : [...days, iso];
}

/* Day plan: time blocks are a separate layer that only points at tasks, so scheduling a
   task at 10:00 never changes the task's own dates, status or progress. */

export const SLOT = 10;
export const DAY_MINUTES = 1440;
export const snapMinute = (m) => Math.max(0, Math.min(DAY_MINUTES, Math.round(m / SLOT) * SLOT));
export const fmtMinute = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const parseMinute = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
export function fmtDuration(m) {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return [h ? `${h} 小時` : '', rest ? `${rest} 分` : ''].filter(Boolean).join(' ') || '0 分';
}

export function makeBlock(fields = {}) {
  return {
    id: newId(), date: null, start: 540, end: 600, taskId: '', subId: '', title: '', color: '', notes: '',
    done: false, updatedAt: Date.now(), ...fields,
  };
}

export const blocksOn = (state, iso) =>
  state.blocks.filter((b) => b.date === iso).sort((a, b) => a.start - b.start || a.end - b.end);

// Overlaps count once: this is time that is spoken for, not the sum of the blocks.
export function plannedMinutes(blocks) {
  let total = 0;
  let reach = 0;
  for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
    if (b.end > reach) {
      total += b.end - Math.max(b.start, reach);
      reach = b.end;
    }
  }
  return total;
}

// Overlapping blocks share a row's height, like events side by side in a calendar.
export function assignLanes(blocks) {
  const out = new Map();
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let laneEnds = [];
  let reach = -1;
  const flush = () => {
    for (const b of cluster) out.get(b.id).lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const b of sorted) {
    if (b.start >= reach) {
      flush();
      reach = b.end;
    } else reach = Math.max(reach, b.end);
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = b.end;
    out.set(b.id, { lane, lanes: 1 });
    cluster.push(b);
  }
  flush();
  return out;
}

// One piece per hour row of the 10-minute table.
export function blockSegments(start, end) {
  const segs = [];
  for (let m = start; m < end;) {
    const row = Math.floor(m / 60);
    const to = Math.min(end, (row + 1) * 60);
    segs.push({ row, from: m - row * 60, to: to - row * 60, first: m === start, last: to === end });
    m = to;
  }
  return segs;
}

// What the day's tray offers: open tasks planned for that day, plus today's overdue ones.
export function tasksForDay(state, iso, today) {
  return state.tasks
    .filter((t) => percent(t) < 100 && t.start && t.end && t.end >= t.start
      && (isActiveOn(t, iso) || (iso === today && t.end < today)))
    .sort((a, b) => Number(isImportant(b, iso)) - Number(isImportant(a, iso)) || a.end.localeCompare(b.end) || a.order - b.order);
}

/* Month calendar */

export function monthWeeks(ym) {
  const first = toDay(`${ym}-01`);
  const [y, m] = ym.split('-').map(Number);
  const last = Math.floor(Date.UTC(y, m, 0) / DAY_MS);
  const weeks = [];
  for (let w = mondayOf(first); w <= last; w += 7) weeks.push(w);
  return weeks;
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

// Bars for one week row. Tasks important this week claim the top lanes, so they are the
// last to be pushed into "+n more".
export function layoutWeek(tasks, monday) {
  const sunday = monday + 6;
  const rank = (t) => {
    for (let d = monday; d <= sunday; d++) if (isActiveOn(t, fromDay(d)) && isImportant(t, fromDay(d))) return 1;
    return 0;
  };
  const bars = tasks
    .filter((t) => t.start && t.end && t.end >= t.start && toDay(t.start) <= sunday && toDay(t.end) >= monday)
    .map((t) => ({ task: t, from: Math.max(toDay(t.start), monday) - monday, to: Math.min(toDay(t.end), sunday) - monday, rank: rank(t) }))
    .sort((a, b) => b.rank - a.rank || a.from - b.from || (b.to - b.from) - (a.to - a.from) || a.task.order - b.task.order);
  const laneEnds = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex((end) => end < bar.from);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = bar.to;
    bar.lane = lane;
  }
  return bars;
}

export function makeTask(fields = {}) {
  const now = Date.now();
  return {
    id: newId(), title: '', projectId: '', start: null, end: null, progress: 0, priority: 0,
    notes: '', link: '', color: '', focusDays: [], subtasks: [], order: now, createdAt: now, updatedAt: now, ...fields,
  };
}

export const makeSub = (fields = {}) => ({ id: newId(), title: '', start: null, end: null, done: false, notes: '', ...fields });

// Defaults carry timestamp 0 so a new device's first sync can never overwrite real edits.
export function defaultState() {
  return {
    version: DATA_VERSION,
    projects: ['實習', '學校', '活動', '個人事項', '其他'].map((name, i) => ({
      id: `p${i + 1}`, name, color: PALETTE[i], updatedAt: 0,
    })),
    tasks: [],
    blocks: [],
    diary: [],
    settings: { baseMonday: '2026-10-19', baseWeek: 7, statusColors: { ...DEFAULT_STATUS_COLORS }, updatedAt: 0 },
    deleted: {},
  };
}

const str = (v, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');
const date = (v) => (isDate(v) ? v : null);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const validId = (v) => typeof v === 'string' && v.length > 0 && v.length < 64;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex = (v) => (isHex(v) ? v : '');
const DIARY_MAX = 500000;

// Everything arriving from a file or from sync passes through here.
export function normalize(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const now = Date.now();
  // Only version 1 colors are converted: from version 2 on, any color was picked on purpose.
  const legacy = !(raw.version >= 2);
  const upgradeColor = (c) => (legacy && LEGACY_COLORS[c.toUpperCase()]) || c;

  const projects = Array.isArray(raw.projects)
    ? raw.projects.filter((p) => p && validId(p.id)).map((p, i) => ({
        id: p.id,
        name: str(p.name, 60) || '未命名',
        color: isHex(p.color) ? upgradeColor(p.color) : PALETTE[i % PALETTE.length],
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
        color: hex(t.color),
        focusDays: Array.isArray(t.focusDays) ? [...new Set(t.focusDays.filter(isDate))] : [],
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

  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.filter((b) => b && validId(b.id) && isDate(b.date)).map((b) => {
        const start = clamp(snapMinute(num(b.start, 0)), 0, DAY_MINUTES - SLOT);
        return {
          id: b.id,
          date: b.date,
          start,
          end: clamp(snapMinute(num(b.end, start + SLOT)), start + SLOT, DAY_MINUTES),
          taskId: str(b.taskId, 64),
          subId: str(b.subId, 64),
          title: str(b.title, 300),
          color: hex(b.color),
          notes: str(b.notes),
          done: b.done === true,
          updatedAt: num(b.updatedAt, now),
        };
      })
    : [];

  const diary = Array.isArray(raw.diary)
    ? raw.diary.filter((d) => d && validId(d.id) && isDate(d.date)).map((d) => ({
        id: d.id, date: d.date, body: str(d.body, DIARY_MAX), updatedAt: num(d.updatedAt, now),
      }))
    : [];

  const s = raw.settings || {};
  const statusColors = {};
  for (const [k, fallback] of Object.entries(DEFAULT_STATUS_COLORS)) statusColors[k] = hex(s.statusColors?.[k]) || fallback;
  const deleted = {};
  if (raw.deleted && typeof raw.deleted === 'object') {
    for (const [k, v] of Object.entries(raw.deleted)) if (Number.isFinite(v)) deleted[k] = v;
  }
  return {
    version: DATA_VERSION,
    projects,
    tasks,
    blocks,
    diary,
    settings: {
      baseMonday: date(s.baseMonday) || base.settings.baseMonday,
      baseWeek: num(s.baseWeek, base.settings.baseWeek),
      statusColors,
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
    version: DATA_VERSION,
    projects: mergeList(a.projects, b.projects),
    tasks: mergeList(a.tasks, b.tasks),
    blocks: mergeList(a.blocks, b.blocks),
    diary: mergeList(a.diary, b.diary),
    settings: b.settings.updatedAt > a.settings.updatedAt ? b.settings : a.settings,
    deleted,
  };
}

// Field and item order must not count as a difference.
export function canonical(d) {
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  return {
    projects: [...d.projects].sort(byId),
    tasks: [...d.tasks].sort(byId),
    blocks: [...d.blocks].sort(byId),
    diary: [...d.diary].sort(byId),
    settings: d.settings,
    deleted: Object.fromEntries(Object.entries(d.deleted).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export const sameDocument = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

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
