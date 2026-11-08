// ui.js — Skyjo interface.
//  - render(): builds an HTML string from the store state. No DOM access.
//  - click()/input(): turn taps into store actions.
// app.js is the glue to the DOM (and animations), so the UI can be tested in Node.
// All styling lives in styles.css.

import { selectView, suggestedTarget, memoryStorage } from './skyjo-store.js';
import { recentGames } from './skyjo-stats.js';

const SETUP_KEY = 'skyjo:setup:v1';
const DEFAULT_DRAFT = { n1: '', n2: '', rows: 3, cols: 4, reveal: 2, target: 100, touched: false, joinName: '' };

// ---------- utilities ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n === null || n === undefined ? '–' : String(Math.round(n * 10) / 10));
const tone = (v) => (v < 0 ? 'neg' : v === 0 ? 'zero' : v <= 4 ? 'low' : v <= 8 ? 'mid' : 'high');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const chip = (label, active, attrs) => `<button ${attrs} class="chip${active ? ' on' : ''}">${label}</button>`;

// ---------- the card ----------
// Always has a back and a front (needed for the flip animation).
// The value of a face-down card NEVER ends up in the HTML.
// act != '' => it is a button (data-act); hot => highlighted as a possible move.
function card(c, { key = '', act = '', data = '', hot = false, label = '' } = {}) {
  const k = key ? ` data-key="${key}"` : '';
  if (c === null) return `<div class="card card-empty"${k}></div>`;
  const front = c.up && c.v !== null
    ? `<span class="face f-front tone-${tone(c.v)}" data-v="${c.v}"><b>${c.v}</b></span>`
    : '';
  const inner = `<span class="card-inner"><span class="face f-back"></span>${front}</span>`;
  const cls = `card${c.up ? ' up' : ''}${hot ? ' is-target' : ''}`;
  if (!act) return `<div class="${cls}"${k}>${inner}</div>`;
  return `<button class="${cls}"${k} data-act="${act}" ${data} aria-label="${esc(label)}">${inner}</button>`;
}

function isTarget(st, v, pl, c) {
  if (!c) return false;
  if (v.phase === 'initialReveal') return !c.up && pl.needReveal > 0 && (st.mode === 'local' || pl.isMe);
  if (v.phase === 'playing' && v.myTurn && pl.index === v.current) {
    if (v.step === 'place') return true;
    if (v.step === 'flip') return !c.up;
  }
  return false;
}

// One player: panel with name, points and grid. The order of the panels NEVER changes during a game.
function seatHtml(st, v, pl) {
  const { rows, cols } = st.game.config;
  const ar = ((cols * 3) / (rows * 4)).toFixed(3); // width per unit of height (3:4 card)
  const cells = pl.grid.map((c, i) => {
    const hot = isTarget(st, v, pl, c);
    const label = c ? (c.up ? `Card ${i + 1}, value ${c.v}` : `Card ${i + 1}, face down`) : '';
    return card(c, { key: `c-${pl.index}-${i}`, act: hot ? 'cell' : '', data: `data-p="${pl.index}" data-i="${i}"`, hot, label });
  }).join('');
  const turn = pl.isCurrent && v.phase === 'playing';
  const active = turn || (v.phase === 'initialReveal' && pl.needReveal > 0);
  return `<section class="seat panel${active ? ' active' : ''}" aria-label="Grid of ${esc(pl.name)}">
    <div class="seat-head">
      <span class="seat-name truncate">${esc(pl.name)}${turn ? ' <span class="turn-dot">· turn</span>' : ''}</span>
      <span class="row" style="gap:6px"><span class="pill">Total ${pl.total}</span><span class="pill">Showing ${pl.shown}</span></span>
    </div>
    <div class="grid-wrap" style="--ar:${ar};--cols:${cols}">
      <div class="cards" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cells}</div>
    </div>
  </section>`;
}

// Deck, discard and held card: three slots that are always present (the layout never shifts).
function pilesHtml(v) {
  const canDraw = v.phase === 'playing' && v.myTurn && v.step === 'draw';
  const canTake = canDraw && v.discardTop !== null;
  const deck = card({ up: false }, { key: 'deck', act: canDraw ? 'draw' : '', hot: canDraw, label: 'Draw from the deck' });
  const discard = v.discardTop === null
    ? card(null, { key: 'discard' })
    : card({ up: true, v: v.discardTop }, { key: 'discard', act: canTake ? 'take' : '', hot: canTake, label: `Take the discard, value ${v.discardTop}` });
  const held = v.held === null ? card(null, { key: 'held' }) : card({ up: true, v: v.held }, { key: 'held' });
  const canDiscard = v.held !== null && v.heldFrom === 'deck' && v.myTurn;
  return `<div class="center" aria-label="Deck, discard pile and held card">
    <div class="pile deck">${deck}<div class="pile-label">Deck · ${v.drawCount}</div></div>
    <div class="pile">${discard}<div class="pile-label">Discard</div></div>
    <div class="pile${v.held !== null ? ' held' : ''}">${held}
      <div class="pile-label">${canDiscard ? '<button data-act="discard" class="btn-mini">Discard</button>' : 'In hand'}</div></div>
  </div>`;
}

// End-of-round / end-of-game panel. On a phone it sits at the bottom (can be hidden to see the cards);
// on a wide screen it takes the place of the deck, between the two tables.
function sheetHtml(st, v, hidden) {
  let title, sub, table, actions;
  if (v.phase === 'roundOver') {
    const r = v.lastRound;
    const fin = st.game.players[r.finisher].name;
    const rows = v.players.map((p, i) => `<tr>
        <td>${esc(p.name)}${r.finisher === i ? ' ★' : ''}</td>
        <td class="tr num">${r.doubled && r.finisher === i ? `${r.raw[i]} ×2 = ${r.scores[i]}` : r.scores[i]}</td>
        <td class="tr num strong">${p.total}</td></tr>`).join('');
    title = `Round ${r.round} over`;
    sub = `${esc(fin)} closed the round${r.doubled ? ' without the lowest score: points doubled' : ''}.`;
    table = `<table class="tbl mt"><thead><tr><th>Player</th><th class="tr">Round</th><th class="tr">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
    actions = `<button data-act="next" class="btn btn-primary">Next round</button>
      <button data-act="finish" class="btn btn-ghost btn-sm">End the game here</button>`;
  } else if (v.phase === 'gameOver') {
    const min = Math.min(...v.players.map((p) => p.total));
    const winners = v.players.filter((p) => p.total === min);
    const rows = [...v.players].sort((a, b) => a.total - b.total).map((p) => `<tr>
        <td>${p.total === min ? '★ ' : ''}${esc(p.name)}</td>
        <td class="tr num strong">${p.total}</td>
        <td class="tr num muted">${num(p.total / v.round)} per round</td></tr>`).join('');
    title = `<span class="gold">${winners.length === 1 ? `${esc(winners[0].name)} wins!` : 'It\'s a tie!'}</span>`;
    sub = `${v.round} ${v.round === 1 ? 'round played' : 'rounds played'} · lowest average wins`;
    table = `<table class="tbl mt"><tbody>${rows}</tbody></table>`;
    actions = `<button data-act="again" class="btn btn-primary">Rematch</button>
      <button data-act="stats" class="btn btn-secondary btn-sm">Stats</button>
      <button data-act="${st.mode === 'local' ? 'exit' : 'leaveOnline'}" class="btn btn-ghost btn-sm">Back to home</button>`;
  } else return '';
  return `<div class="sheet-wrap${hidden ? ' collapsed' : ''}">
    <div class="sheet" data-key="sheet">
      <div class="row between"><h2>${title}</h2>
        <button data-act="toggleSheet" class="btn-menu toggle-sheet" aria-label="Hide the result to see the cards">▾</button></div>
      <p class="muted small">${sub}</p>
      ${table}
      <div class="stack-s mt-l">${actions}</div>
    </div>
    <button data-act="toggleSheet" class="btn-menu sheet-tab">▴ Show the result</button>
  </div>`;
}

// ---------- screens ----------
function homeHtml(st) {
  const s = st.saved;
  let resume = '';
  if (s && s.mode === 'local') {
    resume = `<div class="panel pad stack-s">
      <div class="eyebrow">Game in progress · Round ${s.round}</div>
      <div class="serif strong">${s.names.map((n, i) => `${esc(n)} ${s.totals[i]}`).join(' – ')}</div>
      <div class="row mt-s">
        <button data-act="resume" class="btn btn-primary btn-sm grow">Resume</button>
        <button data-act="dropSaved" class="btn btn-secondary btn-sm" style="width:auto">Delete</button>
      </div></div>`;
  } else if (s && s.mode === 'host' && s.roomCode) {
    resume = `<div class="panel pad stack-s">
      <div class="eyebrow">Online game in progress · Round ${s.round}</div>
      <div class="serif strong">${s.names.map((n, i) => `${esc(n)} ${s.totals[i]}`).join(' – ')}</div>
      <div class="muted tiny">Room ${esc(s.roomCode)} · you are the host</div>
      <div class="row mt-s">
        <button data-act="resumeOnline" class="btn btn-primary btn-sm grow">Reopen room</button>
        <button data-act="dropSaved" class="btn btn-secondary btn-sm" style="width:auto">Delete</button>
      </div></div>`;
  }
  return `<main class="screen center-v">
    <div class="brand">
      <h1 class="brand-title">SKYJO</h1><div class="orn"></div>
      <p class="muted">Score as few points as you can</p>
    </div>
    ${resume}
    <div class="stack">
      <button data-act="newLocal" class="btn btn-primary">Pass &amp; Play<small>One phone, works even with no Wi-Fi</small></button>
      <button data-act="online" class="btn btn-secondary">Online · 2 phones<small>Each on their own phone</small></button>
      <button data-act="stats" class="btn btn-secondary">Stats</button>
    </div>
  </main>`;
}

function onlineHtml() {
  return `<main class="screen">
    <header class="row between"><h1 class="page-title">Play online</h1><button data-act="back" class="btn-menu">Back</button></header>
    <p class="muted small">One of you creates a room and shares the 5-letter code. The other joins with it. It needs an internet connection on both phones.</p>
    <div class="stack">
      <button data-act="newOnline" class="btn btn-primary">Create a room<small>You deal, you pick the rules</small></button>
      <button data-act="joinScreen" class="btn btn-secondary">Join a room<small>Enter the code you were sent</small></button>
    </div>
  </main>`;
}

function joinHtml(d, code) {
  return `<main class="screen">
    <header class="row between"><h1 class="page-title">Join a room</h1><button data-act="online" class="btn-menu">Back</button></header>
    <section class="panel pad stack-s"><div class="eyebrow">Room code</div>
      <input data-input="code" value="${esc(code)}" placeholder="ABCDE" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" class="field code-input"></section>
    <section class="panel pad stack-s"><div class="eyebrow">Your name</div>
      <input data-input="joinName" value="${esc(d.joinName)}" placeholder="Player 2" maxlength="20" autocomplete="off" class="field"></section>
    <button data-act="join" class="btn btn-primary">Join</button>
  </main>`;
}

function setupHtml(d, online) {
  const cells = d.rows * d.cols;
  const stepper = (label, field, val) => `<div class="row between">
      <div class="strong">${label}</div>
      <div class="row">
        <button data-act="step" data-field="${field}" data-d="-1" class="round-btn" aria-label="Decrease ${esc(label)}">−</button>
        <span class="stepper-val">${val}</span>
        <button data-act="step" data-field="${field}" data-d="1" class="round-btn" aria-label="Increase ${esc(label)}">+</button>
      </div></div>`;
  const input = (name, val, ph) => `<input data-input="${name}" value="${esc(val)}" placeholder="${ph}" maxlength="20" autocomplete="off" class="field">`;
  const presets = [[3, 4, 'Classic 3×4'], [4, 5, 'Variant 4×5']]
    .map(([r, c, l]) => chip(l, d.rows === r && d.cols === c, `data-act="preset" data-rows="${r}" data-cols="${c}"`)).join('');
  const targets = [100, 150, 200, null]
    .map((t) => chip(t === null ? 'No limit' : t, d.target === t, `data-act="target" data-v="${t === null ? 'none' : t}"`)).join('');
  const players = online
    ? `<section class="panel pad stack-s"><div class="eyebrow">Your name</div>${input('n1', d.n1, 'Player 1')}</section>`
    : `<section class="panel pad stack-s"><div class="eyebrow">Players</div>${input('n1', d.n1, 'Player 1')}${input('n2', d.n2, 'Player 2')}</section>`;
  return `<main class="screen">
    <header class="row between"><h1 class="page-title">${online ? 'Create a room' : 'New game'}</h1><button data-act="${online ? 'online' : 'back'}" class="btn-menu">Back</button></header>
    ${players}
    <section class="panel pad stack"><div class="eyebrow">Grid</div>
      <div class="wrap">${presets}</div>
      ${stepper('Rows', 'rows', d.rows)}
      ${stepper('Columns', 'cols', d.cols)}
      <p class="muted tiny">${cells} cards each</p></section>
    <section class="panel pad stack"><div class="eyebrow">Rules</div>
      ${stepper('Cards revealed at the start', 'reveal', d.reveal)}
      <div><div class="strong" style="margin-bottom:8px">Play until</div><div class="wrap">${targets}</div></div></section>
    <button data-act="${online ? 'hostStart' : 'start'}" class="btn btn-primary">${online ? 'Open the room' : 'Start'}</button>
  </main>`;
}

function connectingHtml(st, ui) {
  const guest = st.mode === 'guest' || ui.pending?.kind === 'join';
  const code = esc(ui.pending?.code ?? st.roomCode ?? '');
  const lost = st.connection === 'lost';
  const title = guest ? `Joining room ${code}` : 'Opening your room…';
  const sub = lost ? "Can't reach the room yet. Trying again…" : guest ? 'Connecting to the host…' : 'Setting things up…';
  return `<main class="screen center-v tc">
    <div class="spinner" role="progressbar" aria-label="Connecting"></div>
    <h1 class="page-title">${title}</h1>
    <p class="muted">${sub}</p>
    <button data-act="cancelConnect" class="btn btn-ghost btn-sm" style="width:auto;margin:0 auto">Cancel</button>
  </main>`;
}

// Pre-game room: the host sees the code to share, the guest waits for the deal.
function lobbyHtml(st, v) {
  const host = st.mode === 'host';
  const other = st.game.players[host ? 1 : 0].name;
  const connected = st.connection === 'connected';
  const status = `<span class="dot ${connected ? 'ok' : st.connection === 'lost' ? 'bad' : ''}"></span>`;
  if (host) {
    return `<section class="panel pad stack code-box" aria-label="Room">
      <div class="eyebrow">Room code</div>
      <div class="room-code" aria-label="Room code ${esc(st.roomCode)}">${esc(st.roomCode)}</div>
      <p class="muted small">Send this code to the other player. They tap Online → Join a room.</p>
      <div class="row" style="justify-content:center">
        <button data-act="copyCode" class="btn-menu">Copy code</button>
        <button data-act="shareCode" class="btn-menu">Share</button>
      </div>
      <p class="strong">${status}${connected ? `${esc(other)} joined` : 'Waiting for the other player…'}</p>
      <button data-act="next" class="btn btn-primary"${connected ? '' : ' disabled'}>Deal the cards</button>
    </section>`;
  }
  return `<section class="panel pad stack code-box" aria-label="Room">
    <div class="eyebrow">Room ${esc(st.roomCode ?? '')}</div>
    <p class="strong">${status}${connected ? `Connected to ${esc(other)}` : 'Reconnecting…'}</p>
    <p class="muted">Waiting for ${esc(other)} to deal the cards…</p>
  </section>`;
}

function statsHtml(st, board) {
  const games = recentGames(st.stats, 15);
  const stat = (label, val) => `<div class="stat"><b>${val ?? '–'}</b><span>${label}</span></div>`;
  const boardHtml = board.length
    ? board.map((p, i) => `<section class="panel pad">
        <div class="row between">
          <div class="seat-name">${i === 0 && board.length > 1 ? '★ ' : ''}${esc(p.name)}</div>
          <div class="tr"><div class="serif num gold" style="font-size:2rem;font-weight:700;line-height:1">${num(p.avgPerRound)}</div><div class="muted tiny">points / round</div></div>
        </div>
        <div class="grid3 mt">
          ${stat('Wins', `${p.gamesWon}/${p.gamesPlayed}`)}${stat('Rounds', p.roundsPlayed)}${stat('Total points', p.totalPoints)}
          ${stat('Rounds won', p.roundsWon)}${stat('Best', p.bestRound)}${stat('Worst', p.worstRound)}
        </div>
        <div class="muted tiny mt-s">Rounds closed: ${p.roundsClosed} · Doubling penalties: ${p.penalties}</div>
      </section>`).join('')
    : '<p class="panel pad muted">No games recorded yet. Finish a game to see your stats.</p>';
  const hist = games.map((g) => `<li class="history-item">
      <div class="row between muted tiny">
        <span>${new Date(g.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <span>${g.config.rows}×${g.config.cols} · ${g.rounds.length} ${g.rounds.length === 1 ? 'round' : 'rounds'}${g.mode === 'remote' ? ' · online' : ''}</span></div>
      <div class="row between mt-s">${g.players.map((p, i) =>
        `<span class="${g.winners.includes(i) ? 'strong gold' : ''}">${g.winners.includes(i) ? '★ ' : ''}${esc(p.name)} ${p.total}</span>`).join('')}</div>
    </li>`).join('');
  return `<main class="screen">
    <header class="row between"><h1 class="page-title">Stats</h1><button data-act="back" class="btn-menu">Back</button></header>
    <p class="muted tiny">Ranked by average points per round: the lowest average wins.</p>
    ${boardHtml}
    ${games.length ? `<div class="eyebrow">Recent games</div><ul class="list">${hist}</ul>` : ''}
    <div class="grid2 mt">
      <button data-act="export" class="btn btn-secondary btn-sm">Export backup</button>
      <label class="btn btn-secondary btn-sm" style="cursor:pointer">Import backup
        <input id="importFile" type="file" accept="application/json,.json" hidden></label>
    </div>
  </main>`;
}

function gameHtml(st, sheetHidden) {
  const v = selectView(st);
  const remote = st.mode !== 'local';
  const lobby = v.phase === 'lobby' && remote;
  // Locally the order is fixed (player 1 then player 2). Online "me" is always last (bottom).
  const ordered = remote ? [...v.players.filter((p) => p.index !== st.seat), v.players[st.seat]] : v.players;
  const seats = ordered.map((p) => seatHtml(st, v, p));
  const sheet = sheetHtml(st, v, sheetHidden);
  const yourTurn = v.phase === 'initialReveal' || v.myTurn;
  const other = remote ? st.game.players[st.seat === 0 ? 1 : 0].name : '';
  const banner = remote && !lobby && st.connection !== 'connected'
    ? `<div class="banner" role="alert">${st.mode === 'host'
      ? `${esc(other)} disconnected. Waiting for them to rejoin…` : 'Connection lost. Reconnecting…'}</div>`
    : '';
  const body = lobby
    ? lobbyHtml(st, v)
    : `<div class="table${sheet ? ' has-sheet' : ''}">${[seats[0], pilesHtml(v), ...seats.slice(1), sheet].join('')}</div>`;
  return `<div class="stage${sheet && !sheetHidden && !lobby ? ' with-sheet' : ''}">
    <header class="topbar">
      <div><div class="serif strong" style="font-size:1.25rem">${lobby ? 'Room' : `Round ${v.round}`}</div>
        <div class="muted tiny">${v.targetScore ? `Play until ${v.targetScore}` : 'No point limit'}</div></div>
      <button data-act="menu" class="btn-menu">Menu</button>
    </header>
    ${banner}
    ${lobby ? '' : `<div class="hint panel${yourTurn ? ' hot' : ''}" role="status">${esc(v.hint)}</div>`}
    ${body}
  </div>`;
}

function menuHtml(st) {
  const host = st.mode === 'host';
  const local = st.mode === 'local';
  return `<div class="overlay"><div class="sheet stack-s">
    <button data-act="stats" class="btn btn-secondary">Stats</button>
    ${host ? '<button data-act="pause" class="btn btn-secondary">Pause &amp; leave<small>Keeps the game so you can reopen the room</small></button>' : ''}
    <button data-act="${local ? 'exit' : 'leaveOnline'}" class="btn btn-danger">${local ? 'Quit game' : host ? 'End the game for both' : 'Leave the game'}</button>
    <button data-act="closeMenu" class="btn btn-ghost">Close</button>
  </div></div>`;
}

const toastHtml = (t) => (t
  ? `<div class="toast-wrap" role="status" aria-live="polite"><div class="toast${t.kind === 'error' ? ' error' : ''}">${esc(t.text)}</div></div>`
  : '');

// ---------- app ----------
export function createApp(store, opts = {}) {
  const storage = opts.storage ?? (() => { try { return globalThis.localStorage ?? memoryStorage(); } catch { return memoryStorage(); } })();
  const onChange = opts.onChange ?? (() => {});
  const confirmFn = opts.confirm ?? ((m) => (typeof globalThis.confirm === 'function' ? globalThis.confirm(m) : true));
  const later = opts.setTimeout ?? setTimeout;
  const download = opts.download ?? (() => {});
  const online = opts.online ?? null; // { newCode, normalize, host(code)->Promise<transport>, join(code)->transport }
  const clipboard = opts.clipboard ?? (async (text) => { await globalThis.navigator?.clipboard?.writeText(text); });
  const share = opts.share ?? (async (data) => { if (!globalThis.navigator?.share) throw new Error('no share'); await globalThis.navigator.share(data); });

  // pending: a connection attempt that has not reached the store yet. joinCode: where the guest reconnects to.
  const ui = { menu: false, toast: null, sheetHidden: false, setupFor: 'local', pending: null, joinCode: '', code: '', retrying: false };
  let lastError = null;

  function normalizeDraft(d) {
    d.rows = clamp(Math.round(d.rows) || 3, 2, 5);
    d.cols = clamp(Math.round(d.cols) || 4, 2, 6);
    d.reveal = clamp(Math.round(d.reveal) || 2, 1, d.rows * d.cols - 1);
    if (!d.touched) d.target = suggestedTarget(d.rows, d.cols);
    return d;
  }
  const draft = (() => {
    try { const raw = storage.getItem(SETUP_KEY); if (raw) return normalizeDraft({ ...DEFAULT_DRAFT, ...JSON.parse(raw) }); } catch { /* corrupted draft */ }
    return { ...DEFAULT_DRAFT };
  })();
  const saveDraft = () => { try { storage.setItem(SETUP_KEY, JSON.stringify(draft)); } catch { /* quota / private mode */ } };

  // Guest auto-reconnect: whenever the link is lost, try the same room again every few seconds.
  function scheduleRetry() {
    if (ui.retrying) return;
    ui.retrying = true;
    later(() => {
      ui.retrying = false;
      const st = store.getState();
      if (st.mode === 'guest' && st.connection === 'lost' && ui.joinCode && online) {
        store.joinRemote(st.myName, online.join(ui.joinCode));
      }
    }, 2500);
  }
  function reconnectNow() {
    const st = store.getState();
    if (st.mode === 'guest' && st.connection === 'lost' && ui.joinCode && online) store.joinRemote(st.myName, online.join(ui.joinCode));
  }

  store.subscribe((st) => {
    if (st.error && st.error !== lastError) later(() => store.clearError(), 3000);
    lastError = st.error;
    if (st.mode === 'guest' && st.connection === 'lost') scheduleRetry();
    onChange();
  });

  function notify(text, kind = 'info') {
    ui.toast = { text, kind };
    onChange();
    later(() => { ui.toast = null; onChange(); }, 2500);
  }

  function render() {
    const st = store.getState();
    let body;
    if (st.screen === 'game' && st.game) body = gameHtml(st, ui.sheetHidden);
    else if (st.screen === 'setup') body = setupHtml(draft, ui.setupFor === 'online');
    else if (st.screen === 'online') body = onlineHtml();
    else if (st.screen === 'join') body = joinHtml(draft, ui.code);
    else if (st.screen === 'connecting') body = connectingHtml(st, ui);
    else if (st.screen === 'stats') body = statsHtml(st, store.leaderboard());
    else body = homeHtml(st);
    const toast = st.error ? { text: st.error, kind: 'error' } : ui.toast;
    return body + (ui.menu && st.game ? menuHtml(st) : '') + toastHtml(toast);
  }

  function startGame(config) {
    ui.sheetHidden = false;
    const r = store.startLocal(config);
    if (r.ok) store.dispatch({ type: 'START_ROUND' });
  }

  async function openRoom(code, build) {
    if (!online) { notify('Online mode is not available here', 'error'); return; }
    ui.pending = { kind: 'host', code };
    store.setScreen('connecting');
    try {
      const t = await online.host(code);
      if (!ui.pending || ui.pending.code !== code) { t.close?.(); return; } // cancelled meanwhile
      ui.pending = null;
      ui.sheetHidden = false;
      build(t);
    } catch (e) {
      ui.pending = null;
      store.setScreen(ui.setupFor === 'online' ? 'setup' : 'home');
      notify(e.message || 'Could not open the room', 'error');
    }
  }

  function click(d) {
    const st = store.getState();
    switch (d.act) {
      case 'newLocal': ui.setupFor = 'local'; store.setScreen('setup'); break;
      case 'resume': ui.sheetHidden = false; store.resumeLocal(); break;
      case 'dropSaved': if (confirmFn('Delete the saved game?')) store.discardSaved(); break;
      case 'stats': ui.menu = false; store.setScreen('stats'); onChange(); break;
      case 'back': store.setScreen(st.game ? 'game' : 'home'); break;

      // ----- online -----
      case 'online': ui.menu = false; store.setScreen('online'); break;
      case 'newOnline': ui.setupFor = 'online'; store.setScreen('setup'); break;
      case 'joinScreen': store.setScreen('join'); break;
      case 'hostStart': {
        const code = online ? online.newCode() : '';
        const name = draft.n1.trim() || 'Player 1';
        saveDraft();
        openRoom(code, (t) => store.hostRemote({
          config: { rows: draft.rows, cols: draft.cols, initialReveal: draft.reveal, targetScore: draft.target },
          hostName: name, roomCode: code,
        }, t));
        break;
      }
      case 'resumeOnline': {
        const code = st.saved?.roomCode;
        if (code) openRoom(code, (t) => store.resumeHost(t));
        break;
      }
      case 'join': {
        const code = online ? online.normalize(ui.code) : '';
        if (!online || !online.isValid(code)) { notify('Enter the 5-character room code', 'error'); break; }
        saveDraft();
        ui.joinCode = code;
        ui.pending = { kind: 'join', code };
        ui.sheetHidden = false;
        store.joinRemote(draft.joinName.trim() || 'Player 2', online.join(code));
        break;
      }
      case 'cancelConnect': ui.pending = null; ui.joinCode = ''; store.leave(); break;
      case 'copyCode':
        clipboard(st.roomCode).then(() => notify('Code copied'), () => notify(`Code: ${st.roomCode}`));
        break;
      case 'shareCode':
        share({ title: 'Skyjo', text: `Join my Skyjo game! Room code: ${st.roomCode}` })
          .catch(() => clipboard(st.roomCode).then(() => notify('Code copied'), () => notify(`Code: ${st.roomCode}`)));
        break;
      case 'pause': ui.menu = false; ui.joinCode = ''; store.pause(); break;
      case 'leaveOnline':
        if (confirmFn(st.mode === 'host' ? 'End the game for both players?' : 'Leave the game?')) {
          ui.menu = false; ui.sheetHidden = false; ui.joinCode = ''; store.leave();
        }
        break;

      case 'preset': draft.rows = +d.rows; draft.cols = +d.cols; normalizeDraft(draft); saveDraft(); onChange(); break;
      case 'step':
        draft[d.field] += +d.d;
        normalizeDraft(draft); saveDraft(); onChange(); break;
      case 'target': draft.target = d.v === 'none' ? null : +d.v; draft.touched = true; saveDraft(); onChange(); break;
      case 'start': {
        const n1 = draft.n1.trim() || 'Player 1';
        let n2 = draft.n2.trim() || 'Player 2';
        if (n1.toLowerCase() === n2.toLowerCase()) n2 += ' (2)';
        saveDraft();
        startGame({ playerNames: [n1, n2], rows: draft.rows, cols: draft.cols, initialReveal: draft.reveal, targetScore: draft.target });
        break;
      }

      case 'cell': {
        const v = selectView(st);
        if (!v) break;
        const player = +d.p, index = +d.i;
        if (v.phase === 'initialReveal') store.dispatch({ type: 'REVEAL', player, index });
        else if (v.phase === 'playing' && v.step === 'place') store.dispatch({ type: 'SWAP', player, index });
        else if (v.phase === 'playing' && v.step === 'flip') store.dispatch({ type: 'FLIP', player, index });
        break;
      }
      case 'draw': store.dispatch({ type: 'DRAW_DECK', player: st.game.current }); break;
      case 'take': store.dispatch({ type: 'TAKE_DISCARD', player: st.game.current }); break;
      case 'discard': store.dispatch({ type: 'DISCARD_DRAWN', player: st.game.current }); break;
      case 'next': ui.sheetHidden = false; store.dispatch({ type: 'START_ROUND' }); break;
      case 'finish':
        if (confirmFn('End the game and record the scores?')) { ui.sheetHidden = false; store.finishGame(); }
        break;
      case 'toggleSheet': ui.sheetHidden = !ui.sheetHidden; onChange(); break;
      case 'again': {
        ui.sheetHidden = false;
        if (st.mode === 'local') {
          const c = st.game.config;
          startGame({ playerNames: c.playerNames, rows: c.rows, cols: c.cols, initialReveal: c.initialReveal, targetScore: c.targetScore, doubleOnFail: c.doubleOnFail });
        } else {
          store.rematch();
        }
        break;
      }

      case 'menu': ui.menu = true; onChange(); break;
      case 'closeMenu': ui.menu = false; onChange(); break;
      case 'exit':
        if (confirmFn('Quit the game? If it is not finished it will be lost.')) { ui.menu = false; ui.sheetHidden = false; store.leave(); }
        break;

      case 'export': download('skyjo-stats.json', store.exportStats()); break;
      default: break;
    }
  }

  // Typed text updates the draft WITHOUT re-rendering (otherwise the keyboard loses focus).
  function input(name, value) {
    if (name === 'n1' || name === 'n2' || name === 'joinName') { draft[name] = value; saveDraft(); }
    else if (name === 'code') ui.code = online ? online.normalize(value) : String(value).toUpperCase().slice(0, 5);
  }

  function importJson(text) {
    try {
      const n = store.importStats(text);
      notify(n ? `Imported ${n} ${n === 1 ? 'game' : 'games'}` : 'No new games to import');
    } catch (e) { notify(e.message, 'error'); }
  }

  // Called when the page becomes visible again (phones drop connections while asleep).
  const nudge = () => { reconnectNow(); };

  return { render, click, input, importJson, nudge };
}
