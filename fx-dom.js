// fx-dom.js — Esegue le animazioni nel browser (Web Animations API).
//   capture(root, events) PRIMA di ridisegnare: memorizza posizioni (e copie delle carte da far sparire)
//   play(root, events, snap) DOPO il ridisegno: anima gli elementi nuovi partendo dalla vecchia posizione.
// Gli elementi si trovano tramite data-key (vedi skyjo-fx.js).
// Con "riduci movimento" attivo nel sistema non si anima nulla.

const EASE = 'cubic-bezier(.22,.8,.24,1)';
const SHADOW_LOW = '0 2px 5px rgba(70,55,25,.16)';
const SHADOW_HIGH = '0 26px 34px rgba(70,55,25,.30)';

const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const sel = (key) => `[data-key="${key}"]`;

export function capture(root, events) {
  if (!events.length) return null;
  const rects = new Map();
  root.querySelectorAll('[data-key]').forEach((el) => rects.set(el.dataset.key, el.getBoundingClientRect()));
  const clones = new Map();
  for (const e of events) {
    if (e.kind !== 'clear') continue;
    for (const key of e.keys) {
      const el = root.querySelector(sel(key));
      if (el) clones.set(key, el.cloneNode(true));
    }
  }
  return { rects, clones };
}

// La carta vola dalla posizione vecchia a quella nuova: si solleva, si inclina leggermente
// (come se si piegasse nel sollevarla) e atterra con l'ombra che si riduce.
function fly(node, from, { delay = 0, dur = 480, lift = true, tilt = 0 } = {}) {
  if (!node || !from || typeof node.animate !== 'function') return;
  const to = node.getBoundingClientRect();
  if (!to.width) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const s = from.width / to.width;
  const start = `translate(${dx}px, ${dy}px) scale(${s})`;
  const frames = lift
    ? [
        { transform: start, boxShadow: SHADOW_LOW },
        {
          transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 30}px) scale(${((1 + s) / 2) * 1.12}) perspective(800px) rotateX(18deg) rotateZ(${tilt}deg)`,
          boxShadow: SHADOW_HIGH, offset: 0.5,
        },
        { transform: 'none' },
      ]
    : [{ transform: `${start} rotate(${tilt}deg)` }, { transform: 'none' }];
  node.style.zIndex = '30';
  const a = node.animate(frames, { duration: dur, delay, easing: EASE, fill: 'backwards' });
  a.finished.then(() => { node.style.zIndex = ''; }, () => {});
}

// La carta si capovolge: parte dal dorso e mostra il valore.
function turn(node, { delay = 0, dur = 560 } = {}) {
  const inner = node?.querySelector('.card-inner');
  if (!inner || typeof inner.animate !== 'function') return;
  inner.animate(
    [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }],
    { duration: dur, delay, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' },
  );
}

// Piccolo balzo mentre si gira.
function hop(node, { delay = 0 } = {}) {
  if (!node || typeof node.animate !== 'function') return;
  node.style.zIndex = '30';
  const a = node.animate(
    [{ transform: 'none' }, { transform: 'translateY(-14px) scale(1.07)', boxShadow: SHADOW_HIGH, offset: 0.45 }, { transform: 'none' }],
    { duration: 580, delay, easing: EASE, fill: 'backwards' },
  );
  a.finished.then(() => { node.style.zIndex = ''; }, () => {});
}

const tone = (v) => (v < 0 ? 'neg' : v === 0 ? 'zero' : v <= 4 ? 'low' : v <= 8 ? 'mid' : 'high');

// Carta "fantasma" che vola negli scarti e svanisce (colonna annullata).
// Se flipValue è dato, la carta (coperta) viene prima capovolta e mostrata, poi parte.
function ghost(clone, from, to, delay, i, flipValue = null) {
  clone.removeAttribute('data-key');
  clone.classList.remove('is-target');
  clone.removeAttribute('data-act');
  if (flipValue !== null) {
    clone.classList.add('up');
    clone.querySelector('.card-inner')?.insertAdjacentHTML('beforeend',
      `<span class="face f-front tone-${tone(flipValue)}" data-v="${flipValue}"><b>${flipValue}</b></span>`);
  }
  Object.assign(clone.style, {
    position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    margin: '0', zIndex: '40', pointerEvents: 'none', outline: 'none', translate: 'none', rotate: 'none',
  });
  document.body.append(clone);
  if (flipValue !== null) turn(clone, { delay: 0 });
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const s = to.width / from.width;
  const a = clone.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 24}px) scale(1.06) rotate(${(i % 2 ? 1 : -1) * 6}deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${(i % 2 ? 1 : -1) * 3}deg)`, opacity: 0 },
    ],
    { duration: 700, delay: delay + i * 80, easing: EASE, fill: 'both' },
  );
  a.finished.then(() => clone.remove(), () => clone.remove());
}

export function play(root, events, snap) {
  if (!snap || reduced()) return;
  const el = (key) => root.querySelector(sel(key));
  const rect = (key) => snap.rects.get(key);

  for (const e of events) {
    switch (e.kind) {
      case 'deal': {
        const deckRect = el('deck')?.getBoundingClientRect(); // posizione NUOVA: il layout è cambiato
        if (!deckRect) break;
        const step = Math.min(30, 900 / e.keys.length);
        e.keys.forEach((key, n) => fly(el(key), deckRect, { delay: n * step, dur: 440, lift: false, tilt: ((n * 7) % 13) - 6 }));
        const first = e.keys.length * step;
        fly(el('discard'), deckRect, { delay: first, dur: 520, tilt: -4 });
        turn(el('discard'), { delay: first });
        break;
      }
      case 'draw':
        fly(el('held'), rect(e.from), { tilt: e.from === 'deck' ? -5 : 4 });
        if (e.from === 'deck') turn(el('held'));
        break;
      case 'place':
        fly(el(e.to), rect('held'), { tilt: 5 });
        break;
      case 'toDiscard': {
        const d = el('discard');
        fly(d, rect(e.from), { delay: e.delay ?? 0, tilt: -4 });
        if (e.flip) turn(d, { delay: e.delay ?? 0 });
        break;
      }
      case 'reveal': {
        const n = el(e.key);
        turn(n, { delay: e.order * 70 });
        hop(n, { delay: e.order * 70 });
        break;
      }
      case 'clear': {
        const to = el('discard')?.getBoundingClientRect();
        if (!to) break;
        const wait = e.flip ? 700 : 0; // se una carta si sta girando, le altre aspettano che si veda
        e.keys.forEach((key, i) => {
          const clone = snap.clones.get(key);
          const from = rect(key);
          if (clone && from) ghost(clone, from, to, e.delay + wait, i, e.flip?.key === key ? e.flip.value : null);
        });
        break;
      }
      case 'sheet': {
        const s = root.querySelector('[data-key="sheet"]');
        s?.animate?.(
          [{ transform: 'translateY(110%)', opacity: 0 }, { transform: 'none', opacity: 1 }],
          { duration: 460, delay: e.delay, easing: EASE, fill: 'backwards' },
        );
        break;
      }
      default: break;
    }
  }
}
