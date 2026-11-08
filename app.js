// app.js — colla tra DOM e ui.js. Niente logica di gioco qui.
import { createStore } from './skyjo-store.js';
import { createApp } from './ui.js';

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

function paint() {
  const scrollY = window.scrollY;
  root.innerHTML = app.render();
  window.scrollTo(0, scrollY);
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
let wake = null;
const keepAwake = async () => { try { wake = await navigator.wakeLock?.request('screen'); } catch { /* non supportato */ } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
keepAwake();

// Offline: service worker (richiede https o localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
