// ui.js — Interfaccia di Skyjo.
//  - render(): produce una stringa HTML a partire dallo stato dello store. Nessun accesso al DOM.
//  - click()/input(): trasformano i tocchi in azioni dello store.
// app.js fa da colla con il DOM (e con le animazioni): così l'interfaccia si testa in Node.
// Lo stile sta tutto in styles.css.

import { selectView, suggestedTarget, memoryStorage } from './skyjo-store.js';
import { recentGames } from './skyjo-stats.js';

const SETUP_KEY = 'skyjo:setup:v1';
const DEFAULT_DRAFT = { n1: '', n2: '', rows: 3, cols: 4, reveal: 2, target: 100, touched: false };

// ---------- utilità ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n === null || n === undefined ? '–' : String(Math.round(n * 10) / 10).replace('.', ','));
const tone = (v) => (v < 0 ? 'neg' : v === 0 ? 'zero' : v <= 4 ? 'low' : v <= 8 ? 'mid' : 'high');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const chip = (label, active, attrs) => `<button ${attrs} class="chip${active ? ' on' : ''}">${label}</button>`;

// ---------- la carta ----------
// Ha sempre dorso e fronte (serve per l'animazione di capovolgimento).
// Il valore di una carta coperta NON finisce mai nell'HTML.
// act != '' => è un bottone (data-act); hot => evidenziata come mossa possibile.
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

// Un giocatore: pannello con nome, punti e griglia. L'ordine dei pannelli NON cambia mai durante la partita.
function seatHtml(st, v, pl) {
  const { rows, cols } = st.game.config;
  const ar = ((cols * 3) / (rows * 4)).toFixed(3); // larghezza per unità di altezza (carta 3:4)
  const cells = pl.grid.map((c, i) => {
    const hot = isTarget(st, v, pl, c);
    const label = c ? (c.up ? `Carta ${i + 1}, valore ${c.v}` : `Carta ${i + 1}, coperta`) : '';
    return card(c, { key: `c-${pl.index}-${i}`, act: hot ? 'cell' : '', data: `data-p="${pl.index}" data-i="${i}"`, hot, label });
  }).join('');
  const turn = pl.isCurrent && v.phase === 'playing';
  const active = turn || (v.phase === 'initialReveal' && pl.needReveal > 0);
  return `<section class="seat panel${active ? ' active' : ''}" aria-label="Griglia di ${esc(pl.name)}">
    <div class="seat-head">
      <span class="seat-name truncate">${esc(pl.name)}${turn ? ' <span class="turn-dot">· turno</span>' : ''}</span>
      <span class="row" style="gap:6px"><span class="pill">Tot ${pl.total}</span><span class="pill">Scoperte ${pl.shown}</span></span>
    </div>
    <div class="grid-wrap" style="--ar:${ar};--cols:${cols}">
      <div class="cards" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cells}</div>
    </div>
  </section>`;
}

// Mazzo, scarti e carta in mano: tre posti sempre presenti (il layout non si sposta mai).
function pilesHtml(v) {
  const canDraw = v.phase === 'playing' && v.myTurn && v.step === 'draw';
  const canTake = canDraw && v.discardTop !== null;
  const deck = card({ up: false }, { key: 'deck', act: canDraw ? 'draw' : '', hot: canDraw, label: 'Pesca dal mazzo' });
  const discard = v.discardTop === null
    ? card(null, { key: 'discard' })
    : card({ up: true, v: v.discardTop }, { key: 'discard', act: canTake ? 'take' : '', hot: canTake, label: `Prendi lo scarto, valore ${v.discardTop}` });
  const held = v.held === null ? card(null, { key: 'held' }) : card({ up: true, v: v.held }, { key: 'held' });
  const canDiscard = v.held !== null && v.heldFrom === 'deck' && v.myTurn;
  return `<div class="center" aria-label="Mazzo, scarti e carta in mano">
    <div class="pile deck">${deck}<div class="pile-label">Mazzo · ${v.drawCount}</div></div>
    <div class="pile">${discard}<div class="pile-label">Scarti</div></div>
    <div class="pile${v.held !== null ? ' held' : ''}">${held}
      <div class="pile-label">${canDiscard ? '<button data-act="discard" class="btn-mini">Scarta</button>' : 'In mano'}</div></div>
  </div>`;
}

// Pannello di fine round / partita. Su telefono sta in basso (si può nascondere per vedere le carte),
// su schermo largo prende il posto del mazzo, al centro tra i due tavoli.
function sheetHtml(st, v, hidden) {
  let title, sub, table, actions;
  if (v.phase === 'roundOver') {
    const r = v.lastRound;
    const fin = st.game.players[r.finisher].name;
    const rows = v.players.map((p, i) => `<tr>
        <td>${esc(p.name)}${r.finisher === i ? ' ★' : ''}</td>
        <td class="tr num">${r.doubled && r.finisher === i ? `${r.raw[i]} ×2 = ${r.scores[i]}` : r.scores[i]}</td>
        <td class="tr num strong">${p.total}</td></tr>`).join('');
    title = `Round ${r.round} finito`;
    sub = `${esc(fin)} ha chiuso${r.doubled ? ' senza avere il punteggio più basso: punti raddoppiati' : ''}.`;
    table = `<table class="tbl mt"><thead><tr><th>Giocatore</th><th class="tr">Round</th><th class="tr">Totale</th></tr></thead><tbody>${rows}</tbody></table>`;
    actions = `<button data-act="next" class="btn btn-primary">Prossimo round</button>
      <button data-act="finish" class="btn btn-ghost btn-sm">Chiudi la partita qui</button>`;
  } else if (v.phase === 'gameOver') {
    const min = Math.min(...v.players.map((p) => p.total));
    const winners = v.players.filter((p) => p.total === min);
    const rows = [...v.players].sort((a, b) => a.total - b.total).map((p) => `<tr>
        <td>${p.total === min ? '★ ' : ''}${esc(p.name)}</td>
        <td class="tr num strong">${p.total}</td>
        <td class="tr num muted">${num(p.total / v.round)} a round</td></tr>`).join('');
    title = `<span class="gold">${winners.length === 1 ? `Vince ${esc(winners[0].name)}!` : 'Pareggio!'}</span>`;
    sub = `${v.round} ${v.round === 1 ? 'round giocato' : 'round giocati'} · la media più bassa vince`;
    table = `<table class="tbl mt"><tbody>${rows}</tbody></table>`;
    actions = `<button data-act="again" class="btn btn-primary">Rivincita</button>
      <button data-act="stats" class="btn btn-secondary btn-sm">Statistiche</button>
      <button data-act="exit" class="btn btn-ghost btn-sm">Torna alla home</button>`;
  } else return '';
  return `<div class="sheet-wrap${hidden ? ' collapsed' : ''}">
    <div class="sheet" data-key="sheet">
      <div class="row between"><h2>${title}</h2>
        <button data-act="toggleSheet" class="btn-menu toggle-sheet" aria-label="Nascondi il risultato per vedere le carte">▾</button></div>
      <p class="muted small">${sub}</p>
      ${table}
      <div class="stack-s mt-l">${actions}</div>
    </div>
    <button data-act="toggleSheet" class="btn-menu sheet-tab">▴ Mostra il risultato</button>
  </div>`;
}

// ---------- schermate ----------
function homeHtml(st) {
  const s = st.saved;
  let resume = '';
  if (s && s.mode === 'local') {
    resume = `<div class="panel pad stack-s">
      <div class="eyebrow">Partita in corso · Round ${s.round}</div>
      <div class="serif strong">${s.names.map((n, i) => `${esc(n)} ${s.totals[i]}`).join(' – ')}</div>
      <div class="row mt-s">
        <button data-act="resume" class="btn btn-primary btn-sm grow">Riprendi</button>
        <button data-act="dropSaved" class="btn btn-secondary btn-sm" style="width:auto">Elimina</button>
      </div></div>`;
  } else if (s) {
    resume = '<p class="panel pad muted small">Hai una partita online salvata: si riprende dalla modalità Online.</p>';
  }
  return `<main class="screen center-v">
    <div class="brand">
      <h1 class="brand-title">SKYJO</h1><div class="orn"></div>
      <p class="muted">Fate meno punti possibile</p>
    </div>
    ${resume}
    <div class="stack">
      <button data-act="newLocal" class="btn btn-primary">Pass &amp; Play<small>Un solo telefono, funziona anche senza Wi-Fi</small></button>
      <button disabled class="btn btn-secondary">Online · 2 telefoni<small>In arrivo</small></button>
      <button data-act="stats" class="btn btn-secondary">Statistiche</button>
    </div>
  </main>`;
}

function setupHtml(d) {
  const cells = d.rows * d.cols;
  const stepper = (label, field, val) => `<div class="row between">
      <div class="strong">${label}</div>
      <div class="row">
        <button data-act="step" data-field="${field}" data-d="-1" class="round-btn" aria-label="Diminuisci ${esc(label)}">−</button>
        <span class="stepper-val">${val}</span>
        <button data-act="step" data-field="${field}" data-d="1" class="round-btn" aria-label="Aumenta ${esc(label)}">+</button>
      </div></div>`;
  const input = (name, val, ph) => `<input data-input="${name}" value="${esc(val)}" placeholder="${ph}" maxlength="20" autocomplete="off" class="field">`;
  const presets = [[3, 4, 'Classico 3×4'], [4, 5, 'Variante 4×5']]
    .map(([r, c, l]) => chip(l, d.rows === r && d.cols === c, `data-act="preset" data-rows="${r}" data-cols="${c}"`)).join('');
  const targets = [100, 150, 200, null]
    .map((t) => chip(t === null ? 'Nessun limite' : t, d.target === t, `data-act="target" data-v="${t === null ? 'none' : t}"`)).join('');
  return `<main class="screen">
    <header class="row between"><h1 class="page-title">Nuova partita</h1><button data-act="back" class="btn-menu">Indietro</button></header>
    <section class="panel pad stack-s"><div class="eyebrow">Giocatori</div>${input('n1', d.n1, 'Giocatore 1')}${input('n2', d.n2, 'Giocatore 2')}</section>
    <section class="panel pad stack"><div class="eyebrow">Griglia</div>
      <div class="wrap">${presets}</div>
      ${stepper('Righe', 'rows', d.rows)}
      ${stepper('Colonne', 'cols', d.cols)}
      <p class="muted tiny">${cells} carte a testa</p></section>
    <section class="panel pad stack"><div class="eyebrow">Regole</div>
      ${stepper('Carte scoperte all\'inizio', 'reveal', d.reveal)}
      <div><div class="strong" style="margin-bottom:8px">Si gioca fino a</div><div class="wrap">${targets}</div></div></section>
    <button data-act="start" class="btn btn-primary">Inizia</button>
  </main>`;
}

function statsHtml(st, board) {
  const games = recentGames(st.stats, 15);
  const stat = (label, val) => `<div class="stat"><b>${val ?? '–'}</b><span>${label}</span></div>`;
  const boardHtml = board.length
    ? board.map((p, i) => `<section class="panel pad">
        <div class="row between">
          <div class="seat-name">${i === 0 && board.length > 1 ? '★ ' : ''}${esc(p.name)}</div>
          <div class="tr"><div class="serif num gold" style="font-size:2rem;font-weight:700;line-height:1">${num(p.avgPerRound)}</div><div class="muted tiny">punti / round</div></div>
        </div>
        <div class="grid3 mt">
          ${stat('Vittorie', `${p.gamesWon}/${p.gamesPlayed}`)}${stat('Round', p.roundsPlayed)}${stat('Punti totali', p.totalPoints)}
          ${stat('Round vinti', p.roundsWon)}${stat('Migliore', p.bestRound)}${stat('Peggiore', p.worstRound)}
        </div>
        <div class="muted tiny mt-s">Chiusure: ${p.roundsClosed} · Penalità raddoppio: ${p.penalties}</div>
      </section>`).join('')
    : '<p class="panel pad muted">Nessuna partita registrata. Finite una partita per vedere le statistiche.</p>';
  const hist = games.map((g) => `<li class="history-item">
      <div class="row between muted tiny">
        <span>${new Date(g.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <span>${g.config.rows}×${g.config.cols} · ${g.rounds.length} round${g.mode === 'remote' ? ' · online' : ''}</span></div>
      <div class="row between mt-s">${g.players.map((p, i) =>
        `<span class="${g.winners.includes(i) ? 'strong gold' : ''}">${g.winners.includes(i) ? '★ ' : ''}${esc(p.name)} ${p.total}</span>`).join('')}</div>
    </li>`).join('');
  return `<main class="screen">
    <header class="row between"><h1 class="page-title">Statistiche</h1><button data-act="back" class="btn-menu">Indietro</button></header>
    <p class="muted tiny">Classifica per media punti a round: vince la media più bassa.</p>
    ${boardHtml}
    ${games.length ? `<div class="eyebrow">Ultime partite</div><ul class="list">${hist}</ul>` : ''}
    <div class="grid2 mt">
      <button data-act="export" class="btn btn-secondary btn-sm">Esporta backup</button>
      <label class="btn btn-secondary btn-sm" style="cursor:pointer">Importa backup
        <input id="importFile" type="file" accept="application/json,.json" hidden></label>
    </div>
  </main>`;
}

function gameHtml(st, sheetHidden) {
  const v = selectView(st);
  const remote = st.mode !== 'local';
  // In locale l'ordine è fisso (giocatore 1 poi giocatore 2). Online "io" sta sempre per ultimo.
  const ordered = remote ? [...v.players.filter((p) => p.index !== st.seat), v.players[st.seat]] : v.players;
  const seats = ordered.map((p) => seatHtml(st, v, p));
  const sheet = sheetHtml(st, v, sheetHidden);
  const yourTurn = v.phase === 'initialReveal' || v.myTurn;
  return `<div class="stage${sheet && !sheetHidden ? ' with-sheet' : ''}">
    <header class="topbar">
      <div><div class="serif strong" style="font-size:1.25rem">Round ${v.round}</div>
        <div class="muted tiny">${v.targetScore ? `Si gioca fino a ${v.targetScore}` : 'Senza limite di punti'}</div></div>
      <button data-act="menu" class="btn-menu">Menu</button>
    </header>
    <div class="hint panel${yourTurn ? ' hot' : ''}" role="status">${esc(v.hint)}</div>
    <div class="table${sheet ? ' has-sheet' : ''}">${[seats[0], pilesHtml(v), ...seats.slice(1), sheet].join('')}</div>
  </div>`;
}

const menuHtml = () => `<div class="overlay"><div class="sheet stack-s">
    <button data-act="stats" class="btn btn-secondary">Statistiche</button>
    <button data-act="exit" class="btn btn-danger">Esci dalla partita</button>
    <button data-act="closeMenu" class="btn btn-ghost">Chiudi</button>
  </div></div>`;

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

  const ui = { menu: false, toast: null, sheetHidden: false };
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
    if (st.screen === 'game' && st.game) body = gameHtml(st, ui.sheetHidden);
    else if (st.screen === 'setup') body = setupHtml(draft);
    else if (st.screen === 'stats') body = statsHtml(st, store.leaderboard());
    else body = homeHtml(st);
    const toast = st.error ? { text: st.error, kind: 'error' } : ui.toast;
    return body + (ui.menu && st.game ? menuHtml() : '') + toastHtml(toast);
  }

  function startGame(config) {
    ui.sheetHidden = false;
    const r = store.startLocal(config);
    if (r.ok) store.dispatch({ type: 'START_ROUND' });
  }

  function click(d) {
    const st = store.getState();
    switch (d.act) {
      case 'newLocal': store.setScreen('setup'); break;
      case 'resume': ui.sheetHidden = false; store.resumeLocal(); break;
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
      case 'next': ui.sheetHidden = false; store.dispatch({ type: 'START_ROUND' }); break;
      case 'finish':
        if (confirmFn('Chiudere la partita e registrare i punteggi?')) { ui.sheetHidden = false; store.finishGame(); }
        break;
      case 'toggleSheet': ui.sheetHidden = !ui.sheetHidden; onChange(); break;
      case 'again': {
        const c = st.game.config;
        startGame({ playerNames: c.playerNames, rows: c.rows, cols: c.cols, initialReveal: c.initialReveal, targetScore: c.targetScore, doubleOnFail: c.doubleOnFail });
        break;
      }

      case 'menu': ui.menu = true; onChange(); break;
      case 'closeMenu': ui.menu = false; onChange(); break;
      case 'exit':
        if (confirmFn('Uscire dalla partita? Se non è finita andrà persa.')) { ui.menu = false; ui.sheetHidden = false; store.leave(); }
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
