// skyjo-stats.js
// Statistiche e storico. Funzioni PURE: niente storage, niente DOM.
// Lo store decide quando salvare; qui si trasforma e si calcola soltanto.
//
// Modello: stats = { version: 1, games: [GameSummary, ...] }
// Tutto il resto (medie, vittorie, ...) è DERIVATO dallo storico: così non si
// possono mai creare incoerenze e si possono aggiungere nuove statistiche
// in futuro senza migrare i dati salvati.

const nameKey = (name) => name.trim().toLowerCase();

export const emptyStats = () => ({ version: 1, games: [] });

// Fotografia di una partita finita (o chiusa a mano a fine round).
export function summarizeGame(game, { id, mode, date }) {
  const { rows, cols, initialReveal, targetScore, doubleOnFail } = game.config;
  const min = Math.min(...game.players.map((p) => p.total));
  return {
    id,
    date,
    mode, // 'local' | 'remote'
    config: { rows, cols, initialReveal, targetScore, doubleOnFail },
    players: game.players.map((p) => ({
      name: p.name,
      total: p.total,
      roundScores: [...p.roundScores],
    })),
    // indici dei vincitori (più di uno in caso di pareggio sul totale)
    winners: game.players.flatMap((p, i) => (p.total === min ? [i] : [])),
    rounds: game.roundHistory.map((r) => ({ ...r, raw: [...r.raw], scores: [...r.scores] })),
  };
}

// Immutabile e idempotente: lo stesso id non viene mai aggiunto due volte.
export function addGame(stats, summary) {
  if (stats.games.some((g) => g.id === summary.id)) return stats;
  return { ...stats, games: [...stats.games, summary] };
}

// Classifica per giocatore (chiave = nome senza maiuscole/spazi).
// Ordinata per media punti per round crescente: vince chi ha la media più bassa.
export function computePlayerStats(stats) {
  const map = new Map();
  const get = (name) => {
    const k = nameKey(name);
    if (!map.has(k)) {
      map.set(k, {
        name: name.trim(),
        gamesPlayed: 0, gamesWon: 0,
        roundsPlayed: 0, roundsWon: 0, roundsClosed: 0, penalties: 0,
        totalPoints: 0, bestRound: null, worstRound: null,
      });
    }
    return map.get(k);
  };

  for (const g of stats.games) {
    g.players.forEach((p, i) => {
      const s = get(p.name);
      s.gamesPlayed += 1;
      if (g.winners.includes(i)) s.gamesWon += 1;
    });
    for (const r of g.rounds) {
      const best = Math.min(...r.scores);
      r.scores.forEach((score, i) => {
        const s = get(g.players[i].name);
        s.roundsPlayed += 1;
        s.totalPoints += score;
        if (score === best) s.roundsWon += 1;
        if (s.bestRound === null || score < s.bestRound) s.bestRound = score;
        if (s.worstRound === null || score > s.worstRound) s.worstRound = score;
        if (r.finisher === i) {
          s.roundsClosed += 1;
          if (r.doubled) s.penalties += 1;
        }
      });
    }
  }

  return [...map.values()]
    .map((s) => ({
      ...s,
      avgPerRound: s.roundsPlayed ? s.totalPoints / s.roundsPlayed : null,
      winRate: s.gamesPlayed ? s.gamesWon / s.gamesPlayed : null,
    }))
    .sort((a, b) => (a.avgPerRound ?? Infinity) - (b.avgPerRound ?? Infinity));
}

export const recentGames = (stats, n = 20) =>
  [...stats.games].sort((a, b) => b.date - a.date).slice(0, n);

// Backup / trasferimento tra dispositivi (localStorage può essere cancellato dal browser).
export const exportStats = (stats) => JSON.stringify(stats, null, 2);

const isSummary = (g) =>
  g && typeof g.id === 'string' && Array.isArray(g.players) &&
  Array.isArray(g.rounds) && Array.isArray(g.winners);

export function importStats(stats, json) {
  let data;
  try { data = JSON.parse(json); } catch { throw new Error('File non valido'); }
  if (!data || data.version !== 1 || !Array.isArray(data.games))
    throw new Error('Formato statistiche non riconosciuto');
  let out = stats;
  let added = 0;
  for (const g of data.games.filter(isSummary)) {
    const next = addGame(out, g);
    if (next !== out) added += 1;
    out = next;
  }
  return { stats: out, added };
}
