import { createGame, applyAction, buildDeck, redactForPeer } from './skyjo-engine.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };

// 1) Composizione mazzo
const deck = buildDeck();
assert(deck.length === 150, 'mazzo = 150');
const cnt = (v) => deck.filter((x) => x === v).length;
assert(cnt(-2) === 5 && cnt(-1) === 10 && cnt(0) === 15 && cnt(7) === 10 && cnt(12) === 10, 'proporzioni');

const total = (s) =>
  s.drawPile.length + s.discardPile.length + (s.turn.drawn != null ? 1 : 0) +
  s.players.reduce((t, p) => t + p.grid.filter(Boolean).length, 0);

// 2) Partite complete con bot casuale, varie configurazioni
let seedBase = 1, clears = 0, doubles = 0, games = 0;
for (const [rows, cols, init] of [[3, 4, 2], [4, 5, 3], [4, 5, 2], [3, 4, 4]]) {
  for (let g = 0; g < 50; g++) {
    let s = createGame({ rows, cols, initialReveal: init, targetScore: 100 }, seedBase++);
    let guard = 0;
    while (s.phase !== 'gameOver' && guard++ < 100000) {
      let r;
      if (s.phase === 'lobby' || s.phase === 'roundOver') r = applyAction(s, { type: 'START_ROUND' });
      else if (s.phase === 'initialReveal') {
        const pi = s.players.findIndex((p) => p.grid.filter((c) => c.up).length < init);
        const idx = s.players[pi].grid.findIndex((c) => !c.up);
        r = applyAction(s, { type: 'REVEAL', player: pi, index: idx });
      } else {
        const me = s.current, grid = s.players[me].grid, t = s.turn.step;
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
        if (t === 'draw') r = applyAction(s, { type: Math.random() < 0.5 && s.discardPile.length ? 'TAKE_DISCARD' : 'DRAW_DECK', player: me });
        else if (t === 'place') {
          if (s.turn.from === 'deck' && Math.random() < 0.4) r = applyAction(s, { type: 'DISCARD_DRAWN', player: me });
          else r = applyAction(s, { type: 'SWAP', player: me, index: pick(grid.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)) });
        } else r = applyAction(s, { type: 'FLIP', player: me, index: pick(grid.map((c, i) => (c && !c.up ? i : -1)).filter((i) => i >= 0)) });
      }
      assert(r.ok, 'mossa legale rifiutata: ' + r.error);
      s = r.state;
      assert(total(s) === 150, 'conservazione carte (150) violata in fase ' + s.phase);
    }
    assert(s.phase === 'gameOver', 'la partita deve finire');
    games++;
    clears += 0;
    doubles += s.roundHistory.filter((h) => h.doubled).length;
  }
}
console.log(`OK: ${games} partite complete simulate, carte sempre 150, round con penalità raddoppio: ${doubles}`);

// 3) Test deterministico colonna annullata (3x4, griglia truccata)
{
  let s = createGame({ rows: 3, cols: 4, initialReveal: 2, targetScore: null }, 42);
  s = applyAction(s, { type: 'START_ROUND' }).state;
  for (let i = 0; i < 2; i++) for (let p = 0; p < 2; p++) s = applyAction(s, { type: 'REVEAL', player: p, index: i }).state;
  const me = s.current;
  const g = s.players[me].grid;
  // colonna 0 = indici 0,4,8: tutti 5 e scoperti tranne l'ultimo
  g[0] = { v: 5, up: true }; g[4] = { v: 5, up: true }; g[8] = { v: 9, up: false };
  s.turn = { step: 'place', drawn: 5, from: 'deck' };
  const before = s.discardPile.length;
  s = applyAction(s, { type: 'SWAP', player: me, index: 8 }).state;
  assert(s.players[me].grid[0] === null && s.players[me].grid[4] === null && s.players[me].grid[8] === null, 'colonna annullata');
  assert(s.discardPile.length === before + 1 + 3, 'carta scambiata + 3 della colonna negli scarti');
  console.log('OK: annullamento colonna');
}

// 4) Mossa fuori turno rifiutata + redazione per il peer
{
  let s = createGame({}, 7);
  s = applyAction(s, { type: 'START_ROUND' }).state;
  assert(!applyAction(s, { type: 'DRAW_DECK', player: 0 }).ok, 'pesca durante initialReveal rifiutata');
  const red = redactForPeer(s);
  assert(red.drawPile.count === s.drawPile.length && red.players[0].grid[0].v === null, 'redazione ok');
  console.log('OK: validazione mosse e redazione stato');
}
