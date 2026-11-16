// Pinch to zoom, from every source a browser offers: a trackpad pinch arrives as ctrl+wheel
// (Chrome, Edge, Firefox) or as gesture events (Safari); on touch screens it is two fingers.
// Handlers get the change since the last call as a factor (>1 = zoom in) and the pinch center.

const handlers = [];
export const onPinch = (selector, fn) => handlers.push({ selector, fn });

function match(target) {
  for (const h of handlers) {
    const el = target?.closest?.(h.selector);
    if (el) return { fn: h.fn, el };
  }
  return null;
}

let gesture = null;
let touch = null;
const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

export function initPinch() {
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || gesture) return;
    const m = match(e.target);
    if (!m) return;
    e.preventDefault(); // otherwise the whole page zooms
    const delta = Math.max(-40, Math.min(40, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
    m.fn(Math.exp(-delta / 90), e.clientX, e.clientY, m.el);
  }, { passive: false });

  document.addEventListener('gesturestart', (e) => {
    const m = match(e.target);
    if (!m) return;
    e.preventDefault();
    gesture = { ...m, last: 1 };
  });
  document.addEventListener('gesturechange', (e) => {
    if (!gesture) return;
    e.preventDefault();
    gesture.fn(e.scale / gesture.last, e.clientX, e.clientY, gesture.el);
    gesture.last = e.scale;
  });
  document.addEventListener('gestureend', () => {
    gesture = null;
  });

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const m = match(e.target);
    if (m) touch = { ...m, d: spread(e.touches) };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!touch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = spread(e.touches);
    if (d < 1 || touch.d < 1) return;
    const x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    touch.fn(d / touch.d, x, y, touch.el);
    touch.d = d;
  }, { passive: false });
  const end = (e) => {
    if (e.touches.length < 2) touch = null;
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
}
