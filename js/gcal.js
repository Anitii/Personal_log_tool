// Google Calendar: its events show on the day table, the week planner and the month
// calendar, and can be edited from there. A static site has no server, so the calendar is
// reached through a small Google Apps Script the user deploys in their own account: free,
// no Google Cloud project, and no sign-in that expires. The script answers only requests
// carrying the secret key it was created with. The last events fetched are kept so they
// still show offline.
import { DAY_MINUTES, SLOT, WEEKDAYS, fmtMinute, inkOn, parseMinute, toDay, weekdayIdx } from './core.js';
import { actions, changes, enters, esc, toast } from './ui.js';
import { closeSheet, openPanel } from './sheet.js';

const CFG_KEY = 'dg.gcal.v1';
const CACHE_KEY = 'dg.gcal.cache.v1';
const FRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const KEEP_MONTHS = 8;
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

// Google's own event colors (colorId 1–11).
const EVENT_COLORS = {
  1: '#7986CB', 2: '#33B679', 3: '#8E24AA', 4: '#E67C73', 5: '#F6BF26', 6: '#F4511E',
  7: '#039BE5', 8: '#616161', 9: '#3F51B5', 10: '#0B8043', 11: '#D50000',
};

// url: the deployed web app; key: the secret baked into that script.
let cfg = { url: '', key: '', calendars: [], target: '', connected: false };
try {
  const saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
  if (saved.url || saved.key) cfg = { ...cfg, url: saved.url || '', key: saved.key || '', calendars: saved.calendars || [], target: saved.target || '', connected: !!saved.connected && !!saved.url };
} catch { /* starts disconnected */ }

// month 'YYYY-MM' → { at, events }
const months = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'))) months.set(k, { at: 0, events: v });
} catch { /* nothing cached */ }
const inflight = new Set();
const failedAt = new Map();

export const gcal = { busy: false, error: '' };
let requestRender = () => {};
export const setGcalRender = (fn) => (requestRender = fn);

export const gcalConnected = () => !!cfg.connected;

function saveCfg() {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch { /* works for this session */ }
}

function saveCache() {
  try {
    const keep = [...months.keys()].sort().slice(-KEEP_MONTHS);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep.map((k) => [k, months.get(k).events]))));
  } catch { /* the cache is only a convenience */ }
}

/* ---------- Dates ---------- */

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayStartMs = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const nextIso = (iso, n = 1) => {
  const [y, m, d] = iso.split('-').map(Number);
  return localIso(new Date(y, m - 1, d + n));
};
const monthOf = (iso) => iso.slice(0, 7);
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function monthsBetween(fromIso, toIso) {
  const out = [];
  let [y, m] = fromIso.split('-').map(Number);
  const last = monthOf(toIso);
  for (let i = 0; i < 24; i++) {
    const key = `${y}-${pad(m)}`;
    out.push(key);
    if (key >= last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// A time on a given day as the API wants it: local wall time plus the time zone.
function when(iso, minute) {
  if (minute >= DAY_MINUTES) return { dateTime: `${nextIso(iso)}T00:00:00`, timeZone: tz() };
  return { dateTime: `${iso}T${fmtMinute(minute)}:00`, timeZone: tz() };
}

/* ---------- Colors ---------- */

function mix(hex, toward, amount) {
  const a = hex.replace('#', '');
  const b = toward.replace('#', '');
  const ch = (s, i) => parseInt(s.slice(i, i + 2), 16);
  return `#${[0, 2, 4].map((i) => pad(Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * amount).toString(16))).join('')}`;
}
// Google's colors are vivid; on the milk-tea palette they are softened, with the real color
// kept for the edge so the event still reads as "that calendar".
const soft = (hex) => mix(/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#9E9E9E', '#FFFFFF', 0.55);

/* ---------- The Apps Script ---------- */

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The key for a script not yet linked; kept so copying the code twice gives the same key.
export function pendingKey() {
  if (!cfg.key) {
    cfg.key = newKey();
    saveCfg();
  }
  return cfg.key;
}

// The whole script the user pastes into script.google.com. It is a thin relay to the
// Calendar API's advanced service, so events come back in the same shape as the API's.
export function scriptCode(key) {
  return `// 日常甘特 ↔ Google 日曆
// 1. 左側「服務」按 +，加入「Google Calendar API」。
// 2. 部署 → 新增部署 → 類型「網頁應用程式」，執行身分「我」，存取權「所有人」。
// 3. 把部署後的網址貼回日常甘特的「設定 → Google 日曆」。
// 下面這組密碼只有你的日常甘特知道，請不要分享這段程式碼。
const KEY = '${key}';

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = req.key === KEY ? { ok: true, data: run(req) } : { ok: false, status: 401 };
  } catch (err) {
    const msg = String((err && err.message) || err);
    const status = (err && err.details && err.details.code) || (/not found/i.test(msg) ? 404 : /forbidden|insufficient|permission/i.test(msg) ? 403 : 500);
    out = { ok: false, status: status, error: msg };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function run(req) {
  switch (req.action) {
    case 'calendars':
      return Calendar.CalendarList.list({ minAccessRole: 'reader', maxResults: 250 }).items || [];
    case 'events': {
      const lists = {};
      req.calendars.forEach(function (id) {
        const items = [];
        let pageToken;
        try {
          do {
            const r = Calendar.Events.list(id, { timeMin: req.timeMin, timeMax: req.timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken: pageToken });
            items.push.apply(items, r.items || []);
            pageToken = r.nextPageToken;
          } while (pageToken);
        } catch (err) { /* a calendar that can't be read is skipped */ }
        lists[id] = items;
      });
      return lists;
    }
    case 'patch': return Calendar.Events.patch(req.body, req.calendarId, req.eventId);
    case 'insert': return Calendar.Events.insert(req.body, req.calendarId);
    case 'remove': Calendar.Events.remove(req.calendarId, req.eventId); return null;
  }
  throw new Error('unknown action');
}

function doGet() {
  return ContentService.createTextOutput('日常甘特的 Google 日曆連線正在運作。');
}
`;
}

// What another device pastes: the script's address and its key in one string.
export const gcalLinkCode = () => (cfg.connected ? `${cfg.url}#${cfg.key}` : '');

// Accepts the web app address (this device made the key) or a link code from another device.
export async function linkScript(text) {
  const [url, key] = text.trim().split('#');
  if (!SCRIPT_URL.test(url)) {
    gcal.error = '這不是 Apps Script 的網址，應該像 https://script.google.com/macros/s/…/exec';
    requestRender();
    return false;
  }
  const prev = { ...cfg };
  cfg.url = url;
  if (key) cfg.key = key;
  if (!cfg.key) {
    cfg = prev;
    gcal.error = '這台裝置沒有密碼。請貼上已連結的裝置在設定裡顯示的「其他裝置用的連結碼」';
    requestRender();
    return false;
  }
  gcal.error = '';
  gcal.busy = true;
  requestRender();
  try {
    cfg.calendars = [];
    await loadCalendars();
    cfg.connected = true;
    saveCfg();
    failedAt.clear();
    months.clear();
    return true;
  } catch (err) {
    cfg = prev;
    saveCfg();
    gcal.error = err.status === 401
      ? '密碼不符：請確認 Apps Script 裡貼的是這台裝置最新複製的程式碼，並重新部署'
      : err.status === 403 || err.status === 404 || err.status === 500
        ? `Apps Script 回報錯誤：${err.detail || '請確認已在「服務」加入 Google Calendar API'}`
        : '連不到這個 Apps Script，請確認部署時存取權選的是「所有人」';
    return false;
  } finally {
    gcal.busy = false;
    requestRender();
  }
}

// The key stays, so the same script can be linked again by pasting its address.
export function disconnect() {
  cfg = { url: '', key: cfg.key, calendars: [], target: '', connected: false };
  saveCfg();
  months.clear();
  saveCache();
  gcal.error = '';
  requestRender();
}

/* ---------- API ---------- */

// Every request is a POST of plain text, which needs no CORS preflight; the key travels in
// the body, never in the address.
async function call(action, params = {}) {
  if (!cfg.url) {
    const err = new Error('not linked');
    err.status = 401;
    throw err;
  }
  const res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify({ key: cfg.key, action, ...params }) });
  let out;
  try {
    out = await res.json();
  } catch {
    const err = new Error(`Apps Script ${res.status}`);
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  if (!out.ok) {
    const err = new Error(out.error || `Apps Script ${out.status}`);
    err.status = out.status || 500;
    err.detail = out.error || '';
    throw err;
  }
  return out.data;
}

const describe = (err) => {
  if (err.status === 401) return 'Apps Script 的密碼不符，請到設定重新連結';
  if (err.status === 403) return '沒有權限修改這個日曆';
  if (err.status === 404 || err.status === 410) return '這個行程已經不在 Google 日曆上';
  if (err instanceof TypeError) return '目前離線，無法連到 Google 日曆';
  return 'Google 日曆暫時無法連線';
};

const writable = (cal) => cal && (cal.access === 'owner' || cal.access === 'writer');

async function loadCalendars() {
  const items = await call('calendars');
  const before = new Map(cfg.calendars.map((c) => [c.id, c]));
  cfg.calendars = (items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    color: c.backgroundColor || '#9E9E9E',
    access: c.accessRole,
    primary: !!c.primary,
    on: before.has(c.id) ? before.get(c.id).on : c.selected !== false || !!c.primary,
  })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  if (!cfg.calendars.some((c) => c.id === cfg.target && writable(c))) {
    cfg.target = (cfg.calendars.find((c) => c.primary) || cfg.calendars.find(writable))?.id || '';
  }
  saveCfg();
}

const calendarOf = (id) => cfg.calendars.find((c) => c.id === id);
export const gcalCalendars = () => cfg.calendars;
export const gcalTarget = () => cfg.target;

function toEvent(raw, cal) {
  if (raw.status === 'cancelled') return null;
  if ((raw.attendees || []).some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = !!raw.start?.date;
  let from;
  let to;
  let startMs = 0;
  let endMs = 0;
  if (allDay) {
    from = raw.start.date;
    to = nextIso(raw.end?.date || nextIso(from), -1); // the API's end date is exclusive
    if (to < from) to = from;
  } else {
    startMs = Date.parse(raw.start?.dateTime);
    endMs = Date.parse(raw.end?.dateTime);
    if (!Number.isFinite(startMs)) return null;
    if (!Number.isFinite(endMs) || endMs < startMs) endMs = startMs;
    from = localIso(new Date(startMs));
    to = localIso(new Date(Math.max(startMs, endMs - 1)));
  }
  const color = EVENT_COLORS[raw.colorId] || cal.color;
  return {
    key: `${cal.id}|${raw.id}`,
    id: raw.id,
    calId: cal.id,
    title: raw.summary || '',
    notes: raw.description || '',
    location: raw.location || '',
    link: raw.htmlLink || '',
    allDay, from, to, startMs, endMs,
    color,
    recurring: !!raw.recurringEventId,
    editable: writable(cal) && (!raw.organizer || !!raw.organizer.self || !!raw.guestsCanModify || !!raw.creator?.self),
  };
}

async function fetchMonth(key) {
  inflight.add(key);
  gcal.busy = true;
  const [y, m] = key.split('-').map(Number);
  const timeMin = new Date(y, m - 1, 1).toISOString();
  const timeMax = new Date(y, m, 1).toISOString();
  try {
    if (!cfg.calendars.length) await loadCalendars();
    const shown = cfg.calendars.filter((c) => c.on);
    const lists = shown.length ? await call('events', { calendars: shown.map((c) => c.id), timeMin, timeMax }) : {};
    const events = shown.flatMap((cal) => (lists[cal.id] || []).map((raw) => toEvent(raw, cal)).filter(Boolean));
    months.set(key, { at: Date.now(), events });
    failedAt.delete(key);
    gcal.error = '';
    saveCache();
  } catch (err) {
    failedAt.set(key, Date.now());
    gcal.error = describe(err);
  } finally {
    inflight.delete(key);
    gcal.busy = inflight.size > 0;
    requestRender();
  }
}

// Views call this for the dates on screen; it fetches what is missing or stale, then re-renders.
export function gcalEnsure(fromIso, toIso) {
  if (!gcalConnected()) return;
  for (const key of monthsBetween(fromIso, toIso)) {
    if (inflight.has(key)) continue;
    const m = months.get(key);
    if (m && Date.now() - m.at < FRESH_MS) continue;
    if (Date.now() - (failedAt.get(key) || 0) < RETRY_MS) continue;
    fetchMonth(key);
  }
}

export function gcalRefresh() {
  for (const m of months.values()) m.at = 0;
  failedAt.clear();
  requestRender();
}

/* ---------- Reading events for a day ---------- */

function allEvents(key) {
  return gcalConnected() ? months.get(key)?.events || [] : [];
}

function findEvent(key) {
  for (const m of months.values()) {
    const e = m.events.find((x) => x.key === key);
    if (e) return e;
  }
  return null;
}

// Every event touching a day. Timed ones get `start`/`end` in minutes, clipped to that day.
export function gcalEventsOn(iso) {
  const on = new Set(cfg.calendars.filter((c) => c.on).map((c) => c.id));
  const day0 = dayStartMs(iso);
  const day1 = dayStartMs(nextIso(iso));
  const out = [];
  for (const e of allEvents(monthOf(iso))) {
    if (!on.has(e.calId) || e.from > iso || e.to < iso) continue;
    const view = { ...e, soft: soft(e.color) };
    view.ink = inkOn(view.soft);
    if (!e.allDay) {
      view.start = Math.max(0, Math.round((Math.max(e.startMs, day0) - day0) / 60000));
      view.end = e.endMs >= day1 ? DAY_MINUTES : Math.round((e.endMs - day0) / 60000);
      if (view.end - view.start < 15) view.end = Math.min(DAY_MINUTES, view.start + 15);
      view.multiDay = e.from !== e.to;
    }
    out.push(view);
  }
  return out.sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.start || 0) - (b.start || 0) || a.title.localeCompare(b.title));
}

// Events spanning a range of days, once each (for the month calendar's bars).
export function gcalEventsBetween(fromIso, toIso) {
  const on = new Set(cfg.calendars.filter((c) => c.on).map((c) => c.id));
  const seen = new Map();
  for (const key of monthsBetween(fromIso, toIso)) {
    for (const e of allEvents(key)) {
      if (on.has(e.calId) && e.from <= toIso && e.to >= fromIso && !seen.has(e.key)) seen.set(e.key, { ...e, soft: soft(e.color), ink: inkOn(soft(e.color)) });
    }
  }
  return [...seen.values()];
}

// Timed, single-day and editable: the only events that can be dragged on a timeline.
export const gcalDraggable = (e) => !!e && e.editable && !e.allDay && !e.multiDay;

/* ---------- Changing events ---------- */

function replaceCached(key, fn) {
  for (const m of months.values()) {
    m.events = m.events.flatMap((e) => (e.key === key ? fn(e) : [e]));
  }
  saveCache();
}

async function patch(e, body, optimistic) {
  const before = findEvent(e.key);
  if (!before) return;
  replaceCached(e.key, (x) => [{ ...x, ...optimistic }]);
  requestRender();
  try {
    const raw = await call('patch', { calendarId: e.calId, eventId: e.id, body });
    const next = toEvent(raw, calendarOf(e.calId) || { id: e.calId, color: e.color, access: 'writer' });
    if (next) {
      replaceCached(e.key, () => [next]);
      // Moved into another month: show it there now, not only after that month's next fetch.
      const m = months.get(monthOf(next.from));
      if (m && !m.events.some((x) => x.key === next.key)) m.events.push(next);
    }
  } catch (err) {
    replaceCached(e.key, () => [before]);
    toast(describe(err));
  }
  requestRender();
}

// Move or resize a timed event on one day.
export function gcalMove(e, iso, start, end) {
  const s = dayStartMs(iso);
  return patch(e, { start: when(iso, start), end: when(iso, end) }, {
    from: iso, to: iso, startMs: s + start * 60000, endMs: s + end * 60000,
  });
}

export async function gcalDelete(e) {
  const before = findEvent(e.key);
  replaceCached(e.key, () => []);
  requestRender();
  try {
    await call('remove', { calendarId: e.calId, eventId: e.id });
    toast('已從 Google 日曆刪除');
  } catch (err) {
    if (before && err.status !== 404 && err.status !== 410) replaceCached(e.key, () => [before]);
    toast(describe(err));
  }
  requestRender();
}

// New timed event on the chosen calendar. Resolves to the event, or null if it failed.
export async function gcalCreate({ title, iso, start, end, notes = '' }) {
  const cal = calendarOf(cfg.target);
  if (!cal) {
    toast('請先在設定裡選擇要新增到哪個 Google 日曆');
    return null;
  }
  try {
    const body = { summary: title, start: when(iso, start), end: when(iso, end) };
    if (notes) body.description = notes;
    const raw = await call('insert', { calendarId: cal.id, body });
    const e = toEvent(raw, cal);
    const m = months.get(monthOf(iso));
    if (e && m) m.events.push(e);
    saveCache();
    requestRender();
    return e;
  } catch (err) {
    toast(describe(err));
    return null;
  }
}

// Shown in the plan views' toolbar when fetching failed, with a retry.
export function gcalBarHTML() {
  if (!gcalConnected()) return '';
  if (gcal.error) return `<button type="button" class="chip gcal-chip warn" data-act="gcal-refresh">${esc(gcal.error)}｜重試</button>`;
  return '';
}

/* ---------- Event panel ---------- */

function timeField(id, minute, key, disabled) {
  const value = minute >= DAY_MINUTES ? '23:59' : fmtMinute(minute);
  return `<input id="${id}" type="time" step="300" class="field-date" value="${value}" data-ch="gev-time" data-gev="${esc(key)}" ${disabled}>`;
}

export function openEvent(key, iso) {
  const found = findEvent(key);
  if (!found) return;
  const e = gcalEventsOn(iso).find((x) => x.key === key) || { ...found, start: 0, end: 0 };
  const cal = calendarOf(e.calId);
  const off = e.editable ? '' : 'disabled';
  const [, m, d] = iso.split('-').map(Number);
  const dateLabel = e.from === e.to ? `${Number(e.from.slice(5, 7))}/${Number(e.from.slice(8))} 星期${WEEKDAYS[weekdayIdx(toDay(e.from))]}`
    : `${Number(e.from.slice(5, 7))}/${Number(e.from.slice(8))}–${Number(e.to.slice(5, 7))}/${Number(e.to.slice(8))}`;
  const timeRows = e.allDay
    ? `<div class="row form-row"><span class="form-label">日期</span><span class="form-value">${esc(dateLabel)}・整天</span></div>`
    : e.multiDay
      ? `<div class="row form-row"><span class="form-label">時間</span><span class="form-value">${esc(dateLabel)}，跨日行程</span></div>`
      : `<label class="row form-row"><span class="form-label">日期</span><input id="gev-date" type="date" class="field-date" value="${esc(e.from)}" data-ch="gev-time" data-gev="${esc(key)}" ${off}></label>
         <label class="row form-row"><span class="form-label">開始</span>${timeField('gev-start', e.start, key, off)}</label>
         <label class="row form-row"><span class="form-label">結束</span>${timeField('gev-end', e.end, key, off)}</label>`;
  const notes = e.notes.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  openPanel(e.allDay ? `${m}/${d} 整天` : `${fmtMinute(e.start)}–${fmtMinute(e.end)}`, `
    <div class="card">
      <div class="row form-row gev-title-row"><i class="gev-mark" style="background:${esc(e.color)}"></i>
        <input type="text" class="bare" value="${esc(e.title)}" placeholder="（沒有標題）" data-ch="gev-title" data-gev="${esc(key)}" aria-label="行程名稱" maxlength="300" ${off}></div>
    </div>
    <div class="card">${timeRows}</div>
    <h3 class="group-head in-sheet">地點</h3>
    <div class="card"><div class="row form-row"><input type="text" class="bare" value="${esc(e.location)}" placeholder="新增地點" data-ch="gev-location" data-gev="${esc(key)}" aria-label="地點" ${off}></div></div>
    <h3 class="group-head in-sheet">說明</h3>
    <div class="card"><div class="row form-row notes-row"><textarea class="notes-input" rows="3" placeholder="新增說明" data-ch="gev-notes" data-gev="${esc(key)}" aria-label="說明" ${off}>${esc(notes)}</textarea></div></div>
    <p class="group-foot">Google 日曆「${esc(cal?.name || '')}」${e.recurring ? '。這是重複行程，這裡的修改只影響這一次' : ''}${e.editable ? '' : '。這個行程是唯讀的，只能在 Google 日曆裡由主辦人修改'}。</p>
    <div class="card bs-actions">
      ${e.link ? `<a class="row form-row link-row" href="${esc(e.link)}" target="_blank" rel="noopener">在 Google 日曆開啟</a>` : ''}
      ${e.editable ? `<button type="button" class="row form-row link-row destructive" data-act="gev-delete" data-gev="${esc(key)}">${e.recurring ? '刪除這一次' : '刪除這個行程'}</button>` : ''}
    </div>`);
}

// A draft that only reaches Google when "新增" is pressed.
export function openNewEvent(iso, start = 9 * 60, end = 10 * 60) {
  const writableCals = cfg.calendars.filter(writable);
  const options = writableCals.map((c) => `<option value="${esc(c.id)}" ${c.id === cfg.target ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  openPanel('新增 Google 行程', `
    <div class="card"><div class="row form-row"><input id="gnew-title" type="text" class="bare" placeholder="行程名稱" enterkeyhint="done" aria-label="行程名稱" maxlength="300"></div></div>
    <div class="card">
      <label class="row form-row"><span class="form-label">日期</span><input id="gnew-date" type="date" class="field-date" value="${esc(iso)}"></label>
      <label class="row form-row"><span class="form-label">開始</span><input id="gnew-start" type="time" step="300" class="field-date" value="${fmtMinute(start)}"></label>
      <label class="row form-row"><span class="form-label">結束</span><input id="gnew-end" type="time" step="300" class="field-date" value="${fmtMinute(end)}"></label>
      ${writableCals.length > 1 ? `<label class="row form-row"><span class="form-label">日曆</span><select id="gnew-cal" class="field-select">${options}</select></label>` : ''}
    </div>
    <div class="card bs-actions"><button type="button" class="row form-row link-row" data-act="gev-create">新增到 Google 日曆</button></div>`);
  document.getElementById('gnew-title')?.focus();
}

const read = (id) => document.getElementById(id)?.value || '';

// The code in a panel, for when the clipboard is unavailable or the user wants to look first.
function showScript() {
  openPanel('Apps Script 程式碼', `
    <p class="group-foot">全選後複製，貼進 script.google.com 的新專案，取代原本的內容。</p>
    <div class="card"><div class="row form-row notes-row"><textarea class="notes-input code-box" rows="14" readonly spellcheck="false" aria-label="Apps Script 程式碼">${esc(scriptCode(pendingKey()))}</textarea></div></div>`);
  const box = document.querySelector('#sheet .code-box');
  box?.addEventListener('focus', () => box.select());
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    return false;
  }
}

async function link() {
  const field = document.getElementById('gcal-url');
  if (!field?.value.trim()) return;
  if (await linkScript(field.value)) toast('已連結 Google 日曆');
}

Object.assign(actions, {
  'gcal-copy-script': async () => {
    if (!(await copy(scriptCode(pendingKey()), '已複製程式碼，貼到 script.google.com'))) showScript();
  },
  'gcal-show-script': () => showScript(),
  'gcal-link': () => link(),
  'gcal-copy-link': async () => {
    if (!(await copy(gcalLinkCode(), '已複製連結碼，貼到其他裝置的設定'))) toast('無法複製，請長按連結碼手動複製');
  },
  'gcal-disconnect': () => disconnect(),
  'gcal-refresh': () => gcalRefresh(),
  'gev-open': (el) => openEvent(el.dataset.gev, el.dataset.date),
  'gev-new': (el) => openNewEvent(el.dataset.date),
  'gev-delete': (el) => {
    const e = findEvent(el.dataset.gev);
    closeSheet();
    if (e) gcalDelete(e);
  },
  'gev-create': async () => {
    const title = read('gnew-title').trim();
    const iso = read('gnew-date');
    const start = parseMinute(read('gnew-start'));
    let end = parseMinute(read('gnew-end'));
    if (!iso || start == null || end == null) return;
    if (end <= start) end = Math.min(DAY_MINUTES, start + 60);
    const cal = read('gnew-cal');
    if (cal) cfg.target = cal;
    closeSheet();
    const e = await gcalCreate({ title: title || '新行程', iso, start, end });
    if (e) toast('已新增到 Google 日曆');
  },
});

Object.assign(changes, {
  'gev-title': (el) => {
    const e = findEvent(el.dataset.gev);
    if (e && el.value !== e.title) patch(e, { summary: el.value }, { title: el.value });
  },
  'gev-location': (el) => {
    const e = findEvent(el.dataset.gev);
    if (e && el.value !== e.location) patch(e, { location: el.value }, { location: el.value });
  },
  'gev-notes': (el) => {
    const e = findEvent(el.dataset.gev);
    if (e) patch(e, { description: el.value }, { notes: el.value });
  },
  'gev-time': (el) => {
    const e = findEvent(el.dataset.gev);
    const iso = read('gev-date');
    let start = parseMinute(read('gev-start'));
    let end = parseMinute(read('gev-end'));
    if (!e || !iso || start == null || end == null) return;
    start = Math.min(start, DAY_MINUTES - SLOT);
    end = end >= DAY_MINUTES - 1 ? DAY_MINUTES : end;
    if (end <= start) end = Math.min(DAY_MINUTES, start + Math.max(15, Math.round((e.endMs - e.startMs) / 60000)));
    gcalMove(e, iso, start, end).then(() => {
      if (document.getElementById('gev-date')) openEvent(e.key, iso);
    });
  },
  'gcal-cal-on': (el) => {
    const c = calendarOf(el.dataset.cal);
    if (!c) return;
    c.on = el.checked;
    saveCfg();
    gcalRefresh();
  },
  'gcal-target': (el) => {
    cfg.target = el.value;
    saveCfg();
  },
});

Object.assign(enters, { 'gcal-link': () => link() });
