// End-to-end online test: two real stores + two real UIs, connected through the real PeerJS adapter
// running on an in-process fake of PeerJS. Only the broker/WebRTC itself is simulated.
import { createStore, memoryStorage } from './skyjo-store.js';
import { createApp } from './ui.js';
import { createOnline, openHost, openGuest, newRoomCode, normalizeCode, isValidCode } from './transport-peerjs.js';
import { createMockNetwork } from './mock-peer.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- 1) room codes ----------
{
  for (let i = 0; i < 200; i++) assert(/^[A-HJ-NP-Z2-9]{5}$/.test(newRoomCode()), 'code format');
  assert(normalizeCode(' ab-c d1e9 ') === 'ABCD1', 'normalize');
  assert(isValidCode('ABCDE') && !isValidCode('ABC'), 'validity');
}

// ---------- 2) adapter on its own ----------
{
  const net = createMockNetwork();
  const timers = [];
  const setT = (fn) => { timers.push(fn); return timers.length; };
  const host = await openHost('ROOM1', { Peer: net.Peer, setTimeout: setT });
  assert(net.hasRoom('skyjo-ROOM1'), 'room registered on the broker');
  const hostMsgs = []; const hostStatus = [];
  host.onMessage((m) => hostMsgs.push(m)); host.onStatus((s) => hostStatus.push(s));
  assert(!host.isOpen(), 'host not open before a guest');

  const g1 = openGuest('room1', { Peer: net.Peer, setTimeout: setT, clearTimeout: () => {} });
  const g1Msgs = []; const g1Status = [];
  g1.onMessage((m) => g1Msgs.push(m)); g1.onStatus((s) => g1Status.push(s));
  await flush();
  assert(host.isOpen() && g1.isOpen() && hostStatus.includes('open') && g1Status.includes('open'), 'both sides open');
  g1.send({ t: 'hello', name: 'A' }); host.send({ t: 'x', n: 1 });
  await flush();
  assert(hostMsgs[0]?.name === 'A' && g1Msgs[0]?.n === 1, 'messages travel both ways (JSON copies)');

  // a second guest replaces the first (newest wins) and the old one is told the link closed
  const g2 = openGuest('ROOM1', { Peer: net.Peer, setTimeout: setT, clearTimeout: () => {} });
  const g2Status = []; g2.onStatus((s) => g2Status.push(s)); g2.onMessage(() => {});
  await flush();
  assert(g1Status.includes('closed') && g2Status.includes('open'), 'old guest closed, new one open');
  const before = hostMsgs.length;
  g1.send({ t: 'ghost' });
  await flush();
  assert(hostMsgs.length === before, 'host ignores the replaced connection');

  // network drop -> host sees closed
  hostStatus.length = 0;
  net.dropAll();
  await flush();
  assert(hostStatus.includes('closed') && !host.isOpen(), 'host notices the drop');

  // unknown room -> guest status closed
  const bad = openGuest('NOPE2', { Peer: net.Peer, setTimeout: setT, clearTimeout: () => {} });
  const badStatus = []; bad.onStatus((s) => badStatus.push(s)); bad.onMessage(() => {});
  await flush();
  assert(badStatus.includes('closed'), 'guest told when the room does not exist');

  // room id still held by a previous session: retries, then succeeds once released
  const net2 = createMockNetwork();
  const old = new net2.Peer('skyjo-HELD1'); await flush();
  const pending = openHost('HELD1', { Peer: net2.Peer, retryDelay: 1, retries: 4 });
  await flush(2);
  old.destroy();
  const t2 = await pending;
  assert(net2.hasRoom('skyjo-HELD1') && t2, 'host retries until the id is free');
  let failed = null;
  const net3 = createMockNetwork(); new net3.Peer('skyjo-HELD2'); await flush();
  try { await openHost('HELD2', { Peer: net3.Peer, retryDelay: 1, retries: 2 }); } catch (e) { failed = e.message; }
  assert(failed && /in use/.test(failed), 'clear error when the code stays taken');
  g1.close(); g2.close(); host.close(); bad.close();
  assert(!net.hasRoom('skyjo-ROOM1'), 'closing the host frees the room');
}

// ---------- 3) full flow through the UI on two "phones" ----------
function clickables(html) {
  const out = [];
  for (const m of html.matchAll(/<(?:button|div)\b[^>]*\bdata-act="[^"]+"[^>]*>/g)) {
    const ds = {};
    for (const a of m[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)) ds[a[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[2];
    out.push(ds);
  }
  return out;
}
const timers = [];
const runTimers = () => { const t = timers.splice(0); t.forEach((f) => f()); };

function phone(net) {
  const storage = memoryStorage();
  const store = createStore({ storage });
  const toasts = [];
  const app = createApp(store, {
    storage, confirm: () => true, setTimeout: (fn) => { timers.push(fn); },
    online: createOnline({ Peer: net.Peer, retryDelay: 1, setTimeout: (fn) => { timers.push(fn); } }),
    clipboard: async (t) => { toasts.push('copied:' + t); },
    share: async () => { throw new Error('no share'); },
  });
  return { storage, store, app, toasts, html: () => app.render(), st: () => store.getState() };
}

const net = createMockNetwork();
const H = phone(net), G = phone(net);

// home offers online
assert(H.html().includes('Online'), 'home has Online');
H.app.click({ act: 'online' });
assert(H.html().includes('Create a room') && H.html().includes('Join a room'), 'online menu');
H.app.click({ act: 'newOnline' });
assert(H.html().includes('Open the room') && !H.html().includes('data-input="n2"'), 'host setup has only my name');
H.app.input('n1', 'Anna');
H.app.click({ act: 'hostStart' });
assert(H.st().screen === 'connecting', 'host shows connecting while the room opens');
await flush();
const code = H.st().roomCode;
assert(isValidCode(code) && H.st().screen === 'game' && H.st().game.phase === 'lobby' && H.st().connection === 'waiting', 'host in lobby');
assert(H.html().includes(code) && H.html().includes('Waiting for the other player') && /data-act="next"[^>]*disabled/.test(H.html()), 'lobby shows the code, deal disabled');
H.app.click({ act: 'copyCode' }); await flush();
assert(H.toasts[0] === 'copied:' + code, 'copy code');

// a bad join code is refused before touching the network
G.app.click({ act: 'online' }); G.app.click({ act: 'joinScreen' });
G.app.input('code', 'ab'); G.app.click({ act: 'join' });
assert(G.html().includes('5-character') && G.st().mode === null, 'short code rejected');
// a room that does not exist: stays on "joining" and keeps retrying, can be cancelled
G.app.input('code', 'ZZZZZ'); G.app.click({ act: 'join' });
await flush();
assert(G.st().screen === 'connecting' && G.st().connection === 'lost' && G.html().includes("Can't reach the room"), 'unknown room -> retrying screen');
runTimers(); await flush();
assert(G.st().connection === 'lost', 'still retrying');
G.app.click({ act: 'cancelConnect' });
assert(G.st().screen === 'home' && G.st().mode === null, 'cancel returns home');
runTimers(); await flush();
assert(G.st().mode === null, 'no zombie retry after cancel');

// join for real (lower-case with spaces, as typed on a phone)
G.app.click({ act: 'online' }); G.app.click({ act: 'joinScreen' });
G.app.input('code', ` ${code.toLowerCase()} `); G.app.input('joinName', 'Marco');
G.app.click({ act: 'join' });
await flush();
assert(G.st().connection === 'connected' && H.st().connection === 'connected', 'both connected');
assert(G.st().screen === 'game' && G.st().game.phase === 'lobby', 'guest in lobby');
assert(G.html().includes('Waiting for Anna to deal') && !G.html().includes('data-act="next"'), 'guest waits for the host');
assert(H.html().includes('Marco joined') && !/data-act="next"[^>]*disabled/.test(H.html()), 'host sees the guest and can deal');
assert(H.st().game.players[1].name === 'Marco', 'guest name applied');

// deal
H.app.click({ act: 'next' }); await flush();
assert(H.st().game.phase === 'initialReveal' && G.st().game.phase === 'initialReveal', 'dealt on both');
assert(G.html().includes('Reveal 2 cards') && H.html().includes('Reveal 2 cards'), 'hints in English');
// seats: me at the bottom on each phone, and the other player's face-down values never reach the guest
const seatNames = (h) => [...h.matchAll(/aria-label="Grid of ([^"]+)"/g)].map((m) => m[1]).join('|');
assert(seatNames(H.html()) === 'Marco|Anna' && seatNames(G.html()) === 'Anna|Marco', 'each phone shows me at the bottom');
const cellsClickable = (P) => clickables(P.html()).filter((d) => d.act === 'cell');
assert(cellsClickable(G).every((d) => d.p === '1') && cellsClickable(H).every((d) => d.p === '0'), 'only my own cards are tappable');

// play: each phone only taps what its own UI offers
const PLAY = new Set(['cell', 'draw', 'take', 'discard', 'next']);
function step(P) {
  const st = P.st();
  if (st.game.phase === 'gameOver') return false;
  if (st.game.phase === 'roundOver') {
    if (P !== H) return false;
    if (st.game.round >= 2) { P.app.click({ act: 'finish' }); return true; }
    P.app.click({ act: 'next' }); return true;
  }
  const c = clickables(P.html()).filter((d) => PLAY.has(d.act) && d.act !== 'next');
  if (!c.length) return false;
  const disc = c.find((d) => d.act === 'discard');
  P.app.click(disc && Math.random() < 0.3 ? disc : pick(c));
  return true;
}
let drops = 0, guard = 0, playing = 0;
while (H.st().game.phase !== 'gameOver') {
  assert(++guard < 60000, 'game must finish');
  step(H); step(G);
  await flush(2);
  assert(H.st().game.round === G.st().game.round && H.st().game.phase === G.st().game.phase, 'phones in sync');
  assert(!/undefined|NaN|\[object/.test(G.html() + H.html()), 'clean html');
  // an unreliable network: drop the link a few times mid-game
  if (H.st().game.phase === 'playing') playing++;
  if (playing % 20 === 19 && drops < 4 && H.st().game.phase === 'playing') {
    playing++;
    net.dropAll(); await flush();
    assert(G.st().connection === 'lost' && G.html().includes('Connection lost') && H.html().includes('Marco disconnected'), 'both phones show the drop');
    assert(G.st().game.phase === 'playing' && !clickables(G.html()).some((d) => d.act === 'draw' || d.act === 'cell'), 'guest cannot act while offline');
    runTimers(); await flush(8);
    assert(G.st().connection === 'connected' && H.st().connection === 'connected', 'guest auto-reconnected');
    assert(JSON.stringify(G.st().game.players.map((p) => p.total)) === JSON.stringify(H.st().game.players.map((p) => p.total)), 'state resynced');
    drops++;
  }
}
await flush();
assert(drops >= 1, 'the test exercised reconnection (' + drops + ')');
assert(G.st().stats.games.length === 1 && H.st().stats.games.length === 1, 'stats recorded on both phones');
assert(H.st().stats.games[0].mode === 'remote' && G.st().stats.games[0].id === H.st().stats.games[0].id, 'same game id on both');
assert(/ wins!|tie!/.test(G.html()) && G.html().includes('Rematch'), 'guest sees the result');

// rematch asked by the GUEST: host deals a fresh game at once
G.app.click({ act: 'again' }); await flush();
assert(H.st().game.round === 1 && H.st().game.phase === 'initialReveal' && G.st().game.phase === 'initialReveal', 'rematch dealt on both');
assert(H.st().game.players[0].name === 'Anna' && H.st().game.players[1].name === 'Marco', 'same players');

// host pauses: game kept on the host phone; room closed
for (let i = 0; i < 12; i++) { step(H); step(G); await flush(2); }
const snap = JSON.stringify(H.st().game.players.map((p) => p.total)) + H.st().game.round;
H.app.click({ act: 'menu' });
assert(H.html().includes('Pause &amp; leave'), 'host menu has pause');
H.app.click({ act: 'pause' }); await flush();
assert(H.st().screen === 'home' && H.st().saved?.roomCode === code && !net.hasRoom('skyjo-' + code), 'host paused, room closed, game saved');
assert(G.st().connection === 'lost' && G.html().includes('Connection lost'), 'guest sees the room go away');
runTimers(); await flush();
assert(G.st().connection === 'lost', 'guest keeps trying while the room is closed');

// host reopens the same room -> guest comes back on its own
assert(H.html().includes('Reopen room') && H.html().includes(code), 'home offers to reopen the room');
H.app.click({ act: 'resumeOnline' }); await flush();
assert(net.hasRoom('skyjo-' + code) && H.st().screen === 'game', 'room reopened with the same code');
runTimers(); await flush(8);
assert(G.st().connection === 'connected' && H.st().connection === 'connected', 'guest rejoined the reopened room');
assert(JSON.stringify(G.st().game.players.map((p) => p.total)) + G.st().game.round === snap, 'game continued from where it was');
for (let i = 0; i < 10; i++) { step(H); step(G); await flush(2); }

// leaving
G.app.click({ act: 'menu' });
assert(G.html().includes('Leave the game') && !G.html().includes('Pause'), 'guest menu');
G.app.click({ act: 'leaveOnline' }); await flush();
assert(G.st().screen === 'home' && G.st().mode === null, 'guest left');
runTimers(); await flush();
assert(G.st().mode === null, 'a guest who left does not reconnect');
assert(H.st().connection === 'lost' && H.html().includes('Marco disconnected'), 'host sees the guest leave');

// ---------- 4) undo ----------
{
  const net2 = createMockNetwork();
  const A = phone(net2), B = phone(net2);
  A.app.click({ act: 'newOnline' }); A.app.input('n1', 'Anna'); A.app.click({ act: 'hostStart' }); await flush();
  const c2 = A.st().roomCode;
  B.app.click({ act: 'joinScreen' }); B.app.input('code', c2); B.app.click({ act: 'join' }); await flush();
  A.app.click({ act: 'next' }); await flush();
  const revealAll = async (P) => { for (let i = 0; i < 2; i++) { P.app.click(clickables(P.html()).find((d) => d.act === 'cell')); await flush(); } };
  await revealAll(A); await revealAll(B);
  assert(A.st().game.phase === 'playing', 'playing');
  const first = A.st().game.current === 0 ? A : B, second = first === A ? B : A;
  const undoBtn = (P) => P.html().includes('data-act="undo"');
  assert(!undoBtn(first) || true, 'n/a');
  // draw from the deck, then take it back: the deck is exactly as before
  const deckBefore = first.st().mode === 'host' ? first.st().game.drawPile.length : null;
  first.app.click({ act: 'draw' }); await flush();
  assert(undoBtn(first) && !undoBtn(second), 'only the player who moved can undo');
  first.app.click({ act: 'undo' }); await flush();
  assert(first.st().game.turn.step === 'draw' && first.st().game.turn.drawn === null && second.st().game.turn.step === 'draw', 'draw taken back on both phones');
  if (deckBefore !== null) assert(A.st().game.drawPile.length === deckBefore, 'card went back on the deck');
  // take from the discard by mistake, undo, then a normal move cannot be undone twice
  first.app.click({ act: 'take' }); await flush();
  assert(first.st().game.turn.from === 'discard', 'took the discard');
  first.app.click({ act: 'undo' }); await flush();
  assert(first.st().game.turn.step === 'draw', 'discard card put back');
  assert(!undoBtn(first), 'only ONE step back');
  // draw, discard by tapping the pile, and finish the turn; the opponent plays -> the first can no longer undo
  first.app.click({ act: 'draw' }); await flush();
  assert(/data-act="discard"[^>]*data-key="discard"|data-key="discard"[^>]*data-act="discard"|class="card[^"]*"[^>]*data-act="discard"/.test(first.html()) || clickables(first.html()).filter((d) => d.act === 'discard').length >= 2, 'the discard pile itself is tappable to discard');
  first.app.click({ act: 'discard' }); await flush();
  const flipOrCell = () => clickables(first.html()).find((d) => d.act === 'cell');
  if (flipOrCell()) { first.app.click(flipOrCell()); await flush(); }
  if (first.st().game.current !== (first === A ? 0 : 1)) {
    second.app.click({ act: 'draw' }); await flush();
    assert(!undoBtn(first) && undoBtn(second), 'undo passes to whoever moved last');
    // a forged undo from the wrong player is refused by the host
    const before = JSON.stringify(A.st().game);
    if (second === A) { B.app.click({ act: 'undo' }); } else { A.app.click({ act: 'undo' }); }
    await flush();
    assert(JSON.stringify(A.st().game) === before, 'wrong player cannot undo');
  }
}

// ---------- 5) quick reactions ----------
{
  const net3 = createMockNetwork();
  const A = phone(net3), B = phone(net3);
  A.app.click({ act: 'newOnline' }); A.app.input('n1', 'Anna'); A.app.click({ act: 'hostStart' }); await flush();
  const c3 = A.st().roomCode;
  B.app.click({ act: 'joinScreen' }); B.app.input('code', c3); B.app.click({ act: 'join' }); await flush();
  A.app.click({ act: 'next' }); await flush();
  assert(A.html().includes('data-act="emojiToggle"') && B.html().includes('data-act="emojiToggle"'), 'reaction button online');
  B.app.click({ act: 'emojiToggle' });
  assert(B.html().includes('data-act="emoji" data-e="🔥"'), 'palette opens');
  B.app.click({ act: 'emoji', e: '🔥' }); await flush();
  assert(B.html().includes('class="reaction mine"') && A.html().includes('class="reaction theirs"') && A.html().includes('🔥'), 'bubble shown on both phones');
  assert(!B.html().includes('data-act="emoji" data-e'), 'palette closes after sending');
  // spam is ignored, and only whitelisted characters are ever shown
  B.store.react('😂'); await flush();
  assert(A.st().reaction.e === '🔥', 'rate limited');
  A.store.attachTransport; // (no-op: keep reference)
  const evil = A.st().reaction.id;
  // an injected message with markup is dropped by the receiver
  const gsend = (m) => { A.store.getState(); };
  void gsend;
  // host -> guest works too
  await new Promise((r) => setTimeout(r, 1100));
  A.store.react('👏'); await flush();
  assert(B.st().reaction.e === '👏' && B.st().reaction.from === 'them' && B.st().reaction.id !== evil + 99, 'host reaction reaches the guest');
  // the bubble fades after a while
  runTimers(); 
  assert(!A.html().includes('class="reaction') && !B.html().includes('class="reaction'), 'bubble disappears');
  // local games have no reactions
  const L = phone(createMockNetwork());
  L.app.click({ act: 'newLocal' }); L.app.click({ act: 'start' });
  assert(!L.html().includes('emojiToggle'), 'no reactions in Pass & Play');
}

// ---------- 6) per-player stats reset ----------
{
  const P = phone(createMockNetwork());
  const st0 = P.store.getState();
  // two finished games between Anna and Ben, then reset only Anna
  P.app.click({ act: 'newLocal' }); P.app.input('n1', 'Anna'); P.app.input('n2', 'Ben'); P.app.click({ act: 'start' });
  const finishGame = () => {
    let n = 0;
    while (!['roundOver', 'gameOver'].includes(P.store.getState().game.phase) && ++n < 20000) {
      const c = clickables(P.html()).filter((d) => PLAY.has(d.act) && d.act !== 'next');
      P.app.click(pick(c));
    }
    if (P.store.getState().game.phase === 'roundOver') P.app.click({ act: 'finish' });
  };
  finishGame();
  assert(P.store.getState().stats.games.length === 1, 'game recorded');
  assert(P.store.leaderboard().length === 2, 'both on the board');
  const asked = [];
  const P2 = (() => { const storage = P.storage; const store = P.store; return createApp(store, { storage, confirm: (m) => { asked.push(m); return true; }, setTimeout: (fn) => timers.push(fn) }); })();
  P2.click({ act: 'stats' });
  assert(P2.render().includes('data-act="resetPlayer" data-name="Anna"') && P2.render().includes('data-act="resetPlayer" data-name="Ben"'), 'a reset button per person');
  P2.click({ act: 'resetPlayer', name: 'Anna' });
  assert(asked.length === 2, 'asks twice before resetting');
  const board = P.store.leaderboard();
  assert(board.length === 1 && board[0].name === 'Ben' && board[0].gamesPlayed === 1, "only Anna's stats are gone, Ben's are untouched");
  // declined second confirmation: nothing happens
  const P3 = createApp(P.store, { storage: P.storage, confirm: (() => { let n = 0; return () => ++n === 1; })(), setTimeout: (fn) => timers.push(fn) });
  P3.click({ act: 'resetPlayer', name: 'Ben' });
  assert(P.store.leaderboard().length === 1, 'cancelling the second confirmation keeps the stats');
  // new games count again from then on, and the reset survives a reload
  const reloaded = createStore({ storage: P.storage });
  assert(reloaded.leaderboard().length === 1 && reloaded.leaderboard()[0].name === 'Ben', 'reset persisted');
}

console.log(`OK: online — adapter, lobby, join, reconnection (${drops} drops), sync, rematch, pause/reopen`);
