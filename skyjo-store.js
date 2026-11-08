// skyjo-store.js
// Store minimale (stato + dispatch + subscribe), senza librerie.
//
// Tre modalità, UNA sola fonte di verità per le regole (l'engine):
//   'local' : Pass & Play. Lo store esegue l'engine e salva in localStorage ad ogni mossa.
//   'host'  : uno dei due telefoni. Esegue l'engine, salva, e manda lo stato (con le
//             carte coperte oscurate) all'altro. Ha il posto 0.
//   'guest' : l'altro telefono. NON esegue l'engine: manda le azioni all'host e mostra
//             lo stato che riceve. Ha il posto 1. Non salva la partita (la fonte è l'host).
//
// Trasporto (PeerJS/WebRTC verrà dopo) = qualunque oggetto con questa forma:
//   { send(msg), onMessage(fn), onStatus(fn('open'|'closed')), isOpen(), close() }
// Lo store non sa nulla di PeerJS: per i test basta un trasporto in memoria.
//
// Protocollo:
//   guest -> host : {t:'hello', name} | {t:'action', action}
//   host -> guest : {t:'welcome', seat, gameId} | {t:'state', gameId, state} | {t:'error', error}

import { createGame, applyAction, redactForPeer } from './skyjo-engine.js';
import { emptyStats, summarizeGame, addGame, computePlayerStats, exportStats, importStats } from './skyjo-stats.js';

const KEYS = { game: 'skyjo:game:v1', stats: 'skyjo:stats:v1' };

// ---------- storage ----------
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage; } catch { /* es. modalità privata */ }
  return memoryStorage();
}

const load = (st, k, fallback) => {
  try { const raw = st.getItem(k); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};
const save = (st, k, v) => {
  try { st.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
};

const defaultUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clean = (name, fallback) => String(name ?? '').trim().slice(0, 20) || fallback;

// Con griglie grandi (4x5) le partite sono più lunghe: obiettivo più alto.
export const suggestedTarget = (rows, cols) => (rows * cols > 12 ? 150 : 100);

// ---------- store ----------
export function createStore(opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  const now = opts.now ?? Date.now;
  const uid = opts.uid ?? defaultUid;
  const listeners = new Set();
  let transport = null;

  const loadedStats = load(storage, KEYS.stats, null);

  let state = {
    screen: 'home',      // home | setup | connecting | game | stats
    mode: null,          // 'local' | 'host' | 'guest'
    seat: null,          // 0 host, 1 guest, null in locale
    gameId: null,
    roomCode: null,      // opaco: lo usa l'adapter di rete
    myName: null,
    game: null,          // stato dell'engine (per il guest: versione oscurata)
    connection: 'none',  // none | waiting | connecting | connected | lost
    error: null,
    stats: loadedStats && loadedStats.version === 1 ? loadedStats : emptyStats(),
    saved: null,         // riassunto della partita salvata, per il pulsante "Riprendi"
  };
  state.saved = readSaved();

  const emit = () => listeners.forEach((fn) => fn(state));
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  function readSaved() {
    const rec = load(storage, KEYS.game, null);
    if (!rec || rec.v !== 1 || !rec.game) return null;
    return {
      mode: rec.mode,
      round: rec.game.round,
      phase: rec.game.phase,
      names: rec.game.players.map((p) => p.name),
      totals: rec.game.players.map((p) => p.total),
      savedAt: rec.savedAt,
    };
  }

  function persistGame() {
    if (state.mode === 'guest' || !state.game) return;
    save(storage, KEYS.game, {
      v: 1, mode: state.mode, seat: state.seat, gameId: state.gameId,
      roomCode: state.roomCode, game: state.game, savedAt: now(),
    });
  }

  function recordIfOver() {
    const { game, gameId } = state;
    if (!game || game.phase !== 'gameOver' || !gameId) return;
    if (state.stats.games.some((g) => g.id === gameId)) return;
    const summary = summarizeGame(game, { id: gameId, mode: state.mode === 'local' ? 'local' : 'remote', date: now() });
    const stats = addGame(state.stats, summary);
    save(storage, KEYS.stats, stats);
    state = { ...state, stats };
  }

  // Unico punto in cui cambia lo stato di gioco: salva, registra le statistiche, notifica.
  function commit(game) {
    state = { ...state, game, error: null };
    recordIfOver();
    if (game.phase === 'gameOver') storage.removeItem(KEYS.game);
    else persistGame();
    state = { ...state, saved: readSaved() };
    emit();
  }

  const fail = (error) => { set({ error }); return { ok: false, error }; };

  // ---------- rete ----------
  function closeTransport() {
    const t = transport;
    transport = null;
    try { t?.close?.(); } catch { /* già chiuso */ }
  }

  const broadcast = () => {
    if (state.mode !== 'host' || !transport) return;
    transport.send({ t: 'state', gameId: state.gameId, state: redactForPeer(state.game) });
  };

  function onHostMessage(msg) {
    if (msg.t === 'hello') {
      if (state.game.phase === 'lobby') { // prima del via il guest sceglie il proprio nome
        const g = structuredClone(state.game);
        const name = clean(msg.name, g.players[1].name);
        g.players[1].name = name;
        g.config.playerNames[1] = name;
        state = { ...state, connection: 'connected' };
        commit(g);
      } else {
        set({ connection: 'connected' }); // riconnessione a partita in corso
      }
      transport.send({ t: 'welcome', seat: 1, gameId: state.gameId });
      broadcast();
    } else if (msg.t === 'action' && msg.action) {
      // il posto viene imposto dall'host: il guest non può muovere "per conto" dell'host
      const r = applyAction(state.game, { ...msg.action, player: 1 });
      if (!r.ok) { transport.send({ t: 'error', error: r.error }); return; }
      commit(r.state);
      broadcast();
    }
  }

  function onGuestMessage(msg) {
    if (msg.t === 'welcome') {
      set({ seat: msg.seat, gameId: msg.gameId, connection: 'connected' });
    } else if (msg.t === 'state') {
      state = { ...state, gameId: msg.gameId, screen: 'game' };
      commit(msg.state);
    } else if (msg.t === 'error') {
      set({ error: msg.error });
    }
  }

  function attachTransport(t) {
    closeTransport();
    transport = t;
    t.onMessage((msg) => (state.mode === 'host' ? onHostMessage(msg) : onGuestMessage(msg)));
    t.onStatus((s) => {
      if (transport !== t) return; // trasporto vecchio, ignorato
      if (s === 'open' && state.mode === 'guest') t.send({ t: 'hello', name: state.myName });
      if (s === 'closed' && state.connection === 'connected') set({ connection: 'lost' });
    });
    if (state.mode === 'guest' && t.isOpen()) t.send({ t: 'hello', name: state.myName });
  }

  // ---------- azioni pubbliche ----------
  function startLocal(config = {}) {
    try {
      const game = createGame(config);
      closeTransport();
      state = { ...state, mode: 'local', seat: null, gameId: uid(), roomCode: null, connection: 'none', screen: 'game' };
      commit(game);
      return { ok: true };
    } catch (e) { return fail(e.message); }
  }

  function hostRemote({ config = {}, hostName, roomCode = null } = {}, t) {
    try {
      const game = createGame({ ...config, playerNames: [clean(hostName, 'Giocatore 1'), 'Giocatore 2'] });
      state = { ...state, mode: 'host', seat: 0, gameId: uid(), roomCode, connection: 'waiting', screen: 'game' };
      commit(game);
      attachTransport(t);
      return { ok: true };
    } catch (e) { return fail(e.message); }
  }

  // Funziona anche per riconnettersi: lo stato precedente resta finché l'host ne manda uno nuovo.
  function joinRemote(name, t) {
    state = {
      ...state, mode: 'guest', seat: null, myName: clean(name, 'Giocatore 2'),
      connection: 'connecting', screen: state.game ? 'game' : 'connecting', error: null,
    };
    emit();
    attachTransport(t);
  }

  function resumeLocal() {
    const rec = load(storage, KEYS.game, null);
    if (!rec || rec.v !== 1 || rec.mode !== 'local') return fail('Nessuna partita locale da riprendere');
    closeTransport();
    state = { ...state, mode: 'local', seat: null, gameId: rec.gameId, roomCode: null, connection: 'none', screen: 'game' };
    commit(rec.game);
    return { ok: true };
  }

  function resumeHost(t) {
    const rec = load(storage, KEYS.game, null);
    if (!rec || rec.v !== 1 || rec.mode !== 'host') return fail('Nessuna partita online da riprendere');
    state = { ...state, mode: 'host', seat: 0, gameId: rec.gameId, roomCode: rec.roomCode, connection: 'waiting', screen: 'game' };
    commit(rec.game);
    attachTransport(t); // quando l'altro rientra ('hello') riceve lo stato aggiornato
    return { ok: true };
  }

  function discardSaved() {
    storage.removeItem(KEYS.game);
    set({ saved: null });
  }

  function dispatch(action) {
    const { mode, game } = state;
    if (!game) return fail('Nessuna partita in corso');
    if (mode === 'guest') {
      if (state.connection !== 'connected' || !transport) return fail('Non sei connesso');
      transport.send({ t: 'action', action: { ...action, player: state.seat } });
      return { ok: true, pending: true }; // l'esito arriva con il nuovo stato (o con un errore)
    }
    if (mode === 'host' && action.type === 'START_ROUND' && state.connection !== 'connected')
      return fail("In attesa dell'altro giocatore");
    const r = applyAction(game, mode === 'host' ? { ...action, player: 0 } : action);
    if (!r.ok) return fail(r.error);
    commit(r.state);
    broadcast();
    return r;
  }

  const finishGame = () => dispatch({ type: 'END_GAME' });

  function leave() {
    closeTransport();
    storage.removeItem(KEYS.game);
    state = { ...state, screen: 'home', mode: null, seat: null, gameId: null, roomCode: null, game: null, connection: 'none', error: null, saved: null };
    emit();
  }

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setScreen: (screen) => set({ screen }),
    clearError: () => set({ error: null }),
    dispatch, startLocal, hostRemote, joinRemote, attachTransport,
    resumeLocal, resumeHost, discardSaved, finishGame, leave,
    leaderboard: () => computePlayerStats(state.stats),
    exportStats: () => exportStats(state.stats),
    importStats(json) {
      const { stats, added } = importStats(state.stats, json);
      save(storage, KEYS.stats, stats);
      set({ stats });
      return added;
    },
  };
}

// ---------- selettori per l'interfaccia ----------
const upCount = (p) => p.grid.filter((c) => c && c.up).length;

export function selectView(st) {
  const g = st.game;
  if (!g) return null;
  const remote = st.mode === 'host' || st.mode === 'guest';
  const cfg = g.config;
  const players = g.players.map((p, i) => ({
    index: i,
    name: p.name,
    total: p.total,
    grid: p.grid,
    shown: p.grid.reduce((t, c) => t + (c && c.up ? c.v : 0), 0),
    needReveal: g.phase === 'initialReveal' ? Math.max(0, cfg.initialReveal - upCount(p)) : 0,
    isCurrent: i === g.current,
    isMe: remote ? i === st.seat : i === g.current,
  }));
  const myTurn = g.phase === 'playing' && (!remote || g.current === st.seat);
  const ready = !remote || st.connection === 'connected';

  let hint = '';
  if (g.phase === 'lobby') hint = ready ? 'Pronti? Inizia il round' : "In attesa dell'altro giocatore…";
  else if (g.phase === 'initialReveal') {
    const todo = players.filter((p) => p.needReveal > 0 && (!remote || p.isMe));
    hint = todo.length
      ? todo.map((p) => `${p.name}: scopri ${p.needReveal} ${p.needReveal === 1 ? 'carta' : 'carte'}`).join(' · ')
      : "In attesa dell'altro giocatore…";
  } else if (g.phase === 'playing') {
    if (!myTurn) hint = `Tocca a ${g.players[g.current].name}`;
    else if (g.turn.step === 'draw') hint = 'Pesca dal mazzo o prendi la carta degli scarti';
    else if (g.turn.step === 'place')
      hint = g.turn.from === 'deck' ? 'Scambiala con una carta della griglia oppure scartala' : 'Scambiala con una carta della griglia';
    else if (g.turn.step === 'flip') hint = 'Scopri una carta coperta';
  } else if (g.phase === 'roundOver') hint = 'Round finito';
  else if (g.phase === 'gameOver') hint = 'Partita finita';

  return {
    phase: g.phase,
    round: g.round,
    players,
    current: g.current,
    myTurn,
    step: g.turn.step,
    held: g.turn.drawn,
    heldFrom: g.turn.from,
    drawCount: Array.isArray(g.drawPile) ? g.drawPile.length : g.drawPile.count,
    discardTop: g.discardPile.length ? g.discardPile[g.discardPile.length - 1] : null,
    canStartRound: (g.phase === 'lobby' || g.phase === 'roundOver') && ready,
    canFinishGame: g.phase === 'roundOver',
    lastRound: g.roundHistory.length ? g.roundHistory[g.roundHistory.length - 1] : null,
    targetScore: cfg.targetScore,
    hint,
  };
}
