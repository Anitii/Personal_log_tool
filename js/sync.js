// Optional multi-device sync through a secret GitHub Gist. A static site has no
// server of its own, so the gist acts as the shared file between devices.
import { merge, normalize } from './core.js';
import { onDataChange, replaceFromSync, state } from './store.js';

const CFG_KEY = 'dg.sync.v1';
const FILE = 'daily-gantt-data.json';
const API = 'https://api.github.com';
const DEBOUNCE_MS = 2500;

let cfg = null;
try {
  cfg = JSON.parse(localStorage.getItem(CFG_KEY));
} catch { /* treated as not connected */ }

export const syncStatus = { state: cfg?.token ? 'idle' : 'off', message: '', at: cfg?.at || 0 };
let onStatus = () => {};
export const onSyncStatus = (fn) => (onStatus = fn);

function setStatus(next, message = '') {
  syncStatus.state = next;
  syncStatus.message = message;
  onStatus();
}

function saveCfg() {
  try {
    if (cfg) localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CFG_KEY);
  } catch { /* sync still works for this session */ }
}

async function gh(path, options = {}, token = cfg?.token) {
  const res = await fetch(API + path, {
    ...options,
    cache: 'no-store', // the API allows 60s caching, which would hide another device's save
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const describe = (err) => {
  if (err.status === 401) return '權杖無效或已過期，請重新連結';
  if (err.status === 403 || err.status === 404) return '權杖沒有 gist 權限，或同步檔案已被刪除';
  if (err instanceof TypeError) return '目前離線，連線後會自動同步';
  return '同步失敗，稍後會再試一次';
};

const writeGist = (data) =>
  gh(`/gists/${cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } }) });

async function readGist() {
  const gist = await gh(`/gists/${cfg.gistId}`);
  const file = gist.files?.[FILE];
  if (!file) return null;
  const text = file.truncated ? await (await fetch(file.raw_url, { cache: 'no-store' })).text() : file.content;
  return normalize(JSON.parse(text));
}

let running = false;
let again = false;
let timer = 0;

// Pull, merge both ways, push only if the gist is behind.
export async function syncNow() {
  if (!cfg?.token || !cfg.gistId) return;
  clearTimeout(timer);
  if (running) {
    again = true;
    return;
  }
  running = true;
  setStatus('syncing');
  try {
    const remote = await readGist();
    const merged = remote ? merge(state, remote) : state;
    const mergedJSON = JSON.stringify(canonical(merged));
    if (mergedJSON !== JSON.stringify(canonical(state))) replaceFromSync(merged);
    if (!remote || mergedJSON !== JSON.stringify(canonical(remote))) await writeGist(state);
    cfg.at = syncStatus.at = Date.now();
    saveCfg();
    setStatus('idle');
  } catch (err) {
    setStatus('error', describe(err));
  } finally {
    running = false;
    if (again) {
      again = false;
      syncNow();
    }
  }
}

// Field and item order must not count as a difference.
function canonical(d) {
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  return {
    projects: [...d.projects].sort(byId),
    tasks: [...d.tasks].sort(byId),
    settings: d.settings,
    deleted: Object.fromEntries(Object.entries(d.deleted).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export async function connect(token) {
  setStatus('syncing');
  try {
    let gistId = null;
    for (let page = 1; page <= 5 && !gistId; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`, {}, token);
      gistId = list.find((g) => g.files?.[FILE])?.id || null;
      if (list.length < 100) break;
    }
    if (!gistId) {
      const created = await gh('/gists', {
        method: 'POST',
        body: JSON.stringify({
          description: '日常甘特 同步資料',
          public: false,
          files: { [FILE]: { content: JSON.stringify(state) } },
        }),
      }, token);
      gistId = created.id;
    }
    cfg = { token, gistId, at: 0 };
    saveCfg();
    await syncNow();
    return true;
  } catch (err) {
    setStatus('off', describe(err));
    return false;
  }
}

export function disconnect() {
  cfg = null;
  saveCfg();
  clearTimeout(timer);
  setStatus('off');
}

export function initSync() {
  onDataChange(() => {
    if (!cfg?.token) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, DEBOUNCE_MS);
  });
  document.addEventListener('visibilitychange', () => syncNow());
  window.addEventListener('online', () => syncNow());
  syncNow();
}
