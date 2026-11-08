import { createGame, applyAction, redactForPeer } from './skyjo-engine.js';
import { diffEvents } from './skyjo-fx.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const KEY = /^(deck|discard|held|c-\d+-\d+)$/;

function botAction(s) {
  const upN = (p) => p.grid.filter((c) => c && c.up).length;
  if (s.phase === 'lobby' || s.phase === 'roundOver') return { type: 'START_ROUND' };
  if (s.phase === 'initialReveal') {
    const pi = s.players.findIndex((p) => upN(p) < s.config.initialReveal);
    return { type: 'REVEAL', player: pi, index: s.players[pi].grid.findIndex((c) => c && !c.up) };
  }
  const me = s.current, grid = s.players[me].grid, t = s.turn.step;
  if (t === 'draw') return { type: Math.random() < 0.5 && s.discardPile.length ? 'TAKE_DISCARD' : 'DRAW_DECK', player: me };
  if (t === 'place') {
    if (s.turn.from === 'deck' && Math.random() < 0.4) return { type: 'DISCARD_DRAWN', player: me };
    return { type: 'SWAP', player: me, index: pick(grid.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)) };
  }
  return { type: 'FLIP', player: me, index: pick(grid.map((c, i) => (c && !c.up ? i : -1)).filter((i) => i >= 0)) };
}

const stats = { deal: 0, draw: 0, place: 0, toDiscard: 0, reveal: 0, clear: 0, sheet: 0 };
let transitions = 0;

for (const [rows, cols, init] of [[3, 4, 2], [4, 5, 3], [4, 5, 2]]) {
  for (let g = 0; g < 40; g++) {
    let s = createGame({ rows, cols, initialReveal: init, targetScore: 80 }, 1000 + g);
    let guard = 0;
    while (s.phase !== 'gameOver' && guard++ < 50000) {
      const action = botAction(s);
      const r = applyAction(s, action);
      assert(r.ok, 'mossa legale rifiutata: ' + r.error);
      const P = s, N = r.state;
      assert(N.lastMove && N.lastMove.type === action.type, 'lastMove registrato');
      const ev = diffEvents(P, N);
      transitions++;
      assert(ev.length > 0, `ogni mossa produce almeno un evento (${action.type})`);
      for (const e of ev) stats[e.kind]++;

      const keyOf = (p, i) => `c-${p}-${i}`;
      const valid = (k) => KEY.test(k);

      if (action.type === 'START_ROUND') {
        eqDeal(ev, N);
      } else {
        // chiavi sempre ben formate
        for (const e of ev) {
          for (const k of [e.key, e.to, e.from, ...(e.keys ?? [])].filter(Boolean)) assert(valid(k), 'chiave valida: ' + k);
        }
        const kinds = ev.map((e) => e.kind);
        if (action.type === 'DRAW_DECK') assert(ev[0].kind === 'draw' && ev[0].from === 'deck' && N.turn.drawn !== null, 'pesca dal mazzo');
        if (action.type === 'TAKE_DISCARD') assert(ev[0].kind === 'draw' && ev[0].from === 'discard', 'prende lo scarto');
        if (action.type === 'DISCARD_DRAWN') assert(ev[0].kind === 'toDiscard' && ev[0].from === 'held', 'scarta la carta in mano');
        if (action.type === 'SWAP') {
          const k = keyOf(action.player, action.index);
          const td = ev.find((e) => e.kind === 'toDiscard');
          assert(td && td.from === k, 'la vecchia carta va negli scarti');
          assert(td.flip === !P.players[action.player].grid[action.index].up, 'si capovolge solo se era coperta');
          const placed = ev.find((e) => e.kind === 'place');
          const cellNow = N.players[action.player].grid[action.index];
          if (cellNow) assert(placed && placed.to === k, 'la carta in mano arriva nella cella');
          else assert(!placed && ev.some((e) => e.kind === 'clear' && e.keys.includes('held')), 'colonna annullata dallo scambio: la carta in mano sparisce');
        }
        if (action.type === 'REVEAL' || action.type === 'FLIP') {
          const k = keyOf(action.player, action.index);
          if (N.players[action.player].grid[action.index]) assert(ev.some((e) => e.kind === 'reveal' && e.key === k), 'si gira una carta');
          else {
            // girata e subito annullata con la colonna: si deve vedere prima il valore
            const cl = ev.find((e) => e.kind === 'clear');
            assert(cl && cl.keys.includes(k) && cl.flip && cl.flip.key === k, 'carta girata e annullata: prima si mostra');
            assert(cl.flip.value === N.discardPile[N.discardPile.length - 1], 'il valore mostrato è quello della colonna annullata');
            stats.flipClear = (stats.flipClear ?? 0) + 1;
          }
        }

        // reveal e clear coerenti con lo stato
        for (const e of ev.filter((x) => x.kind === 'reveal')) {
          const [, p, i] = e.key.split('-').map(Number);
          assert(!P.players[p].grid[i].up && N.players[p].grid[i].up, 'reveal: era coperta, ora è scoperta');
        }
        for (const e of ev.filter((x) => x.kind === 'clear')) {
          for (const k of e.keys.filter((x) => x !== 'held')) {
            const [, p, i] = k.split('-').map(Number);
            assert(P.players[p].grid[i] && N.players[p].grid[i] === null, 'clear: la carta c\'era ed ora no');
          }
        }
        const sheet = ev.find((e) => e.kind === 'sheet');
        assert(!!sheet === ((N.phase === 'roundOver' || N.phase === 'gameOver') && N.phase !== P.phase), 'pannello solo al cambio di fase');
      }
      // lo stesso risultato col guest (stato oscurato): niente deve dipendere dalle carte coperte
      const evGuest = diffEvents(redactForPeer(P), redactForPeer(N));
      assert(JSON.stringify(evGuest) === JSON.stringify(ev), 'eventi identici sul guest (stato oscurato)');
      s = N;
    }
  }
}

function eqDeal(ev, N) {
  assert(ev.length === 1 && ev[0].kind === 'deal', 'nuovo round: una sola distribuzione');
  assert(ev[0].keys.length === N.config.rows * N.config.cols * N.players.length, 'si distribuiscono tutte le carte');
}

// stati identici o senza mossa: nessuna animazione
const g0 = createGame({}, 5);
assert(diffEvents(null, g0).length === 0 && diffEvents(g0, g0).length === 0, 'nessun evento senza cambio');

for (const k of ['deal', 'draw', 'place', 'toDiscard', 'reveal', 'sheet']) assert(stats[k] > 0, 'evento mai prodotto: ' + k);

// Scenario costruito: uno scambio che chiude una colonna (carta in mano = 5, colonna di 5).
{
  let s = createGame({ rows: 3, cols: 4, initialReveal: 2, targetScore: null }, 43);
  s = applyAction(s, { type: 'START_ROUND' }).state;
  for (let i = 0; i < 2; i++) for (let p = 0; p < 2; p++) s = applyAction(s, { type: 'REVEAL', player: p, index: i }).state;
  const me = s.current;
  const g = s.players[me].grid;
  g[0] = { v: 5, up: true }; g[4] = { v: 5, up: true }; g[8] = { v: 9, up: false };
  s.turn = { step: 'place', drawn: 5, from: 'deck' };
  const P = s;
  const N = applyAction(P, { type: 'SWAP', player: me, index: 8 }).state;
  const ev = diffEvents(P, N);
  assert(!ev.some((e) => e.kind === 'place'), 'la cella non esiste più: nessun atterraggio');
  const td = ev.find((e) => e.kind === 'toDiscard');
  assert(td.from === 'c-' + me + '-8' && td.flip === true, 'la carta coperta sostituita va negli scarti, girandosi');
  const cl = ev.find((e) => e.kind === 'clear');
  assert(cl && cl.keys.includes('held') && cl.keys.includes('c-' + me + '-0') && cl.keys.includes('c-' + me + '-4') && !cl.flip, 'la colonna e la carta in mano volano via');
}

// Scenario costruito: giro l'ultima carta di una colonna di 5, che si annulla.
{
  let s = createGame({ rows: 3, cols: 4, initialReveal: 2, targetScore: null }, 42);
  s = applyAction(s, { type: 'START_ROUND' }).state;
  for (let i = 0; i < 2; i++) for (let p = 0; p < 2; p++) s = applyAction(s, { type: 'REVEAL', player: p, index: i }).state;
  const me = s.current;
  const g = s.players[me].grid;
  g[0] = { v: 5, up: true }; g[4] = { v: 5, up: true }; g[8] = { v: 5, up: false };
  s.turn = { step: 'flip', drawn: null, from: null };
  const P = s;
  const N = applyAction(P, { type: 'FLIP', player: me, index: 8 }).state;
  const cl = diffEvents(P, N).find((e) => e.kind === 'clear');
  assert(cl && cl.keys.length === 3 && ['c-' + me + '-0', 'c-' + me + '-4', 'c-' + me + '-8'].every((k) => cl.keys.includes(k)), 'si annullano le tre carte');
  assert(cl.flip && cl.flip.key === 'c-' + me + '-8' && cl.flip.value === 5, 'si mostra prima la carta girata (valore 5)');
  assert(diffEvents(redactForPeer(P), redactForPeer(N)).find((e) => e.kind === 'clear').flip.value === 5, 'valore noto anche al guest');
}
console.log(`OK: animazioni dedotte correttamente su ${transitions} mosse (${Object.entries(stats).map(([k, v]) => `${k}:${v}`).join(' ')})`);
