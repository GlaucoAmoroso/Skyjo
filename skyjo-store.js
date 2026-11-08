// skyjo-store.js
// Minimal store (state + dispatch + subscribe), no libraries.
//
// Three modes, ONE source of truth for the rules (the engine):
//   'local' : Pass & Play. The store runs the engine and saves to localStorage on every move.
//   'host'  : one of the two phones. Runs the engine, saves, and sends the state (with
//             face-down cards hidden) to the other. Seat 0.
//   'guest' : the other phone. Does NOT run the engine: sends actions to the host and shows
//             the state it receives. Seat 1. Does not save the game (the host is the source).
//
// Transport (PeerJS/WebRTC) = any object shaped like:
//   { send(msg), onMessage(fn), onStatus(fn('open'|'closed')), isOpen(), close() }
// The store knows nothing about PeerJS: tests use an in-memory transport.
//
// Protocollo:
//   guest -> host : {t:'hello', name} | {t:'action', action}
//   guest -> host : {t:'rematch'} | {t:'undo'} | {t:'emoji', e}   (host -> guest also sends {t:'emoji', e})
//   host -> guest : {t:'welcome', seat, gameId} | {t:'state', gameId, state} | {t:'error', error}

import { createGame, applyAction, redactForPeer } from './skyjo-engine.js';
import { emptyStats, resetPlayer, summarizeGame, addGame, computePlayerStats, exportStats, importStats } from './skyjo-stats.js';

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
export const EMOJIS = ['👍', '😂', '😮', '😭', '😡', '👏', '🔥', '🤔'];

export function createStore(opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  const now = opts.now ?? Date.now;
  const uid = opts.uid ?? defaultUid;
  const listeners = new Set();
  let transport = null;
  let undoSnap = null; // { game, player }: the state before the last move (one step back)
  const UNDOABLE = new Set(['REVEAL', 'DRAW_DECK', 'TAKE_DISCARD', 'SWAP', 'DISCARD_DRAWN', 'FLIP']);

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
    undoBy: null,        // host/local: player who can take back the last move (null = nothing to undo)
    reaction: null,      // last quick emoji: { id, from: 'me' | 'them', e }
    undoSeq: 0,          // bumps whenever a move is taken back (the UI skips animations then)
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
      roomCode: rec.roomCode ?? null,
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
  function commit(game, undo = null) {
    undoSnap = undo;
    state = { ...state, game, error: null, undoBy: undo ? undo.player : null };
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
    transport.send({ t: 'state', gameId: state.gameId, state: redactForPeer(state.game), undoBy: state.undoBy, undoSeq: state.undoSeq });
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
    } else if (msg.t === 'rematch') {
      if (state.game.phase === 'gameOver') rematch();
    } else if (msg.t === 'action' && msg.action) {
      // il posto viene imposto dall'host: il guest non può muovere "per conto" dell'host
      const before = state.game;
      const r = applyAction(before, { ...msg.action, player: 1 });
      if (!r.ok) { transport.send({ t: 'error', error: r.error }); return; }
      commit(r.state, snapFor(before, msg.action, r.state));
      broadcast();
    } else if (msg.t === 'emoji') {
      gotEmoji(msg.e);
    } else if (msg.t === 'undo') {
      if (undoSnap && undoSnap.player === 1) undoMove();
      else transport.send({ t: 'error', error: 'Nothing to undo' });
    }
  }

  // Quick reactions: a fixed whitelist, so nothing but these characters can ever arrive from the other phone.
  let reactSeq = 0;
  let lastReactAt = 0;
  function gotEmoji(e) {
    if (EMOJIS.includes(e)) set({ reaction: { id: ++reactSeq, from: 'them', e } });
  }
  function react(e) {
    if (!EMOJIS.includes(e) || state.mode === 'local' || state.connection !== 'connected' || !transport) return { ok: false };
    const t = now();
    if (t - lastReactAt < 1000) return { ok: false }; // no spamming
    lastReactAt = t;
    transport.send({ t: 'emoji', e });
    set({ reaction: { id: ++reactSeq, from: 'me', e } });
    return { ok: true };
  }

  function onGuestMessage(msg) {
    if (msg.t === 'welcome') {
      set({ seat: msg.seat, gameId: msg.gameId, connection: 'connected' });
    } else if (msg.t === 'state') {
      state = { ...state, gameId: msg.gameId, screen: 'game', undoSeq: msg.undoSeq ?? state.undoSeq };
      commit(msg.state, msg.undoBy === 0 || msg.undoBy === 1 ? { game: null, player: msg.undoBy } : null);
    } else if (msg.t === 'emoji') {
      gotEmoji(msg.e);
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
      if (s === 'closed' && (state.connection === 'connected' || state.connection === 'connecting')) set({ connection: 'lost' });
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
      const game = createGame({ ...config, playerNames: [clean(hostName, 'Player 1'), 'Player 2'] });
      state = { ...state, mode: 'host', seat: 0, gameId: uid(), roomCode, connection: 'waiting', screen: 'game' };
      commit(game);
      attachTransport(t);
      return { ok: true };
    } catch (e) { return fail(e.message); }
  }

  // Funziona anche per riconnettersi: lo stato precedente resta finché l'host ne manda uno nuovo.
  function joinRemote(name, t) {
    state = {
      ...state, mode: 'guest', seat: null, myName: clean(name, 'Player 2'),
      connection: 'connecting', screen: state.game ? 'game' : 'connecting', error: null,
    };
    emit();
    attachTransport(t);
  }

  function resumeLocal() {
    const rec = load(storage, KEYS.game, null);
    if (!rec || rec.v !== 1 || rec.mode !== 'local') return fail('No local game to resume');
    closeTransport();
    state = { ...state, mode: 'local', seat: null, gameId: rec.gameId, roomCode: null, connection: 'none', screen: 'game' };
    commit(rec.game);
    return { ok: true };
  }

  function resumeHost(t) {
    const rec = load(storage, KEYS.game, null);
    if (!rec || rec.v !== 1 || rec.mode !== 'host') return fail('No online game to resume');
    state = { ...state, mode: 'host', seat: 0, gameId: rec.gameId, roomCode: rec.roomCode, connection: 'waiting', screen: 'game' };
    commit(rec.game);
    attachTransport(t); // quando l'altro rientra ('hello') riceve lo stato aggiornato
    return { ok: true };
  }

  // New game with the same rules and players, dealt immediately (host only; the guest asks the host).
  function rematch() {
    if (state.mode === 'guest') {
      if (state.connection !== 'connected' || !transport) return fail('You are not connected');
      transport.send({ t: 'rematch' });
      return { ok: true, pending: true };
    }
    const cfg = state.game.config;
    try {
      const game = createGame({ ...cfg });
      state = { ...state, gameId: uid() };
      commit(game);
      const started = applyAction(game, { type: 'START_ROUND' }); // a rematch deals straight away
      if (started.ok) commit(started.state);
      broadcast();
      return { ok: true };
    } catch (e) { return fail(e.message); }
  }

  function discardSaved() {
    storage.removeItem(KEYS.game);
    set({ saved: null });
  }

  function dispatch(action) {
    const { mode, game } = state;
    if (!game) return fail('No game in progress');
    if (mode === 'guest') {
      if (state.connection !== 'connected' || !transport) return fail('You are not connected');
      transport.send({ t: 'action', action: { ...action, player: state.seat } });
      return { ok: true, pending: true }; // l'esito arriva con il nuovo stato (o con un errore)
    }
    if (mode === 'host' && action.type === 'START_ROUND' && state.connection !== 'connected')
      return fail("Waiting for the other player");
    const r = applyAction(game, mode === 'host' ? { ...action, player: 0 } : action);
    if (!r.ok) return fail(r.error);
    commit(r.state, snapFor(game, action, r.state));
    broadcast();
    return r;
  }

  // One step back is only kept for ordinary moves, never across a round / game boundary.
  function snapFor(before, action, after) {
    if (!UNDOABLE.has(action.type) || after.phase === 'gameOver') return null;
    return { game: before, player: after.lastMove?.player ?? null };
  }

  function undoMove() {
    if (!undoSnap) return fail('Nothing to undo');
    const snap = undoSnap;
    state = { ...state, undoSeq: state.undoSeq + 1 };
    commit(snap.game, null);
    broadcast();
    return { ok: true };
  }

  // Take back the last move (one step). The guest asks the host.
  function undo() {
    if (state.mode === 'guest') {
      if (state.connection !== 'connected' || !transport) return fail('You are not connected');
      transport.send({ t: 'undo' });
      return { ok: true, pending: true };
    }
    if (!state.game || state.game.phase === 'gameOver') return fail('Nothing to undo');
    if (state.mode === 'host' && undoSnap?.player !== 0) return fail('Nothing to undo');
    return undoMove();
  }

  const finishGame = () => dispatch({ type: 'END_GAME' });

  // Leave to the home screen but KEEP the saved game (host or local), so it can be resumed.
  function pause() {
    closeTransport();
    undoSnap = null;
    state = { ...state, screen: 'home', mode: null, seat: null, gameId: null, roomCode: null, game: null, connection: 'none', error: null, undoBy: null };
    state = { ...state, saved: readSaved() };
    emit();
  }

  function leave() {
    closeTransport();
    undoSnap = null;
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
    resumeLocal, resumeHost, rematch, pause, undo, react, discardSaved, finishGame, leave,
    leaderboard: () => computePlayerStats(state.stats),
    resetPlayerStats(name) {
      const stats = resetPlayer(state.stats, name, now());
      save(storage, KEYS.stats, stats);
      set({ stats });
    },
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
  const ready = !remote || st.connection === 'connected';
  const myTurn = g.phase === 'playing' && ready && (!remote || g.current === st.seat);
  const canUndo = g.phase !== 'gameOver' && ready
    && st.undoBy !== null && st.undoBy !== undefined && (st.mode === 'local' || st.undoBy === st.seat);

  let hint = '';
  if (g.phase === 'lobby') hint = ready ? 'Ready? Start the round' : "Waiting for the other player…";
  else if (g.phase === 'initialReveal') {
    const todo = players.filter((p) => p.needReveal > 0 && (!remote || p.isMe));
    const carte = (n) => `${n} ${n === 1 ? 'card' : 'cards'}`;
    if (!todo.length) hint = "Waiting for the other player…";
    else if (remote) hint = `Reveal ${carte(todo[0].needReveal)}`;
    else if (todo.length === players.length && todo.every((p) => p.needReveal === todo[0].needReveal)) hint = `Each reveals ${carte(todo[0].needReveal)}`;
    else hint = todo.map((p) => `${p.name}: reveal ${p.needReveal}`).join(' · ');
  } else if (g.phase === 'playing') {
    if (!myTurn) hint = `${g.players[g.current].name}'s turn`;
    else if (g.turn.step === 'draw') hint = 'Draw from the deck or take the discard';
    else if (g.turn.step === 'place')
      hint = g.turn.from === 'deck' ? 'Swap it with a card, or discard it' : 'Swap it with a card';
    else if (g.turn.step === 'flip') hint = 'Flip a face-down card';
  } else if (g.phase === 'roundOver') hint = 'Round over';
  else if (g.phase === 'gameOver') hint = 'Game over';

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
    canUndo,
    canStartRound: (g.phase === 'lobby' || g.phase === 'roundOver') && ready,
    canFinishGame: g.phase === 'roundOver',
    lastRound: g.roundHistory.length ? g.roundHistory[g.roundHistory.length - 1] : null,
    targetScore: cfg.targetScore,
    hint,
  };
}
