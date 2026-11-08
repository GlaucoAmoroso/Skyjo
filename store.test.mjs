import { createStore, memoryStorage, selectView } from './skyjo-store.js';
import { emptyStats, addGame, summarizeGame, computePlayerStats, importStats, exportStats } from './skyjo-stats.js';
import { applyAction, createGame } from './skyjo-engine.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const flush = () => new Promise((r) => setTimeout(r, 0));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- trasporto in memoria (stessa interfaccia che avrà l'adapter PeerJS) ----------
function loopbackPair() {
  const mk = () => ({
    handlers: [], statusHandlers: [], open: true, peer: null,
    send(m) { const p = this.peer; if (!this.open) return; queueMicrotask(() => p.handlers.forEach((h) => h(structuredClone(m)))); },
    onMessage(h) { this.handlers.push(h); },
    onStatus(h) { this.statusHandlers.push(h); },
    isOpen() { return this.open; },
    close() { if (!this.open) return; this.open = false; this.statusHandlers.forEach((h) => h('closed')); this.peer.close(); },
  });
  const a = mk(), b = mk();
  a.peer = b; b.peer = a;
  return [a, b];
}

// ---------- bot: sceglie una mossa legale guardando solo ciò che lo store gli mostra ----------
function botMove(store) {
  const st = store.getState(), g = st.game;
  const remote = st.mode !== 'local';
  const upN = (p) => p.grid.filter((c) => c && c.up).length;
  if (g.phase === 'lobby' || g.phase === 'roundOver') {
    if (st.mode === 'guest') return false;
    return store.dispatch({ type: 'START_ROUND' }).ok;
  }
  if (g.phase === 'initialReveal') {
    const idxs = remote ? [st.seat] : g.players.map((_, i) => i);
    for (const i of idxs) {
      const p = g.players[i];
      if (upN(p) < g.config.initialReveal) {
        const cells = p.grid.map((c, k) => (c && !c.up ? k : -1)).filter((k) => k >= 0);
        return store.dispatch({ type: 'REVEAL', player: i, index: pick(cells) }).ok !== false;
      }
    }
    return false;
  }
  if (g.phase !== 'playing') return false;
  if (remote && g.current !== st.seat) return false;
  const me = g.current, grid = g.players[me].grid, t = g.turn.step;
  if (t === 'draw') return store.dispatch({ type: Math.random() < 0.5 && g.discardPile.length ? 'TAKE_DISCARD' : 'DRAW_DECK', player: me }).ok;
  if (t === 'place') {
    if (g.turn.from === 'deck' && Math.random() < 0.4) return store.dispatch({ type: 'DISCARD_DRAWN', player: me }).ok;
    return store.dispatch({ type: 'SWAP', player: me, index: pick(grid.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)) }).ok;
  }
  return store.dispatch({ type: 'FLIP', player: me, index: pick(grid.map((c, i) => (c && !c.up ? i : -1)).filter((i) => i >= 0)) }).ok;
}

// =====================================================================
// 1) Statistiche: numeri calcolati a mano
// =====================================================================
{
  const cfg = { rows: 3, cols: 4, initialReveal: 2, targetScore: 50, doubleOnFail: true };
  const g1 = {
    config: cfg,
    players: [{ name: 'Anna', total: 40, roundScores: [10, 30] }, { name: 'Bea', total: 35, roundScores: [20, 15] }],
    roundHistory: [
      { round: 1, finisher: 0, raw: [10, 20], scores: [10, 20], doubled: false },
      { round: 2, finisher: 0, raw: [15, 15], scores: [30, 15], doubled: true },
    ],
  };
  const g2 = {
    config: cfg,
    players: [{ name: ' anna ', total: 5, roundScores: [5] }, { name: 'BEA', total: 5, roundScores: [5] }],
    roundHistory: [{ round: 1, finisher: 1, raw: [5, 5], scores: [5, 5], doubled: false }],
  };
  let s = emptyStats();
  const s1 = summarizeGame(g1, { id: 'a', mode: 'local', date: 1 });
  eq(s1.winners, [1], 'vincitore partita 1 = Bea');
  s = addGame(s, s1);
  assert(addGame(s, s1) === s, 'addGame idempotente');
  s = addGame(s, summarizeGame(g2, { id: 'b', mode: 'remote', date: 2 }));
  const [first, second] = computePlayerStats(s);
  assert(first.name === 'Bea' && second.name === 'Anna', 'classifica per media crescente');
  eq([second.gamesPlayed, second.gamesWon, second.roundsPlayed, second.totalPoints, second.avgPerRound], [2, 1, 3, 45, 15], 'Anna (nomi unificati)');
  eq([second.roundsWon, second.roundsClosed, second.penalties, second.bestRound, second.worstRound], [2, 2, 1, 5, 30], 'Anna dettagli');
  assert(first.gamesWon === 2 && Math.abs(first.avgPerRound - 40 / 3) < 1e-9, 'Bea media 13.33');
  // export / import
  const { stats: merged, added } = importStats(emptyStats(), exportStats(s));
  assert(added === 2 && merged.games.length === 2, 'import in stats vuote');
  assert(importStats(s, exportStats(s)).added === 0, 'import non duplica');
  let threw = false; try { importStats(s, '{"x":1}'); } catch { threw = true; }
  assert(threw, 'import rifiuta formati sconosciuti');
  console.log('OK: statistiche (conteggi, medie, pareggi, nomi unificati, import/export)');
}

// =====================================================================
// 2) Pass & Play: partita intera, statistiche registrate una volta, persistenza
// =====================================================================
{
  const storage = memoryStorage();
  const store = createStore({ storage });
  assert(store.startLocal({ playerNames: ['Anna', 'Bea'], rows: 4, cols: 5, initialReveal: 3, targetScore: 300 }).ok, 'startLocal');

  // a metà partita: un nuovo store sullo stesso storage deve poter riprendere identico
  let steps = 0;
  while (store.getState().game.round < 2 || store.getState().game.phase !== 'playing') { botMove(store); assert(++steps < 60000, 'round 2 raggiunto'); }
  for (let i = 0; i < 7; i++) botMove(store);
  const store2 = createStore({ storage });
  assert(store2.getState().saved && store2.getState().saved.mode === 'local', 'partita salvata visibile in home');
  assert(store2.resumeLocal().ok, 'resumeLocal');
  eq(store2.getState().game, store.getState().game, 'stato ripreso identico');

  steps = 0;
  while (store.getState().game.phase !== 'gameOver') { botMove(store); assert(++steps < 20000, 'la partita finisce'); }
  const st = store.getState();
  assert(st.stats.games.length === 1, 'statistiche registrate una sola volta');
  const rec = st.stats.games[0];
  const min = Math.min(...st.game.players.map((p) => p.total));
  eq(rec.winners, st.game.players.flatMap((p, i) => (p.total === min ? [i] : [])), 'vincitori coerenti');
  assert(rec.rounds.length === st.game.round, 'tutti i round nello storico');
  assert(st.saved === null, 'partita salvata rimossa a fine partita');
  assert(createStore({ storage }).getState().stats.games.length === 1, 'statistiche persistono dopo il riavvio');
  assert(createStore({ storage }).leaderboard().length === 2, 'classifica a 2 giocatori');
  console.log('OK: Pass & Play (partita 4x5, ripresa da localStorage, statistiche persistenti)');
}

// =====================================================================
// 3) Chiusura volontaria con targetScore = null
// =====================================================================
{
  const store = createStore({ storage: memoryStorage() });
  store.startLocal({ targetScore: null });
  assert(!store.finishGame().ok, 'END_GAME rifiutato fuori da fine round');
  let steps = 0;
  while (store.getState().game.phase !== 'roundOver') { botMove(store); assert(++steps < 5000, 'round finisce'); }
  assert(selectView(store.getState()).canFinishGame, 'canFinishGame a fine round');
  assert(store.finishGame().ok, 'finishGame');
  assert(store.getState().game.phase === 'gameOver' && store.getState().stats.games.length === 1, 'registrata partita da 1 round');
  console.log('OK: chiusura volontaria della partita');
}

// =====================================================================
// 4) Remoto: host + guest su trasporto simulato
// =====================================================================
{
  const hostStorage = memoryStorage();
  const H = createStore({ storage: hostStorage });
  const G = createStore({ storage: memoryStorage() });
  let [tA, tB] = loopbackPair();

  assert(H.hostRemote({ config: { rows: 3, cols: 4, initialReveal: 2, targetScore: 150 }, hostName: 'Anna', roomCode: 'ABCD' }, tA).ok, 'hostRemote');
  assert(!H.dispatch({ type: 'START_ROUND' }).ok, 'host non parte prima che il guest sia connesso');
  G.joinRemote('Bea', tB);
  await flush();
  assert(H.getState().connection === 'connected' && G.getState().connection === 'connected', 'connessi');
  assert(G.getState().seat === 1, 'guest ha il posto 1');
  eq(G.getState().game.players.map((p) => p.name), ['Anna', 'Bea'], 'nome del guest scelto nella lobby');
  assert(selectView(H.getState()).canStartRound, 'host può iniziare');

  const checkPrivacy = () => {
    const g = G.getState().game;
    assert(!Array.isArray(g.drawPile) && typeof g.drawPile.count === 'number', 'guest non riceve il mazzo');
    for (const p of g.players) for (const c of p.grid) if (c && !c.up) assert(c.v === null, 'guest non vede carte coperte');
  };

  // spoofing: il guest prova a muovere al posto dell'host
  H.dispatch({ type: 'START_ROUND' });
  await flush();
  while (H.getState().game.phase === 'initialReveal') { botMove(H); botMove(G); await flush(); }
  const hostTurnState = H.getState().game;
  const hostToMove = hostTurnState.current === 0;
  if (hostToMove) {
    tB.send({ t: 'action', action: { type: 'DRAW_DECK', player: 0 } });
    await flush();
    eq(H.getState().game, hostTurnState, 'azione spoofata ignorata');
    assert(G.getState().error === "It's not your turn", 'guest riceve errore');
  } else {
    G.dispatch({ type: 'DRAW_DECK' }); // al guest tocca: ok, ma poi prova a pescare di nuovo fuori turno
    await flush();
    G.dispatch({ type: 'DRAW_DECK' });
    await flush();
    assert(G.getState().error, 'doppia pesca rifiutata');
  }

  // metà partita: poi il guest cade e l'host riprende da localStorage con un nuovo trasporto
  let guard = 0;
  while (H.getState().game.round < 2 || H.getState().game.phase !== 'playing') { botMove(H); botMove(G); await flush(); checkPrivacy(); if (++guard >= 60000) { const g = H.getState().game; console.error(JSON.stringify({ph: g.phase, r: g.round, cur: g.current, step: g.turn, conn: H.getState().connection, gc: G.getState().connection, gp: G.getState().game.phase, err: G.getState().error})); assert(false, 'round 2'); } }
  for (let i = 0; i < 9; i++) { botMove(H); botMove(G); await flush(); }
  tA.close();
  await flush();
  assert(H.getState().connection === 'lost' && G.getState().connection === 'lost', 'connessione persa rilevata');
  assert(!G.dispatch({ type: 'DRAW_DECK' }).ok, 'guest offline non può muovere');

  const H2 = createStore({ storage: hostStorage });
  assert(H2.getState().saved?.mode === 'host', 'host vede la partita salvata');
  [tA, tB] = loopbackPair();
  assert(H2.resumeHost(tA).ok, 'resumeHost');
  G.joinRemote('Bea', tB);
  await flush();
  eq(G.getState().game.round, H2.getState().game.round, 'stessa partita dopo la riconnessione');
  eq(G.getState().game.players.map((p) => p.grid.map((c) => (c ? c.up : null))), H2.getState().game.players.map((p) => p.grid.map((c) => (c ? c.up : null))), 'griglie allineate');

  guard = 0;
  while (H2.getState().game.phase !== 'gameOver') { botMove(H2); botMove(G); await flush(); checkPrivacy(); assert(++guard < 20000, 'partita remota finisce'); }
  await flush();
  const hs = H2.getState(), gs = G.getState();
  assert(gs.game.phase === 'gameOver', 'anche il guest vede la fine');
  assert(hs.stats.games.length === 1 && gs.stats.games.length === 1, 'entrambi registrano la partita');
  eq(hs.stats.games[0].players.map((p) => p.total), gs.stats.games[0].players.map((p) => p.total), 'stessi totali sui due dispositivi');
  eq(hs.stats.games[0].id, gs.stats.games[0].id, 'stesso id partita');
  assert(hs.stats.games[0].mode === 'remote', 'modalità remote nello storico');
  console.log('OK: remoto host/guest (privacy, anti-spoofing, caduta e ripresa, stats su entrambi)');
}

console.log('TUTTI I TEST DELLO STORE PASSATI');
