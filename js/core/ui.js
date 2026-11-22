import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { t, getLang } from '../i18n/index.js';

// ---------- уведомления в правом верхнем углу
export function toast(message, type = 'info', { title = '', ms = 5200 } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('div', { style: { flex: '1' } }, title ? h('b', null, title) : null, message),
    h('button', { class: 'iconbtn', style: { width: '28px', height: '28px', color: 'inherit' }, 'aria-label': t('common.close'), onclick: () => dismiss() }, icon('x', 16)));
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 280); };
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(dismiss, ms);
}

// ---------- модальное окно
export function modal({ title, body, actions = [], onClose, wide } = {}) {
  const prevFocus = document.activeElement;
  const overlay = h('div', { class: 'overlay', role: 'presentation' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '', style: wide ? { width: 'min(680px,100%)' } : null });
  const close = (result) => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    prevFocus?.focus?.();
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button,input,select,textarea,a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  box.append(title ? h('h2', null, title) : '', body);
  if (actions.length) {
    box.append(h('div', { class: 'modal-actions' }, ...actions.map((a) => {
      const b = h('button', { class: `btn ${a.class || ''}`, type: 'button' }, a.label);
      b.addEventListener('click', async () => {
        if (a.onClick) { b.disabled = true; const keep = await a.onClick(close, b); b.disabled = false; if (keep === false) return; }
        else close(a.value);
      });
      return b;
    })));
  }
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  (box.querySelector('[autofocus],input,textarea,select') || box.querySelector('button'))?.focus();
  return { close, box };
}

export function confirmDialog(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    modal({
      title, body: h('p', { class: 'muted' }, text),
      actions: [
        { label: t('common.cancel'), class: 'ghost', value: false },
        { label: okLabel || t('common.ok'), class: danger ? 'danger' : '', value: true },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

// ---------- мелочи
export function avatar(p, cls = '') {
  const letter = (p?.display_name || p?.username || '?').trim().charAt(0).toUpperCase();
  if (p?.avatar_url) {
    const img = h('img', { class: `avatar ${cls}`, src: p.avatar_url, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: `avatar ${cls}` }, letter)), { once: true });
    return img;
  }
  return h('span', { class: `avatar ${cls}`, 'aria-hidden': 'true' }, letter);
}

export const spinner = () => h('div', { class: 'loading', role: 'status', 'aria-label': t('common.loading') }, h('div', { class: 'spinner' }));

export function timeAgo(iso) {
  const d = new Date(iso), s = Math.round((Date.now() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(getLang() === 'kk' ? 'kk' : 'ru', { numeric: 'auto' });
  if (s < 60) return t('time.now');
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 86400 * 7) return rtf.format(-Math.floor(s / 86400), 'day');
  return fmtDate(iso);
}
export const fmtDate = (iso, opts = { day: 'numeric', month: 'long', year: 'numeric' }) =>
  new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString(getLang() === 'kk' ? 'kk-KZ' : 'ru-RU', opts);
export const fmtDateTime = (iso) => new Date(iso).toLocaleString(getLang() === 'kk' ? 'kk-KZ' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// ---------- волна на кнопках (одно делегирование на весь документ)
export function initRipple() {
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('.btn:not([disabled]), .chip, .iconbtn');
    if (!b) return;
    const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2;
    const s = h('span', { class: 'ripple', style: { width: size + 'px', height: size + 'px', left: e.clientX - r.left - size / 2 + 'px', top: e.clientY - r.top - size / 2 + 'px' } });
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    b.style.overflow = b.style.overflow || 'hidden';
    b.append(s);
    setTimeout(() => s.remove(), 650);
  }, { passive: true });
}

// ---------- появление при прокрутке
let io;
export function reveal(root = document) {
  io ||= new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }, { rootMargin: '0px 0px -40px 0px' });
  root.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el));
}

export function field({ label, id, hint, ...input }) {
  const area = input.type === 'textarea';
  const el = area ? h('textarea', { class: 'textarea', id, ...input, type: null }) : h('input', { class: 'input', id, ...input });
  const hintEl = h('div', { class: 'hint', id: id + '-hint', 'aria-live': 'polite' }, hint || '');
  el.setAttribute('aria-describedby', id + '-hint');
  return { el, hintEl, wrap: h('div', { class: 'field' }, h('label', { for: id }, label), el, hintEl) };
}

export function setHint(hintEl, text, kind = '') {
  hintEl.className = `hint ${kind}`;
  hintEl.textContent = text;
}

export function popMenu(anchorWrap, items) {
  document.querySelector('.menu')?.remove();
  const menu = h('div', { class: 'menu', role: 'menu' }, ...items.map((it) => it === '-' ? h('hr') : h('button', { role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => { menu.remove(); it.onClick(); } }, it.icon ? icon(it.icon, 18) : null, it.label)));
  anchorWrap.append(menu);
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  menu.querySelector('button')?.focus();
  return menu;
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', null, title), text ? h('p', null, text) : null, action || null);
}
export { clear };
