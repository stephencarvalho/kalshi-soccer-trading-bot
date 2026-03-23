const { parseFp } = require('./kalshiClient');
const { toISODateInTz } = require('./stateStore');
const { isSoccerCompetitionName } = require('./kalshiLiveSoccer');
const { isRecoverySizingEligible } = require('./recoveryConditions');
const { parseTeamsFromEventTitle } = require('./teamTitleParser');

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
      const homeRedCards = Number.isFinite(Number(live.homeRedCards)) ? Number(live.homeRedCards) : null;
      const awayRedCards = Number.isFinite(Number(live.awayRedCards)) ? Number(live.awayRedCards) : null;
      const leadingTeamRedCards =
        leadingSide === 'home' ? homeRedCards : leadingSide === 'away' ? awayRedCards : null;
      const trailingTeamRedCards =
        leadingSide === 'home' ? awayRedCards : leadingSide === 'away' ? homeRedCards : null;
      const homeMaxLead = Number.isFinite(Number(live.homeMaxLead)) ? Number(live.homeMaxLead) : goalDiff;
      const awayMaxLead = Number.isFinite(Number(live.awayMaxLead)) ? Number(live.awayMaxLead) : goalDiff;
      const leadingTeamMaxLead =
        leadingSide === 'home' ? homeMaxLead : leadingSide === 'away' ? awayMaxLead : 0;
      return {
        minute: live.minute,
        homeScore: live.homeScore,
        awayScore: live.awayScore,
        goalDiff,
        leadingSide,
        leadingTeam,
        homeRedCards,
        awayRedCards,
        leadingTeamRedCards,
        trailingTeamRedCards,
        homeMaxLead,
        awayMaxLead,
        leadingTeamMaxLead,
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
  const homeRedCardKeys = ['home_red_cards', 'red_cards_home', 'home.red_cards', 'home_red_card_count'];
  const awayRedCardKeys = ['away_red_cards', 'red_cards_away', 'away.red_cards', 'away_red_card_count'];

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
  let homeRedCards = null;
  let awayRedCards = null;

  for (const [k, v] of Object.entries(flat)) {
    const key = k.toLowerCase();
    if (homeRedCards === null && homeRedCardKeys.some((x) => key.endsWith(x))) {
      const n = Number(v);
      if (Number.isFinite(n)) homeRedCards = n;
    }
    if (awayRedCards === null && awayRedCardKeys.some((x) => key.endsWith(x))) {
      const n = Number(v);
      if (Number.isFinite(n)) awayRedCards = n;
    }
    if (typeof v === 'string') {
      if (!homeTeam && homeTeamKeys.some((x) => key.endsWith(x))) homeTeam = v;
      if (!awayTeam && awayTeamKeys.some((x) => key.endsWith(x))) awayTeam = v;
    }
  }

  const fromTitle = parseTeamsFromEventTitle(event.title || event.sub_title || '');
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
  const leadingTeamRedCards =
    leadingSide === 'home' ? homeRedCards : leadingSide === 'away' ? awayRedCards : null;
  const trailingTeamRedCards =
    leadingSide === 'home' ? awayRedCards : leadingSide === 'away' ? homeRedCards : null;
  const homeMaxLead = leadingSide === 'home' ? goalDiff : 0;
  const awayMaxLead = leadingSide === 'away' ? goalDiff : 0;
  const leadingTeamMaxLead = goalDiff;

  return {
    minute,
    homeScore,
    awayScore,
    goalDiff,
    leadingSide,
    leadingTeam,
    homeRedCards,
    awayRedCards,
    leadingTeamRedCards,
    trailingTeamRedCards,
    homeMaxLead,
    awayMaxLead,
    leadingTeamMaxLead,
    competition: md.competition || null,
  };
}

function deriveSignalRule(game, config) {
  if (!game) return null;

  if (
    game.homeScore === game.awayScore &&
    game.minute >= config.post80StartMinute
  ) {
    return {
      id: `POST_${config.post80StartMinute}_TIE_YES`,
      requiredLead: 0,
      stageMaxYesPrice: Math.min(config.maxYesPrice, config.post80MaxYesPrice),
      bypassMinute: false,
      outcomeType: 'tie',
    };
  }

  if (!game.leadingTeam) return null;

  if ((game.goalDiff || 0) >= config.minGoalLead) {
    return {
      id: `CURRENT_LEAD_${config.minGoalLead}`,
      requiredLead: config.minGoalLead,
      stageMaxYesPrice: Math.min(config.maxYesPrice, config.anytimeLargeLeadMaxYesPrice),
      bypassMinute: false,
      outcomeType: 'leader',
    };
  }

  if (game.minute < config.minTriggerMinute) return null;

  if (game.minute >= config.post80StartMinute) {
    return {
      id: `POST_${config.post80StartMinute}_LEAD_${config.post80MinGoalLead}`,
      requiredLead: config.post80MinGoalLead,
      stageMaxYesPrice: Math.min(config.maxYesPrice, config.post80MaxYesPrice),
      bypassMinute: false,
      outcomeType: 'leader',
    };
  }

  return null;
}

function isLeagueAllowed(competition, config) {
  if (config.allLeagues) return isSoccerCompetitionName(competition);
  if (!competition) return false;
  const leagues = Array.isArray(config.leagues) ? config.leagues : [];
  const key = leagues.join('|');
  if (!config.__leagueSetCache || config.__leagueSetCache.key !== key) {
    config.__leagueSetCache = {
      key,
      set: new Set(leagues.map(normalize)),
    };
  }
  return config.__leagueSetCache.set.has(normalize(competition));
}

function marketIsMatchWinner(market) {
  const y = normalize(market.yes_sub_title || '');
  const n = normalize(market.no_sub_title || '');
  const combined = `${y} ${n}`;
  if (combined.includes('draw') || combined.includes('tie')) return false;
  return true;
}

function marketIsTieOutcome(market) {
  const yes = normalize(market?.yes_sub_title || '');
  return yes === 'tie' || yes === 'draw' || yes.includes(' tie') || yes.includes('draw');
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

function pickTieMarket(event) {
  const markets = (event.markets || [])
    .filter((market) => market.status === 'active')
    .filter((market) => marketIsTieOutcome(market))
    .sort((a, b) => parseFp(b.liquidity_dollars) - parseFp(a.liquidity_dollars));
  return markets[0] || null;
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

function settlementHasExposure(settlement) {
  const yesCount = Math.abs(parseFp(settlement?.yes_count_fp));
  const noCount = Math.abs(parseFp(settlement?.no_count_fp));
  const yesCost = Math.abs(parseFp(settlement?.yes_total_cost_dollars));
  const noCost = Math.abs(parseFp(settlement?.no_total_cost_dollars));
  const revenue = Math.abs(Number(settlement?.revenue || 0));
  const fee = Math.abs(parseFp(settlement?.fee_cost));
  return yesCount > 0 || noCount > 0 || yesCost > 0 || noCost > 0 || revenue > 0 || fee > 0;
}

function isIgnoredSettlement(settlement, ignoredTickers = []) {
  const ignored = new Set((ignoredTickers || []).map((x) => String(x)));
  const ticker = String(settlement?.ticker || '');
  const eventTicker = String(settlement?.event_ticker || '');
  return ignored.has(ticker) || ignored.has(eventTicker);
}

function computeDailyLossUsd(settlements, timezone, ignoredTickers = []) {
  const nowMs = Date.now();
  const todayKey = toISODateInTz(nowMs, timezone);

  let dailyPnl = 0;
  for (const s of settlements) {
    if (isIgnoredSettlement(s, ignoredTickers)) continue;
    if (!settlementHasExposure(s)) continue;
    const ts = new Date(s.settled_time).getTime();
    if (!Number.isFinite(ts)) continue;
    const key = toISODateInTz(ts, timezone);
    if (key !== todayKey) continue;
    dailyPnl += settlementPnlUsd(s);
  }

  return dailyPnl < 0 ? Math.abs(dailyPnl) : 0;
}

function isRecoveryTradeSetup(game) {
  if (!game?.leadingTeam) return false;
  return Number(game.minute || 0) >= 75 && Number(game.goalDiff || 0) >= 2;
}

function eligibleTradeCandidate(event, config, stateStore, options = {}) {
  const game = extractGameState(event);
  if (!game) return null;
  if (!isLeagueAllowed(game.competition, config)) return null;
  const signalRule = deriveSignalRule(game, config);
  if (!signalRule) return null;

  if (game.homeRedCards === null || game.awayRedCards === null) return null;
  if (!options.allowRepeatEvent && stateStore.hasTradedEvent(event.event_ticker)) return null;
  if (typeof stateStore.hasRecentEventRejection === 'function' && stateStore.hasRecentEventRejection(event.event_ticker)) return null;

  if (signalRule.outcomeType === 'tie') {
    if (game.homeScore !== game.awayScore) return null;
    if (game.homeRedCards !== game.awayRedCards) return null;

    const market = pickTieMarket(event);
    if (!market) return null;

    const ask = marketAskPrice(market);
    if (!ask || ask > signalRule.stageMaxYesPrice) return null;

    return {
      event,
      game,
      market,
      ask,
      signalRule,
      selectedOutcome: 'Tie',
      recoverySizingEligible: isRecoverySizingEligible({ game, signalRule }, config),
    };
  }

  if (!game.leadingTeam) return null;
  const signalLead = signalRule.bypassMinute ? game.leadingTeamMaxLead : game.goalDiff;
  if (signalLead < signalRule.requiredLead) return null;
  if (
    game.leadingTeamRedCards !== null &&
    game.trailingTeamRedCards !== null &&
    game.leadingTeamRedCards > game.trailingTeamRedCards
  ) {
    return null;
  }

  const market = pickMarketForLeadingTeam(event, game.leadingTeam, config);
  if (!market) return null;

  const ask = marketAskPrice(market);
  if (!ask || ask > signalRule.stageMaxYesPrice) return null;

  return {
    event,
    game,
    market,
    ask,
    signalRule,
    selectedOutcome: game.leadingTeam,
    recoverySizingEligible: isRecoverySizingEligible({ game, signalRule }, config),
  };
}

module.exports = {
  computeDailyLossUsd,
  eligibleTradeCandidate,
  deriveSignalRule,
  isRecoveryTradeSetup,
  marketAskPrice,
  extractGameState,
  isLeagueAllowed,
};
