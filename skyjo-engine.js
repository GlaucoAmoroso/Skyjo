// skyjo-engine.js
// Engine PURO: nessun DOM, nessuna rete, nessun localStorage.
// Stato 100% serializzabile (JSON) -> identico per Pass&Play e Remote.
// API principale:  createGame(config, seed)  +  applyAction(state, action)

export const DECK_DISTRIBUTION = (() => {
  const d = { '-2': 5, '-1': 10, '0': 15 };
  for (let v = 1; v <= 12; v++) d[v] = 10;
  return d; // totale: 5 + 10 + 15 + 120 = 150
})();

export const DEFAULT_CONFIG = {
  playerNames: ['Giocatore 1', 'Giocatore 2'],
  rows: 3,
  cols: 4,
  initialReveal: 2,
  targetScore: 100,   // null = nessun limite, si gioca finché volete
  doubleOnFail: true, // regola ufficiale: chi chiude e non ha il punteggio più basso raddoppia (se > 0)
};

// ---------- RNG deterministico (mulberry32), seed salvato nello stato ----------
function rand(seed) {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

function shuffle(arr, seed) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    let r;
    [r, seed] = rand(seed);
    const j = Math.floor(r * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return [a, seed];
}

export function buildDeck() {
  const deck = [];
  for (const [value, qty] of Object.entries(DECK_DISTRIBUTION))
    for (let i = 0; i < qty; i++) deck.push(Number(value));
  return deck;
}

// ---------- Errori di regola (non sono bug: sono mosse illegali) ----------
class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

// ---------- Creazione partita ----------
export function createGame(config = {}, seed = (Math.random() * 2 ** 32) >>> 0) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const n = cfg.playerNames.length;
  const cells = cfg.rows * cfg.cols;
  if (n < 2) fail('Servono almeno 2 giocatori');
  if (cfg.initialReveal < 1 || cfg.initialReveal > cells) fail('Carte iniziali scoperte non valide');
  if (cells * n + 1 > 150) fail('Mazzo insufficiente per questa griglia/numero di giocatori');
  return {
    config: cfg,
    seed,
    phase: 'lobby', // lobby | initialReveal | playing | roundOver | gameOver
    round: 0,
    players: cfg.playerNames.map((name) => ({ name, grid: [], total: 0, roundScores: [] })),
    drawPile: [],
    discardPile: [],
    current: null,
    lastFinisher: null,
    finisher: null,
    turn: { step: null, drawn: null, from: null }, // step: draw | place | flip
    roundHistory: [],
  };
}

// ---------- Helper di griglia: indice = r * cols + c, colonna = indice % cols ----------
const isRevealed = (cell) => cell === null || cell.up;
const cellValue = (cell) => (cell ? cell.v : 0);
const revealedSum = (p) => p.grid.reduce((t, c) => t + (c && c.up ? c.v : 0), 0);
const countUp = (p) => p.grid.filter((c) => c && c.up).length;

function clearColumns(s, p) {
  const { rows, cols } = s.config;
  for (let c = 0; c < cols; c++) {
    const idx = Array.from({ length: rows }, (_, r) => r * cols + c);
    const cells = idx.map((i) => p.grid[i]);
    if (cells.some((x) => x === null || !x.up)) continue;
    if (cells.every((x) => x.v === cells[0].v)) {
      for (const i of idx) { s.discardPile.push(p.grid[i].v); p.grid[i] = null; }
    }
  }
}

function drawFromPile(s) {
  if (s.drawPile.length === 0) {
    if (s.discardPile.length < 2) fail('Nessuna carta disponibile da pescare');
    const top = s.discardPile.pop();
    [s.drawPile, s.seed] = shuffle(s.discardPile, s.seed);
    s.discardPile = [top];
  }
  return s.drawPile.pop();
}

function assertTurn(s, a, step) {
  if (s.phase !== 'playing') fail('Il round non è in corso');
  if (a.player !== s.current) fail('Non è il tuo turno');
  if (s.turn.step !== step) fail(`Azione non valida ora (attesa: ${s.turn.step})`);
}

function assertCell(p, index, wantUp) {
  const cell = p.grid[index];
  if (cell === undefined || cell === null) fail('Carta inesistente');
  if (wantUp !== undefined && cell.up !== wantUp) fail(wantUp ? 'Carta già coperta' : 'Carta già scoperta');
  return cell;
}

// ---------- Fine turno / fine round ----------
function finishTurn(s) {
  const p = s.players[s.current];
  clearColumns(s, p);
  if (s.finisher === null && p.grid.every(isRevealed)) s.finisher = s.current;
  s.current = (s.current + 1) % s.players.length;
  s.turn = { step: 'draw', drawn: null, from: null };
  if (s.finisher !== null && s.current === s.finisher) endRound(s);
}

function endRound(s) {
  for (const p of s.players) p.grid.forEach((c) => { if (c) c.up = true; });
  const raw = s.players.map((p) => p.grid.reduce((t, c) => t + cellValue(c), 0));
  const scores = raw.slice();
  let doubled = false;
  const f = s.finisher;
  if (s.config.doubleOnFail && raw[f] > 0) {
    const someoneLowerOrEqual = raw.some((v, i) => i !== f && v <= raw[f]);
    if (someoneLowerOrEqual) { scores[f] = raw[f] * 2; doubled = true; }
  }
  s.players.forEach((p, i) => { p.total += scores[i]; p.roundScores.push(scores[i]); });
  s.roundHistory.push({ round: s.round, finisher: f, raw, scores, doubled });
  s.lastFinisher = f;
  const target = s.config.targetScore;
  s.phase = target != null && s.players.some((p) => p.total >= target) ? 'gameOver' : 'roundOver';
  s.current = null;
  s.turn = { step: null, drawn: null, from: null };
}

// ---------- Azioni ----------
const handlers = {
  START_ROUND(s) {
    if (s.phase !== 'lobby' && s.phase !== 'roundOver') fail('Round già in corso');
    const { rows, cols } = s.config;
    s.round += 1;
    let deck;
    [deck, s.seed] = shuffle(buildDeck(), s.seed);
    for (const p of s.players)
      p.grid = Array.from({ length: rows * cols }, () => ({ v: deck.pop(), up: false }));
    s.discardPile = [deck.pop()];
    s.drawPile = deck;
    s.finisher = null;
    s.current = null;
    s.phase = 'initialReveal';
  },

  REVEAL(s, a) { // scoperta iniziale: ognuno scopre N carte, in qualsiasi ordine
    if (s.phase !== 'initialReveal') fail('Non è la fase di scoperta iniziale');
    const p = s.players[a.player];
    if (!p) fail('Giocatore inesistente');
    if (countUp(p) >= s.config.initialReveal) fail('Hai già scoperto tutte le carte iniziali');
    assertCell(p, a.index, false).up = true;
    if (s.players.every((q) => countUp(q) >= s.config.initialReveal)) {
      s.players.forEach((q) => clearColumns(s, q));
      const sums = s.players.map(revealedSum);
      s.current = s.round === 1 || s.lastFinisher === null
        ? sums.indexOf(Math.max(...sums))   // round 1: chi ha la somma più alta
        : s.lastFinisher;                   // round successivi: chi ha chiuso il precedente
      s.phase = 'playing';
      s.turn = { step: 'draw', drawn: null, from: null };
    }
  },

  DRAW_DECK(s, a) {
    assertTurn(s, a, 'draw');
    s.turn = { step: 'place', drawn: drawFromPile(s), from: 'deck' };
  },

  TAKE_DISCARD(s, a) {
    assertTurn(s, a, 'draw');
    if (s.discardPile.length === 0) fail('Scarti vuoti');
    s.turn = { step: 'place', drawn: s.discardPile.pop(), from: 'discard' };
  },

  SWAP(s, a) { // scambia la carta in mano con una della griglia (scoperta o coperta)
    assertTurn(s, a, 'place');
    const p = s.players[s.current];
    const old = assertCell(p, a.index);
    s.discardPile.push(old.v);
    p.grid[a.index] = { v: s.turn.drawn, up: true };
    finishTurn(s);
  },

  DISCARD_DRAWN(s, a) { // solo se pescata dal mazzo: poi si DEVE scoprire una carta coperta
    assertTurn(s, a, 'place');
    if (s.turn.from !== 'deck') fail('La carta presa dagli scarti va obbligatoriamente scambiata');
    s.discardPile.push(s.turn.drawn);
    s.turn = { step: 'flip', drawn: null, from: null };
  },

  FLIP(s, a) {
    assertTurn(s, a, 'flip');
    assertCell(s.players[s.current], a.index, false).up = true;
    finishTurn(s);
  },

  END_GAME(s) { // chiusura volontaria (utile con targetScore = null): solo a fine round
    if (s.phase !== 'roundOver') fail('Puoi chiudere la partita solo a fine round');
    s.phase = 'gameOver';
  },
};

// Ritorna { ok:true, state } oppure { ok:false, error }. Non muta mai lo stato in ingresso.
export function applyAction(state, action) {
  try {
    const s = structuredClone(state);
    const h = handlers[action.type];
    if (!h) fail(`Azione sconosciuta: ${action.type}`);
    h(s, action);
    return { ok: true, state: s };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------- Utility per UI / rete ----------
// Per la modalità Remote: l'host manda all'altro peer lo stato con il mazzo nascosto.
export function redactForPeer(state) {
  const s = structuredClone(state);
  s.drawPile = { count: s.drawPile.length };
  s.players.forEach((p) => p.grid.forEach((c) => { if (c && !c.up) c.v = null; }));
  return s;
}

export const legalMoves = (s) => {
  if (s.phase === 'playing') {
    const t = s.turn.step;
    const g = s.players[s.current].grid;
    if (t === 'draw') return ['DRAW_DECK', ...(s.discardPile.length ? ['TAKE_DISCARD'] : [])];
    if (t === 'place') return [...(s.turn.from === 'deck' ? ['DISCARD_DRAWN'] : []), ...g.map((c, i) => (c ? 'SWAP:' + i : null)).filter(Boolean)];
    if (t === 'flip') return g.map((c, i) => (c && !c.up ? 'FLIP:' + i : null)).filter(Boolean);
  }
  return [];
};
