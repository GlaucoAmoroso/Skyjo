// skyjo-fx.js — Deduce QUALI animazioni mostrare confrontando lo stato prima e dopo una mossa.
// Funzione pura, senza DOM: si può testare in Node. L'esecuzione vera è in fx-dom.js.
//
// Gli eventi parlano in "chiavi" (attributo data-key sugli elementi):
//   'deck' · 'discard' · 'held' · 'c-<giocatore>-<indice>'
// Si appoggia a state.lastMove, scritto dall'engine ad ogni mossa valida
// (arriva identico anche al guest nella modalità online).

const cellKey = (p, i) => `c-${p}-${i}`;

export function diffEvents(P, N) {
  if (!P || !N || P === N || !N.lastMove) return [];
  const m = N.lastMove;

  // Nuovo round: le carte vengono distribuite dal mazzo.
  if (m.type === 'START_ROUND') {
    const keys = [];
    const cells = N.config.rows * N.config.cols;
    for (let i = 0; i < cells; i++) N.players.forEach((_, p) => keys.push(cellKey(p, i)));
    return [{ kind: 'deal', keys }];
  }

  const ev = [];
  const pCell = (p, i) => P.players[p]?.grid[i] ?? null;
  const nCell = (p, i) => N.players[p]?.grid[i] ?? null;
  let actKey = null; // cella già raccontata dalla mossa (scambio)
  let actCleared = false;

  if (m.type === 'DRAW_DECK') ev.push({ kind: 'draw', from: 'deck' });
  else if (m.type === 'TAKE_DISCARD') ev.push({ kind: 'draw', from: 'discard' });
  else if (m.type === 'DISCARD_DRAWN') ev.push({ kind: 'toDiscard', from: 'held', flip: false });
  else if (m.type === 'SWAP') {
    actKey = cellKey(m.player, m.index);
    const old = pCell(m.player, m.index);
    actCleared = nCell(m.player, m.index) === null; // lo scambio ha chiuso una colonna
    if (!actCleared) ev.push({ kind: 'place', to: actKey });
    ev.push({ kind: 'toDiscard', from: actKey, flip: !!old && !old.up, delay: 70 });
  }

  // Carte che si girano (scoperta, FLIP, o fine round: tutte le restanti).
  const reveals = [];
  N.players.forEach((pl, p) => pl.grid.forEach((c, i) => {
    const o = pCell(p, i);
    if (c && c.up && o && !o.up && cellKey(p, i) !== actKey) reveals.push(cellKey(p, i));
  }));
  reveals.forEach((key, order) => ev.push({ kind: 'reveal', key, order }));

  // Colonne annullate: le carte volano via negli scarti.
  const cleared = [];
  N.players.forEach((pl, p) => pl.grid.forEach((c, i) => {
    if (c === null && pCell(p, i) && cellKey(p, i) !== actKey) cleared.push(cellKey(p, i));
  }));
  if (actCleared) cleared.push('held'); // anche la carta in mano finisce nella colonna annullata

  // Ho girato l'ultima carta di una colonna uguale: prima la si vede, poi la colonna vola via.
  // Il valore si ricava dalle altre carte della colonna (tutte scoperte e uguali), quindi funziona anche sul guest.
  let flip = null;
  if ((m.type === 'FLIP' || m.type === 'REVEAL') && nCell(m.player, m.index) === null) {
    const cols = N.config.cols;
    const mate = P.players[m.player].grid.find((c, i) => i % cols === m.index % cols && i !== m.index && c && c.up);
    if (mate) flip = { key: cellKey(m.player, m.index), value: mate.v };
  }
  if (cleared.length) ev.push({ kind: 'clear', keys: cleared, delay: reveals.length ? 450 : 250, ...(flip ? { flip } : {}) });

  // Pannello di fine round / partita.
  if ((N.phase === 'roundOver' || N.phase === 'gameOver') && N.phase !== P.phase)
    ev.push({ kind: 'sheet', delay: reveals.length ? 700 : 150 });

  return ev;
}
