// transport-peerjs.js
// Online adapter: turns a PeerJS (WebRTC) data connection into the transport object the store expects:
//   { send(msg), onMessage(fn), onStatus(fn('open'|'closed')), isOpen(), close() }
//
// - The host registers the id "skyjo-<CODE>" on the PeerJS broker; the guest connects to it.
//   After the handshake the two phones talk directly (the broker only introduces them).
// - PeerJS is loaded from a CDN only when the player opens the Online mode, so
//   Pass & Play keeps working with no connection at all.
// - The host transport survives guest drops: a new connection simply replaces the old one.
// - `Peer` and timers are injectable, so everything is testable in Node with a fake PeerJS.

export const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'skyjo-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export const CODE_LENGTH = 5;
export const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
export const isValidCode = (s) => normalizeCode(s).length === CODE_LENGTH;
export function newRoomCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return c;
}

// ---------- loading PeerJS on demand ----------
let loading = null;
export function loadPeerJs(win = globalThis) {
  if (win.Peer) return Promise.resolve(win.Peer);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const doc = win.document;
    if (!doc) { reject(new Error('Online mode is not available here')); return; }
    const s = doc.createElement('script');
    s.src = PEERJS_URL;
    s.async = true;
    s.onload = () => (win.Peer ? resolve(win.Peer) : reject(new Error('Could not load the online module')));
    s.onerror = () => reject(new Error('Could not load the online module. Are you offline?'));
    doc.head.appendChild(s);
  }).catch((e) => { loading = null; throw e; });
  return loading;
}

// ---------- transport wrapper around "the current connection" ----------
function makeTransport(onClose) {
  let conn = null;
  let msgFn = () => {};
  let statusFn = () => {};
  let closed = false;

  const t = {
    send(msg) { if (conn && conn.open) conn.send(msg); },
    onMessage(fn) { msgFn = fn; },
    onStatus(fn) { statusFn = fn; },
    isOpen: () => !closed && !!conn && !!conn.open,
    close() {
      if (closed) return;
      closed = true;
      const c = conn;
      conn = null;
      try { c?.close(); } catch { /* already closed */ }
      onClose?.();
    },
    // internal: adopt a data connection (newest wins)
    attach(c) {
      if (closed) { try { c.close(); } catch { /* ignore */ } return; }
      const old = conn;
      conn = c;
      if (old && old !== c) { try { old.close(); } catch { /* ignore */ } }
      const lost = () => { if (conn === c && !closed) statusFn('closed'); };
      c.on('open', () => { if (conn === c && !closed) statusFn('open'); });
      c.on('data', (d) => { if (conn === c && !closed) msgFn(d); });
      c.on('close', lost);
      c.on('error', lost);
      if (c.open) statusFn('open');
    },
    // internal: report a failure that has no connection (e.g. peer-unavailable)
    fail() { if (!closed) statusFn('closed'); },
  };
  return t;
}

const sleep = (ms, st) => new Promise((r) => st(r, ms));

// ---------- host ----------
// Resolves with a transport once the room id is registered on the broker.
export async function openHost(code, opts = {}) {
  const setT = opts.setTimeout ?? setTimeout;
  const retries = opts.retries ?? 4;
  const retryDelay = opts.retryDelay ?? 1500;
  const Peer = opts.Peer ?? (await (opts.loadPeer ?? loadPeerJs)());
  const id = PREFIX + normalizeCode(code);

  let peer = null;
  let transport = null;

  const create = () => new Promise((resolve, reject) => {
    const p = new Peer(id, opts.peerOptions);
    let opened = false;
    p.on('open', () => { opened = true; resolve(p); });
    p.on('error', (e) => {
      if (!opened) { try { p.destroy(); } catch { /* ignore */ } reject(e); }
      // after opening, network errors are handled by 'disconnected' below
    });
  });

  for (let attempt = 0; ; attempt++) {
    try { peer = await create(); break; } catch (e) {
      const taken = e && e.type === 'unavailable-id';
      // The broker may still hold the id of our previous session for a few seconds.
      if (taken && attempt < retries) { await sleep(retryDelay, setT); continue; }
      throw new Error(taken ? 'That room code is still in use. Try again in a moment.'
        : 'Could not reach the online service. Check your connection.');
    }
  }

  transport = makeTransport(() => { try { peer.destroy(); } catch { /* ignore */ } });
  peer.on('connection', (c) => transport.attach(c));
  // Phone slept / network switched: ask the broker to take us back with the same id.
  let backoff = 0;
  const revive = () => {
    if (peer.destroyed) return;
    try { peer.reconnect(); } catch { /* ignore */ }
    backoff = Math.min(backoff + 1, 6);
    setT(() => { if (!peer.destroyed && peer.disconnected) revive(); }, 1000 * backoff);
  };
  peer.on('disconnected', revive);
  peer.on('open', () => { backoff = 0; });
  peer.on('error', () => { /* non-fatal here */ });
  transport.revive = () => { if (!peer.destroyed && peer.disconnected) revive(); };
  return transport;
}

// ---------- guest ----------
// Returns a transport immediately; its status goes 'open' when connected, or 'closed' on failure.
export function openGuest(code, opts = {}) {
  const setT = opts.setTimeout ?? setTimeout;
  const clearT = opts.clearTimeout ?? clearTimeout;
  const timeout = opts.timeout ?? 15000;
  let peer = null;
  let timer = null;
  const transport = makeTransport(() => { clearT(timer); try { peer?.destroy(); } catch { /* ignore */ } });

  (async () => {
    let Peer;
    try { Peer = opts.Peer ?? (await (opts.loadPeer ?? loadPeerJs)()); } catch { transport.fail(); return; }
    peer = new Peer(undefined, opts.peerOptions);
    timer = setT(() => { if (!transport.isOpen()) transport.fail(); }, timeout);
    peer.on('open', () => {
      const c = peer.connect(PREFIX + normalizeCode(code), { reliable: true, serialization: 'json' });
      transport.attach(c);
    });
    peer.on('error', () => { if (!transport.isOpen()) transport.fail(); });
  })();

  return transport;
}

// What createApp expects.
export function createOnline(opts = {}) {
  return {
    newCode: () => newRoomCode(),
    normalize: normalizeCode,
    isValid: isValidCode,
    host: (code) => openHost(code, opts),
    join: (code) => openGuest(code, opts),
  };
}
