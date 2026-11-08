import { createStore, memoryStorage } from './skyjo-store.js';
import { createApp } from './ui.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Trova tutti gli elementi cliccabili nell'HTML (data-act + data-*), come farebbe un dito.
function clickables(html) {
  const out = [];
  for (const m of html.matchAll(/<(?:button|div)\b[^>]*\bdata-act="[^"]+"[^>]*>/g)) {
    const ds = {};
    for (const a of m[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)) ds[a[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[2];
    out.push(ds);
  }
  return out;
}
const dirty = (html) => /undefined|NaN|\[object|null</.test(html);

function makeApp() {
  const storage = memoryStorage();
  const store = createStore({ storage });
  let downloaded = null;
  const app = createApp(store, { storage, confirm: () => true, setTimeout: () => {}, download: (name, text) => { downloaded = { name, text }; } });
  return { storage, store, app, getDownload: () => downloaded };
}

// ---------- 1) flusso completo: home -> setup -> partita -> fine, pilotato SOLO dai controlli renderizzati ----------
const { store, app, getDownload } = makeApp();
let html = app.render();
assert(html.includes('SKYJO') && html.includes('Pass &amp; Play') && html.includes('Online') && !dirty(html), 'home');
assert(!html.includes('Resume'), 'nessuna partita salvata all\'inizio');

app.click({ act: 'newLocal' });
html = app.render();
assert(html.includes('Classic 3×4') && html.includes('Variant 4×5') && !dirty(html), 'setup');
app.input('n1', 'Anna');
app.click({ act: 'preset', rows: '4', cols: '5' });
assert(app.render().includes('20 cards each'), 'preset 4×5');
assert(/data-v="150" class="chip on"/.test(app.render()), 'obiettivo suggerito 150 per 4×5');
app.click({ act: 'step', field: 'reveal', d: '1' });
app.click({ act: 'step', field: 'reveal', d: '1' }); // 2 -> 4
app.click({ act: 'target', v: 'none' }); // senza limite: si chiude a mano dopo 3 round
app.click({ act: 'start' });

let st = store.getState();
assert(st.screen === 'game' && st.game.phase === 'initialReveal', 'partita avviata');
assert(st.game.config.initialReveal === 4 && st.game.config.rows === 4 && st.game.config.targetScore === null, 'impostazioni applicate');
assert(st.game.players[0].name === 'Anna' && st.game.players[1].name === 'Player 2', 'nomi (default per il secondo)');
html = app.render();
assert(html.includes('Each reveals 4 cards'), 'hint scoperta iniziale');
assert(clickables(html).filter((d) => d.act === 'cell').length === 40, 'in scoperta iniziale tutte le 40 carte coperte sono toccabili');

const PLAY = new Set(['cell', 'draw', 'take', 'discard', 'next']);
const seen = new Set();
const seatOrder = (h) => [...h.matchAll(/aria-label="Grid of ([^"]+)"/g)].map((m) => m[1]).join('|');
const firstOrder = seatOrder(html);
assert(firstOrder === 'Anna|Player 2', 'ordine fisso: giocatore 1 poi giocatore 2');
let n = 0;
while (store.getState().game.phase !== 'gameOver') {
  html = app.render();
  assert(seatOrder(html) === firstOrder, 'il tavolo non deve cambiare disposizione tra un turno e l\'altro');
  assert(!/data-v="null"/.test(html), 'nessun valore nullo nelle carte');
  if (store.getState().game.phase === 'roundOver' && store.getState().game.round >= 3) {
    assert(html.includes('End the game here'), 'pulsante di chiusura a fine round');
    seen.add('finish');
    app.click({ act: 'finish' });
    continue;
  }
  assert(!dirty(html), 'HTML pulito in fase ' + store.getState().game.phase + ': ' + (html.match(/.{20}(undefined|NaN|\[object|null<).{20}/) || [''])[0]);
  const c = clickables(html).filter((d) => PLAY.has(d.act));
  assert(c.length > 0, 'UI bloccata: nessuna azione in fase ' + store.getState().game.phase);
  const disc = c.find((d) => d.act === 'discard');
  const ds = disc && Math.random() < 0.3 ? disc : pick(c);
  seen.add(ds.act);
  app.click(ds);
  assert(!store.getState().error, 'la UI ha offerto una mossa illegale: ' + store.getState().error);
  assert(++n < 30000, 'la partita deve finire');
}
for (const a of ['cell', 'draw', 'take', 'discard', 'next']) assert(seen.has(a), 'azione mai esercitata: ' + a);

html = app.render();
assert(/ wins!|tie!/.test(html) && html.includes('Rematch') && html.includes('per round') && !dirty(html), 'schermata fine partita');
st = store.getState();
assert(st.stats.games.length === 1, 'partita registrata nello storico');

// statistiche
app.click({ act: 'stats' });
html = app.render();
assert(html.includes('Stats') && html.includes('Anna') && html.includes('points / round') && html.includes('Export backup') && !dirty(html), 'schermata statistiche');
app.click({ act: 'export' });
const dl = getDownload();
assert(dl && dl.name.endsWith('.json') && JSON.parse(dl.text).games.length === 1, 'export JSON');
app.click({ act: 'back' });
assert(store.getState().screen === 'game', 'indietro riporta alla partita');

// undo (local): take back the last move, only one step
{
  const { store: s3, app: a3 } = makeApp();
  a3.click({ act: 'newLocal' }); a3.click({ act: 'start' });
  while (s3.getState().game.phase === 'initialReveal') a3.click(clickables(a3.render()).find((d) => d.act === 'cell'));
  assert(a3.render().includes('data-act="undo"'), 'undo offered after a move');
  a3.click({ act: 'undo' });
  assert(s3.getState().game.phase === 'initialReveal' && !a3.render().includes('data-act="undo"'), 'one step back, then nothing to undo');
  while (s3.getState().game.phase === 'initialReveal') a3.click(clickables(a3.render()).find((d) => d.act === 'cell'));
  a3.click({ act: 'draw' });
  const hand = s3.getState().game.turn.drawn;
  a3.click({ act: 'discard' }); // the discard pile itself is a 'discard' target while holding a deck card
  assert(s3.getState().game.discardPile.at(-1) === hand, 'discarded onto the pile');
}

// rivincita: nuova partita con le stesse regole
app.click({ act: 'again' });
st = store.getState();
assert(st.game.phase === 'initialReveal' && st.game.round === 1 && st.game.config.rows === 4 && st.game.players[0].name === 'Anna', 'rivincita');
// menu / uscita
app.click({ act: 'menu' });
assert(app.render().includes('Quit game'), 'menu aperto');
app.click({ act: 'exit' });
assert(store.getState().screen === 'home' && store.getState().game === null, 'uscita alla home');
assert(!app.render().includes('Resume'), 'partita abbandonata non riproposta');

// ---------- 2) riprendi dalla home ----------
{
  const { store: s, app: a, storage } = makeApp();
  a.click({ act: 'newLocal' }); a.click({ act: 'start' });
  for (let i = 0; i < 12; i++) { const c = clickables(a.render()).filter((d) => PLAY.has(d.act)); a.click(pick(c)); }
  const a2 = (() => { const s2 = createStore({ storage }); return { s2, app: createApp(s2, { storage, confirm: () => true, setTimeout: () => {} }) }; })();
  const home = a2.app.render();
  assert(home.includes('Resume') && home.includes('Round 1') && home.includes('Player 1'), 'home propone di riprendere');
  a2.app.click({ act: 'resume' });
  assert(a2.s2.getState().screen === 'game' && a2.s2.getState().game.round === 1, 'ripresa dalla home');
}

// ---------- 3) i nomi sono escapati (niente HTML iniettato) ----------
{
  const { app: a } = makeApp();
  a.click({ act: 'newLocal' });
  a.input('n1', '<img src=x onerror=alert(1)>');
  a.click({ act: 'start' });
  const h = a.render();
  assert(!h.includes('<img src=x') && h.includes('&lt;img'), 'nome escapato');
}

// ---------- 4) import statistiche da file ----------
{
  const { store: s2, app: a2 } = makeApp();
  a2.importJson(dl.text);
  assert(s2.getState().stats.games.length === 1 && a2.render().includes('Imported 1 game'), 'import');
  a2.importJson('non è json');
  assert(a2.render().includes('Invalid file'), 'import rifiuta file sbagliati');
}

console.log(`OK: interfaccia — partita 4×5 completa giocata solo dai controlli (${n} tocchi), statistiche, export/import, ripresa, escape`);
