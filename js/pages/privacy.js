import { h } from '../core/dom.js';
import { CONFIG } from '../config.js';
import { getLang } from '../i18n/index.js';
import { POLICY, UPDATED } from './privacy-text.js';

// Политика показывается на русском и казахском; язык по умолчанию совпадает с языком сайта
export default async function page({ query }) {
  const wrap = h('div', { class: 'legal' });
  let lang = query.lang === 'kk' || query.lang === 'ru' ? query.lang : getLang();

  const withMail = (s) => {
    const parts = s.split('<EMAIL>');
    const out = [];
    parts.forEach((p, i) => { out.push(p); if (i < parts.length - 1) out.push(h('a', { href: 'mailto:' + CONFIG.SUPPORT_EMAIL }, CONFIG.SUPPORT_EMAIL)); });
    return out;
  };

  function paint() {
    const d = POLICY[lang];
    wrap.replaceChildren(
      h('div', { class: 'seg lang-switch', role: 'group' },
        ...[['ru', 'Русский'], ['kk', 'Қазақша']].map(([c, l]) => h('button', { type: 'button', 'aria-pressed': String(lang === c), onclick: () => { lang = c; paint(); } }, l))),
      h('h1', { lang }, d.title),
      h('p', { class: 'muted' }, `${d.updated}: ${UPDATED[lang]}`),
      ...d.sections.flatMap((s) => [
        h('h2', { lang }, s.h),
        ...(s.p || []).map((p) => h('p', { lang }, ...withMail(p))),
        s.ul ? h('ul', { lang }, ...s.ul.map((li) => h('li', null, ...withMail(li)))) : null,
      ]));
  }
  paint();
  return { el: wrap, title: 'Privacy' };
}
