// ui.js — Interfaccia di Skyjo (mobile-first, Tailwind).
//  - render(): produce una stringa HTML a partire dallo stato dello store. Nessun accesso al DOM.
//  - click()/input(): trasformano i tocchi in azioni dello store.
// app.js fa solo da colla con il DOM: così tutta l'interfaccia si può testare in Node.

import { selectView, suggestedTarget, memoryStorage } from './skyjo-store.js';
import { recentGames } from './skyjo-stats.js';

const SETUP_KEY = 'skyjo:setup:v1';
const DEFAULT_DRAFT = { n1: '', n2: '', rows: 3, cols: 4, reveal: 2, target: 100, touched: false };

// ---------- utilità ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n === null || n === undefined ? '–' : String(Math.round(n * 10) / 10).replace('.', ','));
const tone = (v) => (v < 0 ? 'neg' : v === 0 ? 'zero' : v <= 4 ? 'low' : v <= 8 ? 'mid' : 'high');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const BTN = 'w-full rounded-2xl px-5 py-4 text-lg font-semibold transition active:scale-[.98]';
const PRIMARY = `${BTN} bg-amber-400 text-slate-900`;
const SECONDARY = `${BTN} bg-slate-800 text-slate-100`;
const GHOST = `${BTN} bg-transparent text-slate-300 border border-slate-700`;

const chip = (label, active, attrs) =>
  `<button ${attrs} class="rounded-full px-4 py-2 text-sm font-semibold ${active ? 'bg-amber-400 text-slate-900' : 'bg-slate-800 text-slate-200'}">${label}</button>`;

// ---------- componenti ----------
// Una carta. Se è un bersaglio valido diventa un bottone con data-act="cell".
function card(c, { target = false, p = 0, i = 0 } = {}) {
  if (c === null) return '<div class="card card-empty"></div>';
  const cls = `card ${c.up ? `tone-${tone(c.v)}` : 'card-back'}${target ? ' is-target' : ''}`;
  const inner = c.up ? `<span>${c.v}</span>` : '';
  if (!target) return `<div class="${cls}">${inner}</div>`;
  const label = c.up ? `Carta ${i + 1}, valore ${c.v}` : `Carta ${i + 1}, coperta`;
  return `<button class="${cls}" data-act="cell" data-p="${p}" data-i="${i}" aria-label="${label}">${inner}</button>`;
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

function playerBlock(st, v, pl, { compact }) {
  const cfg = st.game.config;
  const maxW = Math.round(cfg.cols * 76 * (compact ? 0.64 : 1));
  const cells = pl.grid.map((c, i) => card(c, { target: isTarget(st, v, pl, c), p: pl.index, i })).join('');
  const turn = pl.isCurrent && v.phase === 'playing';
  return `<section aria-label="Griglia di ${esc(pl.name)}">
    <div class="mx-3 mb-1.5 flex items-center justify-between rounded-xl px-3 py-1.5 ${turn ? 'bg-amber-400 text-slate-900' : 'bg-slate-800 text-slate-200'}">
      <span class="truncate font-semibold">${esc(pl.name)}${turn ? ' · turno' : ''}</span>
      <span class="shrink-0 pl-2 text-sm tabular-nums">Tot ${pl.total} · Scoperte ${pl.shown}</span>
    </div>
    <div class="mx-auto px-3" style="max-width:${maxW + 24}px">
      <div class="grid gap-1.5" style="grid-template-columns:repeat(${cfg.cols},minmax(0,1fr))">${cells}</div>
    </div>
  </section>`;
}

function pilesHtml(v) {
  const canDraw = v.phase === 'playing' && v.myTurn && v.step === 'draw';
  const canTake = canDraw && v.discardTop !== null;
  const deck = canDraw
    ? '<button data-act="draw" class="card card-back is-target" aria-label="Pesca dal mazzo"></button>'
    : '<div class="card card-back"></div>';
  const discard = v.discardTop === null
    ? '<div class="card card-empty"></div>'
    : canTake
      ? `<button data-act="take" class="card tone-${tone(v.discardTop)} is-target" aria-label="Prendi lo scarto, valore ${v.discardTop}"><span>${v.discardTop}</span></button>`
      : `<div class="card tone-${tone(v.discardTop)}"><span>${v.discardTop}</span></div>`;
  const held = v.held === null
    ? ''
    : `<div class="flex w-16 flex-col items-center gap-1">
         <div class="card tone-${tone(v.held)} w-full"><span>${v.held}</span></div>
         <div class="text-xs text-amber-300">In mano</div>
         ${v.heldFrom === 'deck' ? '<button data-act="discard" class="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-medium text-slate-100">Scarta</button>' : ''}
       </div>`;
  return `<div class="my-3 flex items-start justify-center gap-5">
    <div class="flex w-16 flex-col items-center gap-1">${deck}<div class="text-xs text-slate-400">Mazzo · ${v.drawCount}</div></div>
    <div class="flex w-16 flex-col items-center gap-1">${discard}<div class="text-xs text-slate-400">Scarti</div></div>
    ${held}
  </div>`;
}

function sheetHtml(st, v) {
  if (v.phase === 'roundOver') {
    const r = v.lastRound;
    const fin = st.game.players[r.finisher].name;
    const rows = v.players.map((p, i) => `<tr>
        <td class="py-1.5">${esc(p.name)}${r.finisher === i ? ' ★' : ''}</td>
        <td class="py-1.5 text-right tabular-nums">${r.doubled && r.finisher === i ? `${r.raw[i]} ×2 = ${r.scores[i]}` : r.scores[i]}</td>
        <td class="py-1.5 text-right font-bold tabular-nums">${p.total}</td></tr>`).join('');
    return `<div class="fixed inset-x-0 bottom-0 z-20 rounded-t-3xl bg-slate-900 p-5 pb-6 shadow-2xl ring-1 ring-slate-700">
      <h2 class="text-lg font-bold">Round ${r.round} finito</h2>
      <p class="text-sm text-slate-400">${esc(fin)} ha chiuso${r.doubled ? ' senza avere il punteggio più basso: punti raddoppiati' : ''}.</p>
      <table class="my-3 w-full text-sm"><thead class="text-xs text-slate-400"><tr><th class="text-left font-medium">Giocatore</th><th class="text-right font-medium">Round</th><th class="text-right font-medium">Totale</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="grid gap-2">
        <button data-act="next" class="${PRIMARY}">Prossimo round</button>
        <button data-act="finish" class="${GHOST} !py-3 !text-base">Chiudi la partita qui</button>
      </div></div>`;
  }
  if (v.phase === 'gameOver') {
    const min = Math.min(...v.players.map((p) => p.total));
    const winners = v.players.filter((p) => p.total === min);
    const title = winners.length === 1 ? `Vince ${esc(winners[0].name)}!` : 'Pareggio!';
    const rows = [...v.players].sort((a, b) => a.total - b.total).map((p) => `<tr>
        <td class="py-1.5">${p.total === min ? '★ ' : ''}${esc(p.name)}</td>
        <td class="py-1.5 text-right font-bold tabular-nums">${p.total}</td>
        <td class="py-1.5 text-right text-slate-400 tabular-nums">${num(p.total / v.round)} a round</td></tr>`).join('');
    return `<div class="fixed inset-x-0 bottom-0 z-20 rounded-t-3xl bg-slate-900 p-5 pb-6 shadow-2xl ring-1 ring-slate-700">
      <h2 class="text-2xl font-black text-amber-400">${title}</h2>
      <p class="text-sm text-slate-400">${v.round} ${v.round === 1 ? 'round giocato' : 'round giocati'} · la media più bassa vince</p>
      <table class="my-3 w-full text-sm"><tbody>${rows}</tbody></table>
      <div class="grid gap-2">
        <button data-act="again" class="${PRIMARY}">Rivincita</button>
        <button data-act="stats" class="${SECONDARY} !py-3 !text-base">Statistiche</button>
        <button data-act="exit" class="${GHOST} !py-3 !text-base">Torna alla home</button>
      </div></div>`;
  }
  return '';
}

// ---------- schermate ----------
function homeHtml(st) {
  const s = st.saved;
  let resume = '';
  if (s && s.mode === 'local') {
    resume = `<div class="rounded-2xl bg-slate-800 p-4">
      <div class="text-sm text-slate-400">Partita in corso · Round ${s.round}</div>
      <div class="font-semibold">${s.names.map((n, i) => `${esc(n)} ${s.totals[i]}`).join(' – ')}</div>
      <div class="mt-3 flex gap-2">
        <button data-act="resume" class="flex-1 rounded-xl bg-amber-400 py-3 font-semibold text-slate-900">Riprendi</button>
        <button data-act="dropSaved" class="rounded-xl bg-slate-700 px-4 py-3 font-medium">Elimina</button>
      </div></div>`;
  } else if (s) {
    resume = '<p class="rounded-2xl bg-slate-800 p-4 text-sm text-slate-400">Hai una partita online salvata: si riprende dalla modalità Online.</p>';
  }
  return `<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
    <div class="mb-4 text-center">
      <h1 class="text-6xl font-black tracking-tight text-amber-400">SKYJO</h1>
      <p class="mt-2 text-slate-400">Fate meno punti possibile</p>
    </div>
    ${resume}
    <button data-act="newLocal" class="${PRIMARY}">Pass &amp; Play<span class="block text-sm font-normal opacity-70">Un solo telefono, funziona anche senza Wi-Fi</span></button>
    <button disabled class="${BTN} bg-slate-800/60 text-slate-500">Online · 2 telefoni<span class="block text-sm font-normal">In arrivo</span></button>
    <button data-act="stats" class="${SECONDARY}">Statistiche</button>
  </main>`;
}

function setupHtml(d) {
  const cells = d.rows * d.cols;
  const stepper = (label, field, val, hint) => `<div class="flex items-center justify-between gap-3">
      <div><div class="font-medium">${label}</div>${hint ? `<div class="text-xs text-slate-400">${hint}</div>` : ''}</div>
      <div class="flex items-center gap-3">
        <button data-act="step" data-field="${field}" data-d="-1" class="h-11 w-11 rounded-full bg-slate-700 text-2xl" aria-label="Diminuisci ${label}">−</button>
        <span class="w-8 text-center text-xl font-bold tabular-nums">${val}</span>
        <button data-act="step" data-field="${field}" data-d="1" class="h-11 w-11 rounded-full bg-slate-700 text-2xl" aria-label="Aumenta ${label}">+</button>
      </div></div>`;
  const input = (name, val, ph) => `<input data-input="${name}" value="${esc(val)}" placeholder="${ph}" maxlength="20" autocomplete="off"
      class="w-full rounded-xl bg-slate-800 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400">`;
  const presets = [[3, 4, 'Classico 3×4'], [4, 5, 'Variante 4×5']]
    .map(([r, c, l]) => chip(l, d.rows === r && d.cols === c, `data-act="preset" data-rows="${r}" data-cols="${c}"`)).join('');
  const targets = [100, 150, 200, null]
    .map((t) => chip(t === null ? 'Nessun limite' : t, d.target === t, `data-act="target" data-v="${t === null ? 'none' : t}"`)).join('');
  return `<main class="mx-auto min-h-dvh max-w-md space-y-6 p-5 pb-10">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-black">Nuova partita</h1>
      <button data-act="back" class="rounded-lg bg-slate-800 px-3 py-1.5 text-sm">Indietro</button>
    </header>
    <section class="space-y-2"><h2 class="text-sm font-semibold uppercase tracking-wide text-slate-400">Giocatori</h2>
      ${input('n1', d.n1, 'Giocatore 1')}${input('n2', d.n2, 'Giocatore 2')}</section>
    <section class="space-y-3"><h2 class="text-sm font-semibold uppercase tracking-wide text-slate-400">Griglia</h2>
      <div class="flex flex-wrap gap-2">${presets}</div>
      ${stepper('Righe', 'rows', d.rows)}
      ${stepper('Colonne', 'cols', d.cols)}
      <p class="text-xs text-slate-400">${cells} carte a testa</p></section>
    <section class="space-y-3"><h2 class="text-sm font-semibold uppercase tracking-wide text-slate-400">Regole</h2>
      ${stepper('Carte scoperte all\'inizio', 'reveal', d.reveal)}
      <div><div class="mb-2 font-medium">Si gioca fino a</div><div class="flex flex-wrap gap-2">${targets}</div></div></section>
    <button data-act="start" class="${PRIMARY}">Inizia</button>
  </main>`;
}

function statsHtml(st, board) {
  const games = recentGames(st.stats, 15);
  const stat = (label, val) => `<div class="rounded-xl bg-slate-900/60 py-2"><div class="font-bold tabular-nums">${val ?? '–'}</div><div class="text-xs text-slate-400">${label}</div></div>`;
  const boardHtml = board.length
    ? board.map((p, i) => `<section class="rounded-2xl bg-slate-800 p-4">
        <div class="flex items-baseline justify-between">
          <div class="text-lg font-bold">${i === 0 && board.length > 1 ? '★ ' : ''}${esc(p.name)}</div>
          <div class="text-right"><div class="text-3xl font-black tabular-nums text-amber-400">${num(p.avgPerRound)}</div><div class="text-xs text-slate-400">punti / round</div></div>
        </div>
        <div class="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
          ${stat('Vittorie', `${p.gamesWon}/${p.gamesPlayed}`)}${stat('Round', p.roundsPlayed)}${stat('Punti totali', p.totalPoints)}
          ${stat('Round vinti', p.roundsWon)}${stat('Migliore', p.bestRound)}${stat('Peggiore', p.worstRound)}
        </div>
        <div class="mt-2 text-xs text-slate-400">Chiusure: ${p.roundsClosed} · Penalità raddoppio: ${p.penalties}</div>
      </section>`).join('')
    : '<p class="rounded-2xl bg-slate-800 p-4 text-slate-400">Nessuna partita registrata. Finite una partita per vedere le statistiche.</p>';
  const hist = games.map((g) => `<li class="rounded-xl bg-slate-800 px-4 py-3">
      <div class="flex justify-between text-xs text-slate-400">
        <span>${new Date(g.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <span>${g.config.rows}×${g.config.cols} · ${g.rounds.length} round${g.mode === 'remote' ? ' · online' : ''}</span></div>
      <div class="mt-1 flex justify-between gap-2">${g.players.map((p, i) =>
        `<span class="${g.winners.includes(i) ? 'font-bold text-amber-300' : 'text-slate-300'}">${g.winners.includes(i) ? '★ ' : ''}${esc(p.name)} ${p.total}</span>`).join('')}</div>
    </li>`).join('');
  return `<main class="mx-auto min-h-dvh max-w-md space-y-4 p-5 pb-10">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-black">Statistiche</h1>
      <button data-act="back" class="rounded-lg bg-slate-800 px-3 py-1.5 text-sm">Indietro</button>
    </header>
    <p class="text-xs text-slate-400">Classifica per media punti a round: vince la media più bassa.</p>
    ${boardHtml}
    ${games.length ? `<h2 class="pt-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Ultime partite</h2><ul class="space-y-2">${hist}</ul>` : ''}
    <div class="grid grid-cols-2 gap-2 pt-2">
      <button data-act="export" class="rounded-xl bg-slate-800 py-3 text-sm font-semibold">Esporta backup</button>
      <label class="cursor-pointer rounded-xl bg-slate-800 py-3 text-center text-sm font-semibold">Importa backup
        <input id="importFile" type="file" accept="application/json,.json" class="hidden"></label>
    </div>
  </main>`;
}

function gameHtml(st) {
  const v = selectView(st);
  const remote = st.mode !== 'local';
  const me = v.players[remote ? st.seat : (v.current ?? 0)];
  const others = v.players.filter((p) => p !== me);
  const sheet = sheetHtml(st, v);
  const yourTurn = v.phase === 'initialReveal' || v.myTurn;
  return `<div class="${sheet ? 'pb-80' : 'pb-8'}">
    <header class="flex items-center justify-between px-4 pb-1 pt-3 text-sm text-slate-400">
      <span>Round ${v.round} · ${v.targetScore ? `obiettivo ${v.targetScore}` : 'senza limite'}</span>
      <button data-act="menu" class="rounded-lg bg-slate-800 px-3 py-1.5 text-slate-200">Menu</button>
    </header>
    <div class="mx-3 my-2 rounded-xl bg-slate-800 px-4 py-2.5 text-center font-medium ${yourTurn ? 'text-amber-300' : 'text-slate-300'}" role="status">${esc(v.hint)}</div>
    <div class="space-y-3">${others.map((p) => playerBlock(st, v, p, { compact: true })).join('')}</div>
    ${pilesHtml(v)}
    ${playerBlock(st, v, me, { compact: false })}
  </div>${sheet}`;
}

const menuHtml = () => `<div class="fixed inset-0 z-30 flex items-end bg-black/60">
  <div class="w-full space-y-2 rounded-t-3xl bg-slate-900 p-5 pb-6">
    <button data-act="stats" class="${SECONDARY}">Statistiche</button>
    <button data-act="exit" class="${BTN} bg-rose-600/90 text-white">Esci dalla partita</button>
    <button data-act="closeMenu" class="${GHOST}">Chiudi</button>
  </div></div>`;

const toastHtml = (t) => (t
  ? `<div class="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-4" role="status" aria-live="polite">
       <div class="rounded-full px-4 py-2 text-sm font-medium shadow-lg ${t.kind === 'error' ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-900'}">${esc(t.text)}</div></div>`
  : '');

// ---------- app ----------
export function createApp(store, opts = {}) {
  const storage = opts.storage ?? (() => { try { return globalThis.localStorage ?? memoryStorage(); } catch { return memoryStorage(); } })();
  const onChange = opts.onChange ?? (() => {});
  const confirmFn = opts.confirm ?? ((m) => (typeof globalThis.confirm === 'function' ? globalThis.confirm(m) : true));
  const later = opts.setTimeout ?? setTimeout;
  const download = opts.download ?? (() => {});

  const ui = { menu: false, toast: null };
  let lastError = null;

  function normalizeDraft(d) {
    d.rows = clamp(Math.round(d.rows) || 3, 2, 5);
    d.cols = clamp(Math.round(d.cols) || 4, 2, 6);
    d.reveal = clamp(Math.round(d.reveal) || 2, 1, d.rows * d.cols - 1);
    if (!d.touched) d.target = suggestedTarget(d.rows, d.cols);
    return d;
  }
  const draft = (() => {
    try { const raw = storage.getItem(SETUP_KEY); if (raw) return normalizeDraft({ ...DEFAULT_DRAFT, ...JSON.parse(raw) }); } catch { /* bozza rovinata */ }
    return { ...DEFAULT_DRAFT };
  })();
  const saveDraft = () => { try { storage.setItem(SETUP_KEY, JSON.stringify(draft)); } catch { /* quota/privato */ } };

  store.subscribe((st) => {
    if (st.error && st.error !== lastError) later(() => store.clearError(), 3000);
    lastError = st.error;
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
    if (st.screen === 'game' && st.game) body = gameHtml(st);
    else if (st.screen === 'setup') body = setupHtml(draft);
    else if (st.screen === 'stats') body = statsHtml(st, store.leaderboard());
    else body = homeHtml(st);
    const toast = st.error ? { text: st.error, kind: 'error' } : ui.toast;
    return body + (ui.menu && st.game ? menuHtml() : '') + toastHtml(toast);
  }

  function startGame(config) {
    const r = store.startLocal(config);
    if (r.ok) store.dispatch({ type: 'START_ROUND' });
  }

  function click(d) {
    const st = store.getState();
    switch (d.act) {
      case 'newLocal': store.setScreen('setup'); break;
      case 'resume': store.resumeLocal(); break;
      case 'dropSaved': if (confirmFn('Eliminare la partita salvata?')) store.discardSaved(); break;
      case 'stats': ui.menu = false; store.setScreen('stats'); onChange(); break;
      case 'back': store.setScreen(st.game ? 'game' : 'home'); break;

      case 'preset': draft.rows = +d.rows; draft.cols = +d.cols; normalizeDraft(draft); saveDraft(); onChange(); break;
      case 'step':
        draft[d.field] += +d.d;
        normalizeDraft(draft); saveDraft(); onChange(); break;
      case 'target': draft.target = d.v === 'none' ? null : +d.v; draft.touched = true; saveDraft(); onChange(); break;
      case 'start': {
        const n1 = draft.n1.trim() || 'Giocatore 1';
        let n2 = draft.n2.trim() || 'Giocatore 2';
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
      case 'next': store.dispatch({ type: 'START_ROUND' }); break;
      case 'finish': if (confirmFn('Chiudere la partita e registrare i punteggi?')) store.finishGame(); break;
      case 'again': {
        const c = st.game.config;
        startGame({ playerNames: c.playerNames, rows: c.rows, cols: c.cols, initialReveal: c.initialReveal, targetScore: c.targetScore, doubleOnFail: c.doubleOnFail });
        break;
      }

      case 'menu': ui.menu = true; onChange(); break;
      case 'closeMenu': ui.menu = false; onChange(); break;
      case 'exit':
        if (confirmFn('Uscire dalla partita? Se non è finita andrà persa.')) { ui.menu = false; store.leave(); }
        break;

      case 'export': download('skyjo-statistiche.json', store.exportStats()); break;
      default: break;
    }
  }

  // Testi digitati: aggiornano la bozza SENZA ridisegnare (altrimenti la tastiera perde il focus).
  function input(name, value) {
    if (name === 'n1' || name === 'n2') { draft[name] = value; saveDraft(); }
  }

  function importJson(text) {
    try {
      const n = store.importStats(text);
      notify(n ? `Importate ${n} ${n === 1 ? 'partita' : 'partite'}` : 'Nessuna partita nuova da importare');
    } catch (e) { notify(e.message, 'error'); }
  }

  return { render, click, input, importJson };
}
