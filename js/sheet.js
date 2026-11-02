// Task detail sheet: bottom sheet on phones, centered on tablets, inspector on desktop.
import {
  STATUS, clampSubsToParent, fitParentToSubs, fmtRange, makeSub, makeTask, newId, percent, statusOf, subStatusOf, todayStr,
} from './core.js';
import { commit, deleteTask, getTask, state, touch } from './store.js';
import { actions, changes, enters, esc, icon, inputs } from './ui.js';

let current = null; // { id, isNew }
const openSubs = new Set();

const sheet = () => document.getElementById('sheet');
const task = () => (current ? getTask(current.id) : null);

function save(fn) {
  const t = task();
  if (!t) return;
  commit(() => {
    fn(t);
    touch(t);
  });
  refreshMeta();
}

function subsHTML(t) {
  const today = todayStr();
  return t.subtasks.map((s, i) => {
    const open = openSubs.has(s.id);
    const st = subStatusOf(s, today);
    return `<div class="sub-edit ${s.done ? 'is-done' : ''}" data-sid="${esc(s.id)}">
      <div class="row sub">
        <button type="button" class="check small ${s.done ? 'on' : ''}" data-act="sheet-sub-toggle" data-sid="${esc(s.id)}" role="checkbox" aria-checked="${s.done}" aria-label="完成子任務"></button>
        <input type="text" class="bare sub-title" value="${esc(s.title)}" placeholder="子任務名稱" data-in="sheet-sub-title" data-sid="${esc(s.id)}" aria-label="子任務名稱" maxlength="300">
        <button type="button" class="date-chip btn-chip ${st === 'late' ? 'late' : ''}" data-act="sheet-sub-more" data-sid="${esc(s.id)}" aria-expanded="${open}">${esc(fmtRange(s.start, s.end))}</button>
      </div>
      ${open ? `<div class="sub-more">
        <label class="row form-row tight"><span class="form-label">開始</span><input type="date" class="field-date" value="${esc(s.start || '')}" data-ch="sheet-sub-start" data-sid="${esc(s.id)}"></label>
        <label class="row form-row tight"><span class="form-label">結束</span><input type="date" class="field-date" value="${esc(s.end || '')}" data-ch="sheet-sub-end" data-sid="${esc(s.id)}"></label>
        <div class="row form-row tight"><input type="text" class="bare" value="${esc(s.notes)}" placeholder="子任務備註" data-in="sheet-sub-notes" data-sid="${esc(s.id)}" aria-label="子任務備註"></div>
        <div class="sub-tools">
          <button type="button" class="icon-btn" data-act="sheet-sub-move" data-sid="${esc(s.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="上移">${icon.up}</button>
          <button type="button" class="icon-btn" data-act="sheet-sub-move" data-sid="${esc(s.id)}" data-dir="1" ${i === t.subtasks.length - 1 ? 'disabled' : ''} aria-label="下移">${icon.down}</button>
          <button type="button" class="icon-btn danger" data-act="sheet-sub-delete" data-sid="${esc(s.id)}" aria-label="刪除子任務">${icon.trash}</button>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');
}

function renderSubs() {
  const t = task();
  const host = document.getElementById('sheet-subs');
  if (t && host) host.innerHTML = subsHTML(t);
}

function refreshMeta() {
  const t = task();
  if (!t) return;
  const st = statusOf(t, todayStr());
  const pct = percent(t);
  const root = sheet();
  const pill = root.querySelector('#sheet-status');
  pill.className = `pill s-${STATUS[st].cls}`;
  pill.textContent = STATUS[st].label;
  const slider = root.querySelector('#sheet-progress');
  slider.value = pct;
  slider.disabled = t.subtasks.length > 0;
  slider.style.setProperty('--pct', `${pct}%`);
  root.querySelector('#sheet-pct').textContent = `${pct}%`;
  root.querySelector('#sheet-progress-hint').hidden = t.subtasks.length === 0;
  root.querySelector('#sheet-sub-count').textContent = t.subtasks.length ? `${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}` : '';
  // Dates can change from a subtask edit; leave alone whichever field is being edited.
  for (const [sel, val] of [['#sheet-start', t.start], ['#sheet-end', t.end]]) {
    const input = root.querySelector(sel);
    if (input !== document.activeElement) input.value = val || '';
  }
  root.querySelector('#sheet-link-open').hidden = !t.link;
  if (t.link) root.querySelector('#sheet-link-open').href = t.link;
}

export function openTask(id, { isNew = false, focusSub } = {}) {
  const t = getTask(id);
  if (!t) return;
  current = { id, isNew };
  openSubs.clear();
  if (focusSub) openSubs.add(focusSub);
  const prioLabels = ['無', '低', '中', '高'];
  const projectOptions = ['<option value="">未分類</option>']
    .concat(state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === t.projectId ? 'selected' : ''}>${esc(p.name)}</option>`))
    .join('');

  const root = sheet();
  root.innerHTML = `<div class="sheet-inner">
    <div class="grabber" data-grab aria-hidden="true"><i></i></div>
    <div class="sheet-bar">
      <span id="sheet-status" class="pill"></span>
      <button type="button" class="text-btn strong" data-act="sheet-close">完成</button>
    </div>
    <div class="sheet-scroll">
      <div class="card title-card">
        <textarea id="sheet-title" class="title-input" rows="1" placeholder="任務名稱" data-in="sheet-title" data-enter="sheet-title-enter" aria-label="任務名稱" maxlength="300">${esc(t.title)}</textarea>
      </div>

      <div class="card">
        <label class="row form-row"><span class="form-label">專案</span>
          <select class="field-select" data-ch="sheet-project" aria-label="專案">${projectOptions}</select></label>
        <div class="row form-row"><span class="form-label">優先度</span>
          <div class="seg" role="group" aria-label="優先度">${prioLabels.map((l, i) =>
            `<button type="button" class="${t.priority === i ? 'on' : ''}" data-act="sheet-priority" data-v="${i}" aria-pressed="${t.priority === i}">${l}</button>`).join('')}</div></div>
      </div>

      <div class="card">
        <label class="row form-row"><span class="form-label">開始日期</span><input id="sheet-start" type="date" class="field-date" value="${esc(t.start || '')}" data-ch="sheet-start"></label>
        <label class="row form-row"><span class="form-label">結束日期</span><input id="sheet-end" type="date" class="field-date" value="${esc(t.end || '')}" data-ch="sheet-end"></label>
        <div class="row form-row progress-row">
          <span class="form-label">完成度</span>
          <input id="sheet-progress" type="range" class="slider" min="0" max="100" step="5" data-in="sheet-progress" aria-label="完成度">
          <span id="sheet-pct" class="form-value num"></span>
        </div>
        <p id="sheet-progress-hint" class="form-hint" hidden>有子任務時，完成度由子任務自動計算。</p>
      </div>

      <h3 class="group-head in-sheet">子任務 <span id="sheet-sub-count" class="group-count"></span></h3>
      <div class="card">
        <div id="sheet-subs">${subsHTML(t)}</div>
        <div class="row sub add-sub"><span class="add-mark">${icon.plus}</span>
          <input id="sheet-sub-add" type="text" class="bare" placeholder="新增子任務，把工作拆細" enterkeyhint="done" data-enter="sheet-sub-add" aria-label="新增子任務" maxlength="300"></div>
      </div>

      <h3 class="group-head in-sheet">備註與連結</h3>
      <div class="card">
        <div class="row form-row notes-row"><textarea class="notes-input" rows="3" placeholder="備註" data-in="sheet-notes" aria-label="備註">${esc(t.notes)}</textarea></div>
        <div class="row form-row"><input type="url" class="bare" inputmode="url" value="${esc(t.link)}" placeholder="連結（https://…）" data-in="sheet-link" aria-label="連結">
          <a id="sheet-link-open" class="icon-btn" target="_blank" rel="noopener noreferrer" aria-label="開啟連結" hidden>${icon.link}</a></div>
      </div>

      <div class="card">
        <button type="button" class="row form-row link-row" data-act="sheet-duplicate">複製任務</button>
        <button type="button" class="row form-row link-row destructive" data-act="sheet-delete">刪除任務</button>
      </div>
    </div>
  </div>`;

  root.classList.remove('closing');
  root.style.transform = '';
  if (!root.open) root.showModal();
  refreshMeta();
  fitTitle();
  root.querySelector('.sheet-scroll').scrollTop = 0;
  if (isNew) root.querySelector('#sheet-title').focus();
  else if (document.activeElement && document.activeElement !== root) document.activeElement.blur();
}

function fitTitle() {
  const el = sheet().querySelector('#sheet-title');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export function closeSheet() {
  const root = sheet();
  if (!root.open) return;
  const t = task();
  const discard = current?.isNew && t && !t.title.trim() && !t.subtasks.length;
  const id = current?.id;
  current = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('closing');
  setTimeout(() => {
    root.close();
    root.classList.remove('closing');
    root.style.transform = '';
    root.innerHTML = '';
  }, reduced ? 0 : 170);
  if (discard) deleteTask(id, { silent: true });
}

const findSub = (el) => task()?.subtasks.find((s) => s.id === el.dataset.sid);

Object.assign(actions, {
  'sheet-close': closeSheet,
  'sheet-priority': (el) => {
    save((t) => (t.priority = Number(el.dataset.v)));
    el.parentElement.querySelectorAll('button').forEach((b) => {
      const on = b === el;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
  },
  'sheet-duplicate': () => {
    const t = task();
    const now = Date.now();
    const copy = makeTask({
      ...JSON.parse(JSON.stringify(t)),
      id: newId(),
      title: `${t.title} 副本`,
      order: now,
      createdAt: now,
      updatedAt: now,
    });
    copy.subtasks.forEach((s) => (s.id = newId()));
    commit((st) => st.tasks.push(copy), { undo: '已複製任務' });
    openTask(copy.id);
  },
  'sheet-delete': () => {
    const id = current.id;
    closeSheet();
    deleteTask(id);
  },
  'sheet-sub-toggle': (el) => {
    const s = findSub(el);
    if (!s) return;
    save(() => (s.done = !s.done));
    renderSubs();
  },
  'sheet-sub-more': (el) => {
    const id = el.dataset.sid;
    if (openSubs.has(id)) openSubs.delete(id);
    else openSubs.add(id);
    renderSubs();
  },
  'sheet-sub-move': (el) => {
    const dir = Number(el.dataset.dir);
    save((t) => {
      const i = t.subtasks.findIndex((s) => s.id === el.dataset.sid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= t.subtasks.length) return;
      [t.subtasks[i], t.subtasks[j]] = [t.subtasks[j], t.subtasks[i]];
    });
    renderSubs();
  },
  'sheet-sub-delete': (el) => {
    save((t) => (t.subtasks = t.subtasks.filter((s) => s.id !== el.dataset.sid)));
    renderSubs();
  },
});

Object.assign(inputs, {
  'sheet-title': (el) => {
    save((t) => (t.title = el.value.replace(/\n/g, ' ')));
    fitTitle();
  },
  'sheet-progress': (el) => save((t) => (t.progress = Number(el.value))),
  'sheet-notes': (el) => save((t) => (t.notes = el.value)),
  'sheet-link': (el) => save((t) => {
    const v = el.value.trim();
    t.link = /^https?:\/\//i.test(v) ? v : '';
  }),
  'sheet-sub-title': (el) => {
    const s = findSub(el);
    if (s) save(() => (s.title = el.value));
  },
  'sheet-sub-notes': (el) => {
    const s = findSub(el);
    if (s) save(() => (s.notes = el.value));
  },
});

Object.assign(changes, {
  'sheet-project': (el) => save((t) => (t.projectId = el.value)),
  'sheet-start': (el) => {
    save((t) => {
      t.start = el.value || null;
      if (t.start && t.end && t.end < t.start) t.end = t.start;
      clampSubsToParent(t);
    });
    renderSubs();
  },
  'sheet-end': (el) => {
    save((t) => {
      t.end = el.value || null;
      if (t.start && t.end && t.end < t.start) t.start = t.end;
      clampSubsToParent(t);
    });
    renderSubs();
  },
  'sheet-sub-start': (el) => {
    const s = findSub(el);
    if (!s) return;
    save((t) => {
      s.start = el.value || null;
      if (s.start && s.end && s.end < s.start) s.end = s.start;
      fitParentToSubs(t);
    });
    renderSubs();
  },
  'sheet-sub-end': (el) => {
    const s = findSub(el);
    if (!s) return;
    save((t) => {
      s.end = el.value || null;
      if (s.start && s.end && s.end < s.start) s.start = s.end;
      fitParentToSubs(t);
    });
    renderSubs();
  },
});

Object.assign(enters, {
  'sheet-title-enter': (el) => {
    el.blur();
    if (current?.isNew) sheet().querySelector('#sheet-sub-add')?.focus();
  },
  'sheet-sub-add': (el) => {
    const title = el.value.trim();
    if (!title) return;
    el.value = '';
    save((t) => {
      t.subtasks.push(makeSub({ title, start: t.start, end: t.end }));
    });
    renderSubs();
    el.focus();
  },
});

export function initSheet() {
  const root = sheet();
  root.addEventListener('click', (e) => {
    if (e.target === root) closeSheet(); // backdrop
  });
  root.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet();
  });

  // Drag the grabber down to dismiss (phones).
  let startY = null;
  root.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-grab]')) return;
    startY = e.clientY;
    e.target.setPointerCapture(e.pointerId);
    root.style.transition = 'none';
  });
  root.addEventListener('pointermove', (e) => {
    if (startY !== null) root.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    root.style.transition = '';
    if (dy > 90) closeSheet();
    else root.style.transform = '';
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}
