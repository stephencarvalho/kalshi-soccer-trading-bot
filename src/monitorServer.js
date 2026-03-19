require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const { config } = require('./config');
const { createLogger } = require('./logger');
const { loadPrivateKey } = require('./kalshiAuth');
const { KalshiClient, parseFp } = require('./kalshiClient');
const { KalshiWebClient, resolveWebSessionAuth } = require('./kalshiWebClient');
const { toISODateInTz } = require('./stateStore');
const { getRuntimeConfig, readOverrides, OVERRIDES_PATH } = require('./runtimeConfig');
const { eligibleTradeCandidate, extractGameState, isLeagueAllowed, deriveSignalRule, marketAskPrice } = require('./strategy');
const {
  getLiveSoccerEventData,
  attachLiveDataToEvents,
  eventLooksLikeSoccer,
  resolveSoccerCompetitionScope,
} = require('./kalshiLiveSoccer');
const { buildRecoveryQueue, contractsForTargetNetProfit, totalCostForYesBuy } = require('./recoveryQueue');

const app = express();
app.use(cors());
app.use(express.json());

const logger = createLogger(config.logLevel);
const port = Number(process.env.MONITOR_PORT || 8787);
const logsPath = path.resolve('logs/trading-actions.ndjson');
const statePath = path.resolve(config.stateFile || 'data/state.json');
const VALID_AGENT_STATUSES = [
  'STARTING',
  'UP_TRADING',
  'UP_DRY_RUN',
  'UP_BLOCKED_STOP_LOSS',
  'UP_DEGRADED',
  'DOWN',
];
let logCache = {
  mtimeMs: 0,
  size: 0,
  parsed: [],
};

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const headerToken = String(req.headers['x-monitor-token'] || '').trim();
  return headerToken || '';
}

function requireMonitorAuth(req, res, next) {
  if (!config.monitorApiToken) return next();

  const token = extractBearerToken(req);
  if (token && token === config.monitorApiToken) return next();

  return res.status(401).json({
    ok: false,
    error: 'unauthorized',
    message: 'Valid monitor API token required',
  });
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function isIgnoredSettlement(settlement, ignoredTickers = []) {
  const ignored = new Set((ignoredTickers || []).map((x) => String(x)));
  const ticker = String(settlement?.ticker || '');
  const eventTicker = String(settlement?.event_ticker || '');
  return ignored.has(ticker) || ignored.has(eventTicker);
}

function readActionLogs(limit = null) {
  try {
    const stat = fs.statSync(logsPath);
    const changed = stat.mtimeMs !== logCache.mtimeMs || stat.size !== logCache.size;

    if (changed) {
      const lines = fs
        .readFileSync(logsPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      logCache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        parsed: lines.map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { ts: new Date().toISOString(), action: 'parse_error', raw: line };
          }
        }),
      };
    }

    const records = Number.isFinite(Number(limit)) ? logCache.parsed.slice(-Number(limit)) : logCache.parsed;

    return records.map((line) => {
      try {
        return typeof line === 'string' ? JSON.parse(line) : line;
      } catch {
        return { ts: new Date().toISOString(), action: 'parse_error', raw: line };
      }
    });
  } catch {
    return [];
  }
}

function settlementPnlUsd(settlement) {
  const revenue = Number(settlement.revenue || 0) / 100;
  const costYes = parseFp(settlement.yes_total_cost_dollars);
  const costNo = parseFp(settlement.no_total_cost_dollars);
  const fee = parseFp(settlement.fee_cost);
  return Number((revenue - costYes - costNo - fee).toFixed(4));
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

function safeRatio(n, d) {
  return d > 0 ? n / d : null;
}

function computeDerivedMetrics(actionLogs) {
  let totalCycles = 0;
  let totalOrderSubmit = 0;
  let totalFilled = 0;
  let totalNotFilled = 0;
  let totalErrors = 0;

  for (const x of actionLogs) {
    const action = x.action;
    if (action === 'cycle_evaluated') totalCycles += 1;
    else if (action === 'order_submit') totalOrderSubmit += 1;
    else if (action === 'order_filled') totalFilled += 1;
    else if (action === 'order_not_filled') totalNotFilled += 1;
    if (action === 'fatal_error' || String(action).endsWith('_error')) totalErrors += 1;
  }

  const fillRate = totalOrderSubmit > 0 ? totalFilled / totalOrderSubmit : 0;

  return {
    totalCycles,
    totalOrderSubmit,
    totalFilled,
    totalNotFilled,
    totalErrors,
    fillRate,
  };
}

function computeTradeAnalytics(closedTrades) {
  const ordered = [...closedTrades].sort((a, b) => new Date(a.settled_time).getTime() - new Date(b.settled_time).getTime());
  const winners = ordered.filter((t) => t.pnl_usd > 0);
  const losers = ordered.filter((t) => t.pnl_usd < 0);
  const pushes = ordered.filter((t) => t.pnl_usd === 0);

  const avgWinUsd = winners.length ? winners.reduce((a, b) => a + b.pnl_usd, 0) / winners.length : null;
  const avgLossAbsUsd = losers.length ? Math.abs(losers.reduce((a, b) => a + b.pnl_usd, 0) / losers.length) : null;
  const winRate = safeRatio(winners.length, winners.length + losers.length);
  const lossRate = safeRatio(losers.length, winners.length + losers.length);
  const avgRoiPct = ordered.length
    ? ordered
        .map((t) => t.roi_pct)
        .filter((x) => x !== null && Number.isFinite(x))
        .reduce((a, b) => a + b, 0) /
      Math.max(1, ordered.map((t) => t.roi_pct).filter((x) => x !== null && Number.isFinite(x)).length)
    : null;
  const avgWinnerRoiPct = winners.length
    ? winners
        .map((t) => t.roi_pct)
        .filter((x) => x !== null)
        .reduce((a, b) => a + b, 0) / Math.max(1, winners.map((t) => t.roi_pct).filter((x) => x !== null).length)
    : null;
  const avgLoserRoiPct = losers.length
    ? losers
        .map((t) => t.roi_pct)
        .filter((x) => x !== null)
        .reduce((a, b) => a + b, 0) / Math.max(1, losers.map((t) => t.roi_pct).filter((x) => x !== null).length)
    : null;
  const expectancyPerTradeUsd = ordered.length ? ordered.reduce((a, b) => a + b.pnl_usd, 0) / ordered.length : null;
  const totalPnlUsd = ordered.reduce((a, b) => a + b.pnl_usd, 0);
  const betsNeededToRecoverAvgLoss = avgLossAbsUsd && avgWinUsd && avgWinUsd > 0 ? Math.ceil(avgLossAbsUsd / avgWinUsd) : null;
  const winsRequiredToRecoverSingleLoss = betsNeededToRecoverAvgLoss;
  const winsRequiredToBreakeven = avgWinUsd && avgWinUsd > 0 && totalPnlUsd < 0
    ? Math.ceil(Math.abs(totalPnlUsd) / avgWinUsd)
    : 0;
  const breakevenWinRate = avgLossAbsUsd && avgWinUsd ? avgLossAbsUsd / (avgLossAbsUsd + avgWinUsd) : null;
  const payoffRatio = avgLossAbsUsd && avgWinUsd ? avgWinUsd / avgLossAbsUsd : null;

  const grossProfit = winners.reduce((a, b) => a + b.pnl_usd, 0);
  const grossLossAbs = Math.abs(losers.reduce((a, b) => a + b.pnl_usd, 0));
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : null;

  let runningPnl = 0;
  let peakPnl = 0;
  let maxDrawdownUsd = 0;
  for (const t of ordered) {
    runningPnl += t.pnl_usd;
    if (runningPnl > peakPnl) peakPnl = runningPnl;
    const drawdown = peakPnl - runningPnl;
    if (drawdown > maxDrawdownUsd) maxDrawdownUsd = drawdown;
  }

  const avgTotalCostUsd = ordered.length
    ? ordered.reduce((sum, t) => sum + (Number(t.total_cost_usd) || 0), 0) / ordered.length
    : null;

  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const t of ordered) {
    if (t.pnl_usd > 0) {
      currentWinStreak += 1;
      currentLossStreak = 0;
    } else if (t.pnl_usd < 0) {
      currentLossStreak += 1;
      currentWinStreak = 0;
    } else {
      currentWinStreak = 0;
      currentLossStreak = 0;
    }
    if (currentWinStreak > longestWinStreak) longestWinStreak = currentWinStreak;
    if (currentLossStreak > longestLossStreak) longestLossStreak = currentLossStreak;
  }

  const leagueMap = new Map();
  for (const t of ordered) {
    const league = t.placed_context?.competition || 'Unknown';
    if (!leagueMap.has(league)) {
      leagueMap.set(league, {
        league,
        trades: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        totalPnlUsd: 0,
        roiSum: 0,
        roiCount: 0,
      });
    }
    const row = leagueMap.get(league);
    row.trades += 1;
    if (t.pnl_usd > 0) row.wins += 1;
    else if (t.pnl_usd < 0) row.losses += 1;
    else row.pushes += 1;
    row.totalPnlUsd += t.pnl_usd;
    if (t.roi_pct !== null && Number.isFinite(t.roi_pct)) {
      row.roiSum += t.roi_pct;
      row.roiCount += 1;
    }
  }

  const leagueLeaderboard = Array.from(leagueMap.values())
    .map((r) => ({
      league: r.league,
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      pushes: r.pushes,
      winRate: safeRatio(r.wins, r.wins + r.losses),
      totalPnlUsd: Number(r.totalPnlUsd.toFixed(4)),
      avgRoiPct: r.roiCount > 0 ? r.roiSum / r.roiCount : null,
    }))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  return {
    settledTrades: ordered.length,
    winners: winners.length,
    losers: losers.length,
    pushes: pushes.length,
    winRate,
    avgWinnerRoiPct,
    avgLoserRoiPct,
    avgRoiPct,
    avgWinUsd,
    avgWinRoiUsd: avgWinUsd,
    avgLossAbsUsd,
    lossRate,
    betsNeededToRecoverAvgLoss,
    winsRequiredToRecoverSingleLoss,
    winsRequiredToBreakeven,
    breakevenWinRate,
    payoffRatio,
    profitFactor,
    expectancyPerTradeUsd,
    maxDrawdownUsd,
    avgTotalCostUsd,
    longestWinStreak,
    longestLossStreak,
    leagueLeaderboard,
  };
}

function computeRecoveryAnalytics(closedTrades, runtime) {
  const baseStake = Number(runtime.stakeUsd || 1);
  const queueState = buildRecoveryQueue(closedTrades || []);
  return {
    enabled: Boolean(runtime.recoveryModeEnabled),
    strategy: 'closed_loss_queue',
    baseStakeUsd: baseStake,
    currentLossStreak: queueState.currentLossStreak,
    recoveryLossBalanceUsd: Number(queueState.recoveryLossBalanceUsd.toFixed(4)),
    nextTargetProfitUsd: Number(queueState.nextTargetProfitUsd.toFixed(4)),
    unresolvedLossCount: queueState.unresolvedLossCount,
    queue: queueState.queue,
  };
}

function maxContractsWithinBudget(priceUsd, maxSpendUsd) {
  const budget = Number(maxSpendUsd || 0);
  if (!Number.isFinite(budget) || budget <= 0) return null;

  let candidateCount = 1;
  let latestAffordable = null;
  while (candidateCount <= 100000) {
    const candidateCostUsd = totalCostForYesBuy(candidateCount, priceUsd);
    if (candidateCostUsd === null || candidateCostUsd > budget + 1e-9) break;
    latestAffordable = candidateCount;
    candidateCount += 1;
  }
  return latestAffordable;
}

function canSizeCandidate(candidate, balanceUsd, runtime, recovery) {
  if (!candidate || !Number.isFinite(Number(balanceUsd))) return true;
  const ask = Number(candidate.ask || 0);
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return false;

  if (recovery?.enabled && Number(recovery.nextTargetProfitUsd || 0) > 0) {
    const targetProfitUsd = Number(recovery.nextTargetProfitUsd || 0);
    const sized = contractsForTargetNetProfit(ask, targetProfitUsd);
    const maxRecoverySpendUsd = Number(runtime.recoveryMaxStakeUsd || 0);
    const maxSpendUsd =
      Number.isFinite(maxRecoverySpendUsd) && maxRecoverySpendUsd > 0
        ? Math.min(maxRecoverySpendUsd, Number(balanceUsd))
        : Number(balanceUsd);
    if (sized && sized.totalCostUsd <= maxSpendUsd + 1e-9) return true;
    return Boolean(maxContractsWithinBudget(ask, maxSpendUsd));
  }

  const stakeUsd = Number(runtime.stakeUsd || 0);
  const maxSpendUsd = Math.min(stakeUsd, Number(balanceUsd));
  return Boolean(maxContractsWithinBudget(ask, maxSpendUsd));
}

function markPriceForPosition(position, market) {
  const qty = parseFp(position.position_fp);
  const yesBid = parseFp(market?.yes_bid_dollars);
  const noBid = parseFp(market?.no_bid_dollars);
  const lastYes = parseFp(market?.last_price_dollars);

  if (qty > 0) {
    if (yesBid > 0) return yesBid;
    if (lastYes > 0) return lastYes;
    return null;
  }

  if (qty < 0) {
    if (noBid > 0) return noBid;
    if (lastYes > 0 && lastYes < 1) return 1 - lastYes;
    return null;
  }

  return null;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTeamsFromEventTitle(title) {
  const text = String(title || '');
  const match = text.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\?|$)/i) || text.match(/^(.+?)\s+v\.?\s+(.+?)(?:\?|$)/i);
  if (!match) return { homeTeam: null, awayTeam: null };
  return {
    homeTeam: match[1].trim(),
    awayTeam: match[2].trim(),
  };
}

function buildMonitoredPrices(event) {
  const { homeTeam, awayTeam } = event?.__live || parseTeamsFromEventTitle(event?.title);
  const markets = (event?.markets || []).filter((market) => String(market?.status || '').toLowerCase() === 'active');
  const homeKey = normalizeText(homeTeam);
  const awayKey = normalizeText(awayTeam);
  const prices = {
    homeTeam: homeTeam || null,
    awayTeam: awayTeam || null,
    homeYesPrice: null,
    homeNoPrice: null,
    awayYesPrice: null,
    awayNoPrice: null,
    tieYesPrice: null,
    tieNoPrice: null,
  };

  for (const market of markets) {
    const subtitle = normalizeText(market?.yes_sub_title);
    const yesAsk = parseFp(market?.yes_ask_dollars);
    const noAsk = parseFp(market?.no_ask_dollars);
    const yesPrice = Number.isFinite(yesAsk) && yesAsk > 0
      ? yesAsk
      : marketAskPrice(market);
    const noPrice = Number.isFinite(noAsk) && noAsk > 0
      ? noAsk
      : (Number.isFinite(yesPrice) && yesPrice > 0 && yesPrice < 1 ? Number((1 - yesPrice).toFixed(4)) : null);

    if (homeKey && subtitle === homeKey) {
      prices.homeYesPrice = yesPrice;
      prices.homeNoPrice = noPrice;
    }
    if (awayKey && subtitle === awayKey) {
      prices.awayYesPrice = yesPrice;
      prices.awayNoPrice = noPrice;
    }
    if (subtitle === 'tie' || subtitle === 'draw') {
      prices.tieYesPrice = yesPrice;
      prices.tieNoPrice = noPrice;
    }
  }

  return prices;
}

function splitLogs(actionLogs) {
  const noisyActions = new Set(['cycle_started', 'cycle_evaluated']);
  const verbose = actionLogs.filter((x) => noisyActions.has(x.action));
  const important = actionLogs.filter((x) => !noisyActions.has(x.action));
  return { important, verbose };
}

function deriveRuleFromMinute(minute, runtime) {
  if (!Number.isFinite(Number(minute))) return 'UNKNOWN_RULE';
  return Number(minute) >= Number(runtime.post80StartMinute)
    ? `POST_${runtime.post80StartMinute}_LEAD_${runtime.post80MinGoalLead}`
    : `CURRENT_LEAD_${runtime.minGoalLead}`;
}

function inferCompetitionFromTicker(ticker) {
  const upper = String(ticker || '').toUpperCase();
  if (!upper) return null;
  if (upper.includes('UECLGAME')) return 'Conference League';
  if (upper.includes('UELGAME')) return 'Europa League';
  if (upper.includes('UCLGAME')) return 'Champions League';
  if (upper.includes('EPLGAME')) return 'EPL';
  if (upper.includes('MLSGAME')) return 'MLS';
  if (upper.includes('SPLGAME')) return 'Saudi Pro League';
  if (upper.includes('BUNGAME')) return 'Bundesliga';
  if (upper.includes('LALGAME')) return 'La Liga';
  if (upper.includes('SERAGAME') || upper.includes('SERIEAGAME')) return 'Serie A';
  if (upper.includes('BRAGAME') || upper.includes('BRASGAME')) return 'Brasileiro Serie A';
  if (upper.includes('ARGGAME') || upper.includes('ARGPGAME')) return 'Argentina Primera Division';
  if (upper.includes('FACUP')) return 'FA Cup';
  if (upper.includes('CDRGAME') || upper.includes('COPA')) return 'Copa del Rey';
  return null;
}

function buildPlacementContextByEvent(actionLogs, runtime) {
  const byEvent = new Map();
  for (const log of actionLogs) {
    if (log.action !== 'order_submit') continue;
    if (!log.eventTicker) continue;
    byEvent.set(log.eventTicker, {
      triggerRule: deriveRuleFromMinute(log.minute, runtime),
      placedMinute: log.minute ?? null,
      placedScore: log.score ?? null,
      placedCards: log.cards ?? null,
      placedLeaderVsTrailingCards: log.leaderVsTrailingCards ?? null,
      stakeUsdTarget: Number.isFinite(Number(log.stakeUsd)) ? Number(log.stakeUsd) : null,
      targetProfitUsd: Number.isFinite(Number(log.targetProfitUsd)) ? Number(log.targetProfitUsd) : null,
      recoveryQueueId: log.recoveryQueueId || null,
      recoveryRemainingUsd: Number.isFinite(Number(log.recoveryRemainingUsd)) ? Number(log.recoveryRemainingUsd) : null,
      recoverySourceLossUsd: Number.isFinite(Number(log.recoverySourceLossUsd)) ? Number(log.recoverySourceLossUsd) : null,
      recoverySourceEventTitle: log.recoverySourceEventTitle || null,
      sizingMode: log.sizingMode || null,
      leadingTeam: log.leadingTeam ?? null,
      leadingTeamMaxLead: Number.isFinite(Number(log.leadingTeamMaxLead)) ? Number(log.leadingTeamMaxLead) : null,
      competition: log.competition ?? null,
      selectedOutcome: log.selectedOutcome || log.leadingTeam || null,
      markedAt: log.ts || null,
      marketTicker: log.marketTicker || null,
      yesPrice: Number.isFinite(Number(log.ask)) ? Number(log.ask) : null,
      fillCount: Number.isFinite(Number(log.count)) ? Number(log.count) : null,
    });
  }
  return byEvent;
}

function mergePlacementContext(stateCtx, logCtx) {
  if (!stateCtx && !logCtx) return null;
  return {
    ...(stateCtx || {}),
    ...(logCtx || {}),
    triggerRule: stateCtx?.triggerRule || logCtx?.triggerRule || null,
    placedMinute: stateCtx?.placedMinute ?? logCtx?.placedMinute ?? null,
    placedScore: stateCtx?.placedScore || logCtx?.placedScore || null,
    placedCards: stateCtx?.placedCards || logCtx?.placedCards || null,
    placedLeaderVsTrailingCards:
      stateCtx?.placedLeaderVsTrailingCards || logCtx?.placedLeaderVsTrailingCards || null,
    stakeUsdTarget: stateCtx?.stakeUsdTarget ?? logCtx?.stakeUsdTarget ?? null,
    targetProfitUsd: stateCtx?.targetProfitUsd ?? logCtx?.targetProfitUsd ?? null,
    recoveryQueueId: stateCtx?.recoveryQueueId || logCtx?.recoveryQueueId || null,
    recoveryRemainingUsd: stateCtx?.recoveryRemainingUsd ?? logCtx?.recoveryRemainingUsd ?? null,
    recoverySourceLossUsd: stateCtx?.recoverySourceLossUsd ?? logCtx?.recoverySourceLossUsd ?? null,
    recoverySourceEventTitle: stateCtx?.recoverySourceEventTitle || logCtx?.recoverySourceEventTitle || null,
    sizingMode: stateCtx?.sizingMode || logCtx?.sizingMode || null,
    leadingTeam: stateCtx?.leadingTeam || logCtx?.leadingTeam || null,
    leadingTeamMaxLead: stateCtx?.leadingTeamMaxLead ?? logCtx?.leadingTeamMaxLead ?? null,
    competition: stateCtx?.competition || logCtx?.competition || null,
    selectedOutcome: stateCtx?.selectedOutcome || logCtx?.selectedOutcome || null,
    markedAt: stateCtx?.markedAt || logCtx?.markedAt || null,
    yesPrice: stateCtx?.yesPrice ?? logCtx?.yesPrice ?? null,
    fillCount: stateCtx?.fillCount ?? logCtx?.fillCount ?? null,
  };
}

function isSoccerClosedTrade(trade) {
  return String(trade?.event_ticker || '').includes('GAME');
}

function computeAgentStatus({ actionLogs, state, runtime }) {
  const nowMs = Date.now();
  const todayKey = toISODateInTz(nowMs, config.timezone);
  const pollMs = Math.max(5, Number(runtime.pollSeconds || config.pollSeconds || 10)) * 1000;
  const staleThresholdMs = pollMs * 4 + 15000;
  const lastCycleMs = state.lastCycleAt ? new Date(state.lastCycleAt).getTime() : null;
  const riskHalted = actionLogs.some((x) => x.action === 'risk_halt' && toISODateInTz(new Date(x.ts).getTime(), config.timezone) === todayKey);
  const lastErr = [...actionLogs].reverse().find((x) => x.action === 'cycle_error' || x.action === 'fatal_error');

  if (!lastCycleMs || !Number.isFinite(lastCycleMs)) {
    const startedLog = [...actionLogs].reverse().find((x) => x.action === 'cycle_started');
    const startedMs = startedLog ? new Date(startedLog.ts).getTime() : null;
    if (startedMs && Number.isFinite(startedMs) && nowMs - startedMs < staleThresholdMs) {
      return {
        status: 'STARTING',
        reason: 'Bot process started and waiting for first completed cycle',
        lastError: lastErr?.message || null,
      };
    }
    return {
      status: 'DOWN',
      reason: 'No completed cycles recorded',
      lastError: lastErr?.message || null,
    };
  }

  if (nowMs - lastCycleMs > staleThresholdMs) {
    return {
      status: 'DOWN',
      reason: 'Heartbeat stale; no recent cycle updates',
      lastError: lastErr?.message || null,
    };
  }

  if (riskHalted) {
    return {
      status: 'UP_BLOCKED_STOP_LOSS',
      reason: 'Daily stop-loss reached; trade execution blocked',
      lastError: lastErr?.message || null,
    };
  }

  if (!runtime.tradingEnabled) {
    return {
      status: 'UP_DEGRADED',
      reason: 'Trading paused by runtime override',
      lastError: lastErr?.message || null,
    };
  }

  if (runtime.dryRun) {
    return {
      status: 'UP_DRY_RUN',
      reason: 'Bot is running in dry-run mode',
      lastError: lastErr?.message || null,
    };
  }

  if (lastErr) {
    const errTsMs = new Date(lastErr.ts).getTime();
    if (Number.isFinite(errTsMs) && nowMs - errTsMs < staleThresholdMs) {
      return {
        status: 'UP_DEGRADED',
        reason: 'Recent cycle error detected',
        lastError: lastErr?.message || null,
      };
    }
  }

  return {
    status: 'UP_TRADING',
    reason: 'Bot is healthy and eligible to execute trades',
    lastError: lastErr?.message || null,
  };
}

function getClient() {
  if (!config.keyId) return null;
  try {
    const privateKey = loadPrivateKey({
      privateKeyPath: config.privateKeyPath,
      privateKeyPem: config.privateKeyPem,
    });

    return new KalshiClient({
      baseUrl: config.baseUrl,
      keyId: config.keyId,
      privateKey,
      logger,
    });
  } catch {
    return null;
  }
}

function getWebClient() {
  const auth = resolveWebSessionAuth(config);
  if (!auth) return null;
  try {
    return new KalshiWebClient({
      userId: auth.userId,
      sessionCookie: auth.sessionCookie,
      csrfToken: auth.csrfToken,
      logger,
    });
  } catch {
    return null;
  }
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function computeInvestedCapital(deposits, startDate) {
  const appliedFromMs = parseIsoMs(startDate);
  const eligibleDeposits = (deposits || []).filter((deposit) => {
    const createdMs = parseIsoMs(deposit.created_ts);
    return appliedFromMs === null || (createdMs !== null && createdMs >= appliedFromMs);
  });

  let investedUsd = 0;
  for (const deposit of eligibleDeposits) {
    if (String(deposit.status || '').toLowerCase() === 'applied') {
      investedUsd += Number(deposit.amount_cents || 0) / 100;
      continue;
    }

    if (String(deposit.immediate_status || '').toLowerCase() === 'applied') {
      investedUsd += Number(deposit.immediate_amount || 0) / 100;
    }
  }

  return Number(investedUsd.toFixed(2));
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/dashboard', requireMonitorAuth, async (_req, res) => {
  const runtime = getRuntimeConfig(config);
  const actionLogs = readActionLogs();
  const { important: importantLogs, verbose: verboseLogs } = splitLogs(actionLogs);
  const placementContextByEvent = buildPlacementContextByEvent(actionLogs, runtime);
  const state = safeReadJson(statePath, {});
  const agentStatus = computeAgentStatus({ actionLogs, state, runtime });

  const client = getClient();

  let balanceUsd = null;
  let portfolioValueUsd = null;
  let openPositions = [];
  let settlements = [];
  let events = [];
  let liveSoccerMap = new Map();
  let investedCapitalUsd = null;
  let investedCapitalStartDate = config.investedStartDate;
  let investedCapitalSource = 'unavailable';

  if (client) {
    try {
      const [balanceResp, positionsResp, settlementsResp] = await Promise.all([
        client.getBalance(),
        client.getOpenPositions(),
        client.getSettlements(0, Math.floor(Date.now() / 1000)),
      ]);

      balanceUsd = Number(((balanceResp.balance || 0) / 100).toFixed(2));
      portfolioValueUsd = Number(((balanceResp.portfolio_value || 0) / 100).toFixed(2));
      openPositions = positionsResp || [];
      settlements = settlementsResp || [];
      events = await client.getOpenEventsWithMarkets();
      const liveCompetitionScope = await resolveSoccerCompetitionScope(client, events, runtime.leagues || [], logger);
      liveSoccerMap = await getLiveSoccerEventData(client, liveCompetitionScope);
      events = attachLiveDataToEvents(events, liveSoccerMap);
    } catch (error) {
      logger.warn({ err: error.message }, 'Dashboard API failed to fetch account data');
    }
  }

  const webClient = getWebClient();
  if (webClient) {
    try {
      const deposits = await webClient.getDeposits();
      investedCapitalUsd = computeInvestedCapital(deposits, config.investedStartDate);
      investedCapitalSource = 'kalshi_deposits';
    } catch (error) {
      logger.warn({ err: error.message }, 'Dashboard API failed to fetch Kalshi deposit history');
    }
  }

  const todayKey = toISODateInTz(Date.now(), config.timezone);
  const ignoredSettlementTickers = runtime.ignoredSettlementTickers || config.ignoredSettlementTickers || [];
  const filteredSettlements = settlements.filter(
    (s) => !isIgnoredSettlement(s, ignoredSettlementTickers) && settlementHasExposure(s),
  );
  const closedTrades = filteredSettlements
    .map((s) => ({
      ticker: s.ticker,
      event_ticker: s.event_ticker,
      market_result: s.market_result,
      yes_count_fp: s.yes_count_fp,
      no_count_fp: s.no_count_fp,
      revenue_cents: s.revenue,
      fee_cost: s.fee_cost,
      settled_time: s.settled_time,
      pnl_usd: settlementPnlUsd(s),
      total_cost_usd: parseFp(s.yes_total_cost_dollars) + parseFp(s.no_total_cost_dollars),
      amount_bet_usd: parseFp(s.yes_total_cost_dollars) + parseFp(s.no_total_cost_dollars),
      total_return_usd: Number((Number(s.revenue || 0) / 100).toFixed(4)),
      roi_pct: null,
      placed_context: mergePlacementContext(
        (state.tradedEvents || {})[s.event_ticker],
        placementContextByEvent.get(s.event_ticker),
      ),
    }))
    .sort((a, b) => new Date(b.settled_time).getTime() - new Date(a.settled_time).getTime());

  for (const t of closedTrades) {
    t.roi_pct = t.total_cost_usd > 0 ? t.pnl_usd / t.total_cost_usd : null;
    if (!t.placed_context) t.placed_context = {};
    if (!t.placed_context.competition) {
      t.placed_context.competition = inferCompetitionFromTicker(t.ticker) || 'Unknown';
    }
  }

  const pnlToday = closedTrades
    .filter((t) => toISODateInTz(new Date(t.settled_time).getTime(), config.timezone) === todayKey)
    .reduce((acc, t) => acc + t.pnl_usd, 0);
  const settledTickerSet = new Set(closedTrades.map((t) => t.ticker).filter(Boolean));

  const marketTickers = (openPositions || []).map((p) => p.ticker).filter(Boolean);
  const marketBooks = client && marketTickers.length ? await client.getMarketsByTickers(marketTickers) : [];
  const marketMap = new Map(marketBooks.map((m) => [m.ticker, m]));
  const eventTitleMap = new Map((events || []).map((e) => [e.event_ticker, e.title]));
  const eventMap = new Map((events || []).map((e) => [e.event_ticker, e]));

  const openTrades = (openPositions || [])
    .filter((p) => Math.abs(parseFp(p.position_fp)) > 0)
    .filter((p) => !settledTickerSet.has(p.ticker))
    .map((p) => {
    const qty = parseFp(p.position_fp);
    const absQty = Math.abs(qty);
    const costBasisUsd = Math.abs(parseFp(p.market_exposure_dollars));
    const entryContractCostUsd = absQty > 0 ? Number((costBasisUsd / absQty).toFixed(4)) : null;
    const market = marketMap.get(p.ticker);
    const marketStatus = market?.status ? String(market.status).toLowerCase() : 'unknown';
    const eventTicker = p.event_ticker || market?.event_ticker || null;
    const eventTitle = eventTicker ? eventTitleMap.get(eventTicker) || null : null;
    const event = eventTicker ? eventMap.get(eventTicker) || null : null;
    const game = event ? extractGameState(event) : null;
    const markPrice = markPriceForPosition(p, market);
    const markValueUsd = markPrice !== null ? absQty * markPrice : null;
    const unrealizedPnlUsd = markValueUsd !== null ? markValueUsd - costBasisUsd : null;
    const unrealizedRoiPct = unrealizedPnlUsd !== null && costBasisUsd > 0 ? unrealizedPnlUsd / costBasisUsd : null;
    const side = qty >= 0 ? 'YES' : 'NO';
    const selectionLabel = side === 'YES' ? market?.yes_sub_title || null : market?.no_sub_title || null;

    const placedContextRaw = eventTicker
      ? mergePlacementContext(
          (state.tradedEvents || {})[eventTicker],
          placementContextByEvent.get(eventTicker),
        )
      : null;
    const placedContext = placedContextRaw
      ? {
          ...placedContextRaw,
          yesPrice: entryContractCostUsd ?? placedContextRaw.yesPrice ?? null,
        }
      : null;

    return {
      ticker: p.ticker,
      event_ticker: eventTicker,
      event_title: eventTitle,
      selection_label: selectionLabel,
      market_title: market?.title || null,
      market_status: marketStatus,
      position_fp: p.position_fp,
      side,
      quantity: absQty,
      cost_basis_usd: Number(costBasisUsd.toFixed(4)),
      amount_bet_usd: Number(costBasisUsd.toFixed(4)),
      current_score: game ? `${game.homeScore}-${game.awayScore}` : null,
      current_contract_cost_usd: markPrice !== null ? Number(markPrice.toFixed(4)) : null,
      mark_price: markPrice !== null ? Number(markPrice.toFixed(4)) : null,
      mark_value_usd: markValueUsd !== null ? Number(markValueUsd.toFixed(4)) : null,
      total_return_usd: markValueUsd !== null ? Number(markValueUsd.toFixed(4)) : null,
      unrealized_pnl_usd: unrealizedPnlUsd !== null ? Number(unrealizedPnlUsd.toFixed(4)) : null,
      unrealized_roi_pct: unrealizedRoiPct !== null ? Number(unrealizedRoiPct.toFixed(6)) : null,
      realized_pnl_dollars: parseFp(p.realized_pnl_dollars),
      fees_paid_dollars: parseFp(p.fees_paid_dollars),
      last_updated_ts: p.last_updated_ts || null,
      placed_context: placedContext,
    };
    })
    .filter(Boolean);
  const metrics = {
    ...computeDerivedMetrics(actionLogs),
    totalBetsPlaced: openTrades.length + closedTrades.length,
  };
  const openUnrealizedPnlUsd = Number(
    openTrades.reduce((acc, t) => acc + (t.unrealized_pnl_usd || 0), 0).toFixed(4),
  );
  const openCostBasisUsd = Number(
    openTrades.reduce((acc, t) => acc + (t.cost_basis_usd || 0), 0).toFixed(4),
  );
  const openRoiPct = openCostBasisUsd > 0 ? Number((openUnrealizedPnlUsd / openCostBasisUsd).toFixed(6)) : null;
  const strategyClosedTrades = closedTrades.filter(isSoccerClosedTrade);
  const analytics = computeTradeAnalytics(strategyClosedTrades);
  const recovery = computeRecoveryAnalytics(strategyClosedTrades, runtime);

  const closedTradesWithRecovery = closedTrades.map((t) => ({
    ...t,
    wins_to_recover_at_avg_win:
      analytics.avgWinUsd && analytics.avgWinUsd > 0 && t.pnl_usd < 0
        ? Math.ceil(Math.abs(t.pnl_usd) / analytics.avgWinUsd)
        : null,
  }));

  const tradedEventsMap = state.tradedEvents || {};
  const monitoredGames = Array.from(liveSoccerMap.entries())
    .map(([eventTicker, live]) => {
      if (!live?.isLive) return null;

      const event = eventMap.get(eventTicker) || null;
      const competition = live.competition || event?.product_metadata?.competition || null;
      if (!isLeagueAllowed(competition, runtime)) return null;
      if (event && !eventLooksLikeSoccer(event, liveSoccerMap)) return null;

      const title = event?.title || live.title || eventTicker;
      const prices = event ? buildMonitoredPrices(event) : {
        ...parseTeamsFromEventTitle(title),
        homeYesPrice: null,
        homeNoPrice: null,
        awayYesPrice: null,
        awayNoPrice: null,
        tieYesPrice: null,
        tieNoPrice: null,
      };
      const game = event ? extractGameState(event) : {
        competition,
        minute: live.minute,
        homeScore: live.homeScore,
        awayScore: live.awayScore,
        homeRedCards: live.homeRedCards,
        awayRedCards: live.awayRedCards,
        homeTeam: prices.homeTeam,
        awayTeam: prices.awayTeam,
        leadingTeam:
          live.homeScore > live.awayScore ? prices.homeTeam :
          live.awayScore > live.homeScore ? prices.awayTeam :
          null,
        trailingTeam:
          live.homeScore > live.awayScore ? prices.awayTeam :
          live.awayScore > live.homeScore ? prices.homeTeam :
          null,
        goalDiff:
          Number.isFinite(live.homeScore) && Number.isFinite(live.awayScore)
            ? Math.abs(live.homeScore - live.awayScore)
            : null,
        leadingTeamRedCards:
          live.homeScore > live.awayScore ? live.homeRedCards :
          live.awayScore > live.homeScore ? live.awayRedCards :
          null,
        trailingTeamRedCards:
          live.homeScore > live.awayScore ? live.awayRedCards :
          live.awayScore > live.homeScore ? live.homeRedCards :
          null,
        leadingTeamMaxLead:
          live.homeScore > live.awayScore ? live.homeMaxLead :
          live.awayScore > live.homeScore ? live.awayMaxLead :
          0,
      };

      if (!game || !Number.isFinite(game.minute) || game.homeScore === null || game.awayScore === null) {
        return {
          eventTicker,
          title,
          competition: competition || '-',
          minute: null,
          score: '-',
          homeTeam: prices.homeTeam,
          awayTeam: prices.awayTeam,
          homeYesPrice: prices.homeYesPrice,
          homeNoPrice: prices.homeNoPrice,
          awayYesPrice: prices.awayYesPrice,
          awayNoPrice: prices.awayNoPrice,
          tieYesPrice: prices.tieYesPrice,
          tieNoPrice: prices.tieNoPrice,
          redCards: null,
          leadingVsTrailingRedCards: null,
          leadingTeam: '-',
          goalDiff: null,
          status: 'NO_LIVE_DATA',
          reason: 'Kalshi live feed currently has no usable minute/score fields for this game',
        };
      }

      const alreadyBet = Boolean(tradedEventsMap[eventTicker]);
      const candidate = event ? eligibleTradeCandidate(event, runtime, { hasTradedEvent: () => alreadyBet }) : null;
      const hasOrderCapacity = candidate ? canSizeCandidate(candidate, balanceUsd, runtime, recovery) : false;

      let status = 'WATCHING';
      let reason = 'Tracking game conditions';

      if (!event) {
        reason = 'Live soccer feed game found, but no open tradable Kalshi game market is attached yet';
      } else if (alreadyBet) {
        status = 'ALREADY_BET';
        reason = 'Bot has already placed a filled trade on this event';
      } else if (candidate && !hasOrderCapacity) {
        status = 'ELIGIBLE_NO_CAPACITY';
        reason = 'Signal passes, but current balance or stake cap cannot size a valid order';
      } else if (candidate) {
        status = 'ELIGIBLE_NOW';
        reason = 'Signal and market filters currently pass';
      } else if (game.homeScore === game.awayScore && game.minute >= runtime.post80StartMinute) {
        if (game.homeRedCards === null || game.awayRedCards === null) {
          reason = 'Waiting for red-card data before allowing a late tie trade';
        } else if (game.homeRedCards !== game.awayRedCards) {
          status = 'FILTERED';
          reason = 'Late tie trades require equal red cards for both teams';
        } else if (!event) {
          reason = 'Late tie signal may qualify, but no open tradable Kalshi game market is attached yet';
        } else {
          status = 'FILTERED';
          reason = `Late tie signal failed price cap ${Math.round(Math.min(runtime.maxYesPrice, runtime.post80MaxYesPrice) * 100)}c or no matching Tie market`;
        }
      } else if (!game.leadingTeam) {
        reason = 'No leading team currently';
      } else if (game.homeRedCards === null || game.awayRedCards === null) {
        reason = 'Waiting for red-card data before allowing a trade';
      } else if (
        game.leadingTeamRedCards !== null &&
        game.trailingTeamRedCards !== null &&
        game.leadingTeamRedCards > game.trailingTeamRedCards
      ) {
        status = 'FILTERED';
        reason = 'Leading team has more red cards than trailing team';
      } else if (game.goalDiff < runtime.minGoalLead) {
        if (game.minute >= runtime.post80StartMinute && game.goalDiff < runtime.post80MinGoalLead) {
          reason = `Need lead >= ${runtime.post80MinGoalLead} after minute ${runtime.post80StartMinute}`;
        } else {
          reason = `Need current leader to be ahead by at least ${runtime.minGoalLead} goals`;
        }
      } else if (!event) {
        reason = 'Signal may qualify, but no open tradable Kalshi game market is attached yet';
      } else {
        status = 'FILTERED';
        reason = `Current ${runtime.minGoalLead}+ goal lead signal failed price/market cap ${Math.round(
          Math.min(runtime.maxYesPrice, runtime.anytimeLargeLeadMaxYesPrice) * 100,
        )}c or no matching team-winner market`;
      }

      return {
        eventTicker,
        title,
        competition: game.competition || competition || '-',
        minute: game.minute,
        score: `${game.homeScore}-${game.awayScore}`,
        homeTeam: prices.homeTeam,
        awayTeam: prices.awayTeam,
        homeYesPrice: prices.homeYesPrice,
        homeNoPrice: prices.homeNoPrice,
        awayYesPrice: prices.awayYesPrice,
        awayNoPrice: prices.awayNoPrice,
        tieYesPrice: prices.tieYesPrice,
        tieNoPrice: prices.tieNoPrice,
        redCards:
          game.homeRedCards !== null && game.awayRedCards !== null
            ? `${game.homeRedCards}-${game.awayRedCards}`
            : null,
        leadingVsTrailingRedCards:
          game.leadingTeamRedCards !== null && game.trailingTeamRedCards !== null
            ? `${game.leadingTeamRedCards}-${game.trailingTeamRedCards}`
            : null,
        leadingTeam: game.leadingTeam || '-',
        goalDiff: game.goalDiff,
        status,
        reason,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.minute ?? -1) - (a.minute ?? -1));

  res.json({
    generatedAt: new Date().toISOString(),
    config: {
      dryRun: runtime.dryRun,
      tradingEnabled: runtime.tradingEnabled,
      stakeUsd: runtime.stakeUsd,
      maxYesPrice: runtime.maxYesPrice,
      minTriggerMinute: runtime.minTriggerMinute,
      minGoalLead: runtime.minGoalLead,
      retryUntilMinute: runtime.retryUntilMinute,
      minVolume24hContracts: runtime.minVolume24hContracts,
      minLiquidityDollars: runtime.minLiquidityDollars,
      maxDailyLossUsd: runtime.maxDailyLossUsd,
      recoveryModeEnabled: runtime.recoveryModeEnabled,
      recoveryStakeUsd: runtime.recoveryStakeUsd,
      recoveryMaxStakeUsd: runtime.recoveryMaxStakeUsd,
      leagues: runtime.leagues,
      timezone: config.timezone,
      runtimeOverridesPath: OVERRIDES_PATH,
      runtimeOverrides: readOverrides(),
      ignoredSettlementTickers,
    },
    account: {
      balanceUsd,
      portfolioValueUsd,
      investedCapitalUsd,
      investedCapitalStartDate,
      investedCapitalSource,
      openPositionsCount: openTrades.length,
      pnlTodayUsd: Number(pnlToday.toFixed(2)),
      pnl14dUsd: Number(closedTrades.reduce((a, b) => a + b.pnl_usd, 0).toFixed(2)),
      openUnrealizedPnlUsd,
      openCostBasisUsd,
      openRoiPct,
    },
    bot: {
      lastCycleAt: state.lastCycleAt || null,
      tradedEventsCount: Object.keys(state.tradedEvents || {}).length,
      riskHaltedToday: actionLogs.some((x) => x.action === 'risk_halt' && toISODateInTz(new Date(x.ts).getTime(), config.timezone) === todayKey),
      status: agentStatus.status,
      statusReason: agentStatus.reason,
      lastError: agentStatus.lastError,
      currentStakeUsd: runtime.stakeUsd,
      recoveryLossStreak: recovery.currentLossStreak,
      recoveryLossBalanceUsd: recovery.recoveryLossBalanceUsd,
      validStatuses: VALID_AGENT_STATUSES,
    },
    metrics,
    analytics,
    recovery,
    leagueLeaderboard: analytics.leagueLeaderboard,
    monitoredGamesSummary: {
      total: monitoredGames.length,
      eligibleNow: monitoredGames.filter((g) => g.status === 'ELIGIBLE_NOW').length,
      alreadyBet: monitoredGames.filter((g) => g.status === 'ALREADY_BET').length,
      noLiveData: monitoredGames.filter((g) => g.status === 'NO_LIVE_DATA').length,
    },
    monitoredGames: monitoredGames.slice(0, 300),
    recentLogs: [...importantLogs].reverse(),
    recentCycleLogs: verboseLogs.slice(-100).reverse(),
    openTrades,
    closedTrades: closedTradesWithRecovery.slice(0, 200),
  });
});

app.listen(port, () => {
  logger.info({ port }, 'Monitor API server listening');
});
