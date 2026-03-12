const { parseFp } = require('./kalshiClient');
const { toISODateInTz } = require('./stateStore');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s) {
  return new Set(
    normalize(s)
      .split(' ')
      .filter((x) => x.length >= 3),
  );
}

function overlapScore(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common += 1;
  return common / Math.max(A.size, B.size);
}

function tryParseScoreString(value) {
  const m = String(value || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!m) return null;
  return { homeScore: Number(m[1]), awayScore: Number(m[2]) };
}

function parseTeamsFromTitle(title) {
  const text = String(title || '');
  const m = text.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\?|$)/i) || text.match(/^(.+?)\s+v\.?\s+(.+?)(?:\?|$)/i);
  if (!m) return null;
  return { homeTeam: m[1].trim(), awayTeam: m[2].trim() };
}

function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    out[next] = v;
    if (v && typeof v === 'object') flatten(v, next, out);
  }
  return out;
}

function extractGameState(event) {
  if (event.__live) {
    const live = event.__live;
    if (
      live.minute !== null &&
      live.homeScore !== null &&
      live.awayScore !== null &&
      Number.isFinite(live.minute) &&
      Number.isFinite(live.homeScore) &&
      Number.isFinite(live.awayScore)
    ) {
      const goalDiff = Math.abs(live.homeScore - live.awayScore);
      const leadingSide = live.homeScore > live.awayScore ? 'home' : live.awayScore > live.homeScore ? 'away' : null;
      const leadingTeam = leadingSide === 'home' ? live.homeTeam : leadingSide === 'away' ? live.awayTeam : null;
      return {
        minute: live.minute,
        homeScore: live.homeScore,
        awayScore: live.awayScore,
        goalDiff,
        leadingSide,
        leadingTeam,
        competition: live.competition || null,
      };
    }
  }

  const md = event.product_metadata || {};
  const flat = flatten(md);

  const minuteKeys = [
    'minute',
    'game_minute',
    'current_minute',
    'match_minute',
    'clock.minute',
    'clock_minute',
    'elapsed_min',
    'elapsed',
    'time.minute',
  ];

  const homeScoreKeys = ['home_score', 'score_home', 'home.goals', 'home_score_current'];
  const awayScoreKeys = ['away_score', 'score_away', 'away.goals', 'away_score_current'];
  const homeTeamKeys = ['home_team', 'home.name', 'team_home', 'home'];
  const awayTeamKeys = ['away_team', 'away.name', 'team_away', 'away'];

  let minute = null;
  for (const [k, v] of Object.entries(flat)) {
    if (minute !== null) break;
    const key = k.toLowerCase();
    if (minuteKeys.some((mk) => key.endsWith(mk))) {
      const n = Number(v);
      if (Number.isFinite(n)) minute = n;
    }
  }

  let homeScore = null;
  let awayScore = null;

  for (const [k, v] of Object.entries(flat)) {
    const key = k.toLowerCase();
    if (homeScore === null && homeScoreKeys.some((x) => key.endsWith(x))) {
      const n = Number(v);
      if (Number.isFinite(n)) homeScore = n;
    }
    if (awayScore === null && awayScoreKeys.some((x) => key.endsWith(x))) {
      const n = Number(v);
      if (Number.isFinite(n)) awayScore = n;
    }

    if ((homeScore === null || awayScore === null) && typeof v === 'string' && key.includes('score')) {
      const parsed = tryParseScoreString(v);
      if (parsed) {
        homeScore = parsed.homeScore;
        awayScore = parsed.awayScore;
      }
    }
  }

  let homeTeam = null;
  let awayTeam = null;

  for (const [k, v] of Object.entries(flat)) {
    if (typeof v !== 'string') continue;
    const key = k.toLowerCase();
    if (!homeTeam && homeTeamKeys.some((x) => key.endsWith(x))) homeTeam = v;
    if (!awayTeam && awayTeamKeys.some((x) => key.endsWith(x))) awayTeam = v;
  }

  const fromTitle = parseTeamsFromTitle(event.title || event.sub_title || '');
  if (!homeTeam && fromTitle) homeTeam = fromTitle.homeTeam;
  if (!awayTeam && fromTitle) awayTeam = fromTitle.awayTeam;

  if (
    minute === null ||
    homeScore === null ||
    awayScore === null ||
    !Number.isFinite(homeScore) ||
    !Number.isFinite(awayScore)
  ) {
    return null;
  }

  const goalDiff = Math.abs(homeScore - awayScore);
  const leadingSide = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : null;
  const leadingTeam = leadingSide === 'home' ? homeTeam : leadingSide === 'away' ? awayTeam : null;

  return {
    minute,
    homeScore,
    awayScore,
    goalDiff,
    leadingSide,
    leadingTeam,
    competition: md.competition || null,
  };
}

function isLeagueAllowed(competition, config) {
  if (!competition) return false;
  return config.leagues.map(normalize).includes(normalize(competition));
}

function marketIsMatchWinner(market) {
  const y = normalize(market.yes_sub_title || '');
  const n = normalize(market.no_sub_title || '');
  const combined = `${y} ${n}`;
  if (combined.includes('draw') || combined.includes('tie')) return false;
  return true;
}

function pickMarketForLeadingTeam(event, leadingTeam, config) {
  if (!leadingTeam) return null;
  const teamN = normalize(leadingTeam);

  const markets = (event.markets || []).filter((m) => m.status === 'active' && marketIsMatchWinner(m));

  const exactOrContain = [];
  const fuzzy = [];
  const ranked = markets.sort((a, b) => parseFp(b.liquidity_dollars) - parseFp(a.liquidity_dollars));
  for (const m of ranked) {
    const y = normalize(m.yes_sub_title || '');
    if (!y) continue;
    if (y === teamN || y.includes(teamN) || teamN.includes(y)) exactOrContain.push(m);
    else fuzzy.push({ market: m, score: overlapScore(y, teamN) });
  }

  if (exactOrContain.length === 1) return exactOrContain[0];
  if (exactOrContain.length > 1) {
    return exactOrContain.sort((a, b) => parseFp(b.liquidity_dollars) - parseFp(a.liquidity_dollars))[0];
  }

  const goodFuzzy = fuzzy.filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score);
  if (goodFuzzy.length === 1) return goodFuzzy[0].market;
  if (goodFuzzy.length > 1 && goodFuzzy[0].score - goodFuzzy[1].score >= 0.2) return goodFuzzy[0].market;

  return null;
}

function marketAskPrice(market) {
  const yesAsk = parseFp(market.yes_ask_dollars);
  if (yesAsk > 0) return yesAsk;
  const noBid = parseFp(market.no_bid_dollars);
  if (noBid > 0 && noBid < 1) return 1 - noBid;
  return null;
}

function settlementPnlUsd(settlement) {
  const revenue = Number(settlement.revenue || 0) / 100;
  const costYes = parseFp(settlement.yes_total_cost_dollars);
  const costNo = parseFp(settlement.no_total_cost_dollars);
  const fee = parseFp(settlement.fee_cost);
  return revenue - costYes - costNo - fee;
}

function computeDailyLossUsd(settlements, timezone) {
  const nowMs = Date.now();
  const todayKey = toISODateInTz(nowMs, timezone);

  let dailyPnl = 0;
  for (const s of settlements) {
    const ts = new Date(s.settled_time).getTime();
    if (!Number.isFinite(ts)) continue;
    const key = toISODateInTz(ts, timezone);
    if (key !== todayKey) continue;
    dailyPnl += settlementPnlUsd(s);
  }

  return dailyPnl < 0 ? Math.abs(dailyPnl) : 0;
}

function eligibleTradeCandidate(event, config, stateStore) {
  const game = extractGameState(event);
  if (!game) return null;
  if (!isLeagueAllowed(game.competition, config)) return null;
  if (game.minute < config.minTriggerMinute) return null;

  const inPost80Window = game.minute >= config.post80StartMinute;
  const requiredLead = inPost80Window ? config.post80MinGoalLead : config.minGoalLead;
  const stageMaxYesPrice = inPost80Window ? Math.min(config.maxYesPrice, config.post80MaxYesPrice) : config.maxYesPrice;

  if (!game.leadingTeam || game.goalDiff < requiredLead) return null;
  if (stateStore.hasTradedEvent(event.event_ticker)) return null;

  const market = pickMarketForLeadingTeam(event, game.leadingTeam, config);
  if (!market) return null;

  const ask = marketAskPrice(market);
  if (!ask || ask > stageMaxYesPrice) return null;

  return {
    event,
    game,
    market,
    ask,
  };
}

module.exports = {
  computeDailyLossUsd,
  eligibleTradeCandidate,
  marketAskPrice,
  extractGameState,
  isLeagueAllowed,
};
