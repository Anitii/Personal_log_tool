// Shared DOM helpers: escaping, event delegation, icons, toast, color picker.
import { PALETTE } from './core.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One document-level listener per event type; views declare handlers by name.
export const actions = {}; // data-act   → click
export const inputs = {}; //  data-in    → input
export const changes = {}; // data-ch    → change
export const enters = {}; //  data-enter → Enter key

const stroke = (d, extra = '') =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const icon = {
  today: stroke('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none"/>'),
  gantt: stroke('<path d="M4 6h9M8 12h11M6 18h7"/>', 'stroke-width="2.6"'),
  list: stroke('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5.5l1 1 1.8-2M4 11.5l1 1 1.8-2M4 17.5l1 1 1.8-2"/>'),
  gear: stroke('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>', 'stroke-width="2.4"'),
  chevR: stroke('<path d="M9 5.5l6.5 6.5L9 18.5"/>', 'stroke-width="2.4"'),
  chevD: stroke('<path d="M5.5 9l6.5 6.5L18.5 9"/>', 'stroke-width="2.4"'),
  more: stroke('<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>'),
  x: stroke('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2.3"'),
  up: stroke('<path d="M6 14.5L12 8.5l6 6"/>', 'stroke-width="2.3"'),
  down: stroke('<path d="M6 9.5l6 6 6-6"/>', 'stroke-width="2.3"'),
  trash: stroke('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>'),
  copy: stroke('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9"/>'),
  cal: stroke('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  note: stroke('<path d="M5 5h14v10l-5 5H5z"/><path d="M14 20v-5h5"/>'),
  link: stroke('<path d="M10 14a4 4 0 0 0 6 .4l3-3a4.2 4.2 0 0 0-6-6l-1.4 1.4"/><path d="M14 10a4 4 0 0 0-6-.4l-3 3a4.2 4.2 0 0 0 6 6l1.4-1.4"/>'),
  back: stroke('<path d="M15 5.5L8.5 12l6.5 6.5"/>', 'stroke-width="2.4"'),
  book: stroke('<path d="M6 3.5h13.5V20H6.5A2.5 2.5 0 0 1 4 17.5V5.5a2 2 0 0 1 2-2z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15h13M9 8h6"/>'),
  share: stroke('<path d="M12 15V4M8 7.5l4-4 4 4"/><path d="M7 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H17"/>'),
  star: stroke('<path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>'),
  starOn: stroke('<path fill="currentColor" d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>'),
};

// Macaron swatches plus the system color picker. `auto` adds "follow the default".
export function colorRowHTML({ value, target, id = '', auto = false }) {
  const attrs = `data-target="${esc(target)}" data-id="${esc(id)}"`;
  const lower = (value || '').toLowerCase();
  const custom = lower && !PALETTE.some((c) => c.toLowerCase() === lower);
  return `<div class="color-row" role="group" aria-label="選擇顏色">
    ${auto ? `<button type="button" class="swatch auto ${value ? '' : 'on'}" data-act="pick-color" ${attrs} data-v="" aria-label="預設顏色" title="預設顏色"></button>` : ''}
    ${PALETTE.map((c) => `<button type="button" class="swatch ${c.toLowerCase() === lower ? 'on' : ''}" style="background:${c}" data-act="pick-color" ${attrs} data-v="${c}" aria-label="顏色 ${c}"></button>`).join('')}
    <label class="swatch custom ${custom ? 'on' : ''}" title="自訂顏色" ${custom ? `style="background:${esc(value)}"` : ''}>
      <input type="color" value="${esc(value || '#D9C2AB')}" data-ch="pick-color-custom" ${attrs} aria-label="自訂顏色">
    </label>
  </div>`;
}

export function initDelegation({ beforeClick } = {}) {
  document.addEventListener('click', (e) => {
    if (beforeClick?.(e) === false) return;
    const el = e.target.closest('[data-act]');
    if (el) actions[el.dataset.act]?.(el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-in]');
    if (el) inputs[el.dataset.in]?.(el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-ch]');
    if (el) changes[el.dataset.ch]?.(el, e);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Enter that confirms a Zhuyin/Pinyin composition must not submit the field.
    if (e.isComposing || e.keyCode === 229) return;
    const field = e.target.closest('[data-enter]');
    if (field && e.key === 'Enter') {
      e.preventDefault();
      enters[field.dataset.enter]?.(field, e);
      return;
    }
    if (e.target.matches('[role="button"]')) {
      e.preventDefault();
      e.target.click();
    }
  });
}

let toastTimer = 0;
export function toast(message, undo, label = '復原') {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  el.innerHTML = `<span>${esc(message)}</span>${undo ? `<button type="button" class="toast-undo">${esc(label)}</button>` : ''}`;
  el.classList.add('show');
  if (undo) {
    el.querySelector('button').onclick = () => {
      el.classList.remove('show');
      undo();
    };
  }
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 5000 : 2600);
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
