// app.js — colla tra DOM, interfaccia (ui.js) e animazioni (fx-dom.js). Niente logica di gioco qui.
import { createStore } from './skyjo-store.js';
import { createApp } from './ui.js';
import { diffEvents } from './skyjo-fx.js';
import { capture, play } from './fx-dom.js';

const root = document.getElementById('app');

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const store = createStore();
const app = createApp(store, { onChange: paint, download });

// Ridisegno "intelligente": gli elementi con data-key il cui HTML non è cambiato restano gli stessi nodi del DOM,
// così le animazioni in corso non vengono interrotte da un ridisegno successivo.
let prevSigs = new Map();
function morph(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const sigs = new Map();
  tpl.content.querySelectorAll('[data-key]').forEach((n) => {
    const key = n.dataset.key;
    const sig = n.outerHTML;
    sigs.set(key, sig);
    if (prevSigs.get(key) === sig) {
      const live = root.querySelector(`[data-key="${key}"]`);
      if (live) n.replaceWith(live);
    }
  });
  root.replaceChildren(tpl.content);
  prevSigs = sigs;
}

let prevGame = null;
function paint() {
  const st = store.getState();
  const game = st.screen === 'game' ? st.game : null;
  const events = diffEvents(prevGame, game); // cosa è appena successo, da animare
  const snap = capture(root, events);        // posizioni di partenza (prima del ridisegno)
  const scrollY = window.scrollY;
  morph(app.render());
  window.scrollTo(0, scrollY);
  play(root, events, snap);                  // animazioni (dopo il ridisegno)
  prevGame = game;
}

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) app.click({ ...el.dataset });
});
root.addEventListener('input', (e) => {
  if (e.target.dataset.input) app.input(e.target.dataset.input, e.target.value);
});
root.addEventListener('change', async (e) => {
  if (e.target.id !== 'importFile' || !e.target.files[0]) return;
  app.importJson(await e.target.files[0].text());
  e.target.value = '';
});

paint();

// Chiede al browser di non cancellare localStorage (storico e partita salvata).
navigator.storage?.persist?.().catch(() => {});

// Schermo acceso mentre si gioca (se supportato).
const keepAwake = async () => { try { await navigator.wakeLock?.request('screen'); } catch { /* non supportato */ } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
keepAwake();

// Offline: service worker (richiede https o localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
