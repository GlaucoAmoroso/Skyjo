// app.js — glue between the DOM, the interface (ui.js) and animations (fx-dom.js). No game logic here.
import { createStore } from './skyjo-store.js';
import { createApp } from './ui.js';
import { diffEvents } from './skyjo-fx.js';
import { capture, play } from './fx-dom.js';
import { createOnline } from './transport-peerjs.js';

const root = document.getElementById('app');

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Online mode (PeerJS is only downloaded when a room is opened or joined).
const net = createOnline();
let hostTransport = null;
const online = { ...net, host: async (code) => (hostTransport = await net.host(code)) };

const store = createStore();
const app = createApp(store, { onChange: paint, download, online });

// "Smart" repaint: elements with a data-key whose HTML did not change stay the same DOM nodes,
// so running animations are not interrupted by a later repaint.
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
  const events = diffEvents(prevGame, game); // what just happened, to animate
  const snap = capture(root, events);        // starting positions (before repainting)
  const scrollY = window.scrollY;
  morph(app.render());
  window.scrollTo(0, scrollY);
  play(root, events, snap);                  // animations (after repainting)
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

// Ask the browser not to wipe localStorage (history and saved game).
navigator.storage?.persist?.().catch(() => {});

// Keep the screen on while playing (if supported).
const keepAwake = async () => { try { await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ } };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  app.nudge();              // guest: retry right away if the link dropped while asleep
  hostTransport?.revive?.(); // host: take the room id back from the broker
});
keepAwake();

// Offline: service worker (needs https or localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
