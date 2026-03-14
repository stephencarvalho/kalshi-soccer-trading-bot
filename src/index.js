require('dotenv').config();

const { config } = require('./config');
const { createLogger } = require('./logger');
const { loadPrivateKey } = require('./kalshiAuth');
const { KalshiClient, parseFp } = require('./kalshiClient');
const { StateStore } = require('./stateStore');
const { eligibleTradeCandidate, computeDailyLossUsd, deriveSignalRule } = require('./strategy');
const { Notifier } = require('./notifier');
const { appendAction, LOG_PATH } = require('./actionLog');
const { getRuntimeConfig } = require('./runtimeConfig');
const {
  getLiveSoccerEventData,
  attachLiveDataToEvents,
  resolveSoccerCompetitionScope,
} = require('./kalshiLiveSoccer');

const logger = createLogger(config.logLevel);
const notifier = new Notifier(config, logger);
const stateStore = new StateStore(config.stateFile);
stateStore.load();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settlementPnlUsd(settlement) {
  const revenue = Number(settlement.revenue || 0) / 100;
  const costYes = parseFp(settlement.yes_total_cost_dollars);
  const costNo = parseFp(settlement.no_total_cost_dollars);
  const fee = parseFp(settlement.fee_cost);
  return revenue - costYes - costNo - fee;
}

function isIgnoredSettlement(settlement, ignoredTickers = []) {
  const ignored = new Set((ignoredTickers || []).map((x) => String(x)));
  const ticker = String(settlement?.ticker || '');
  const eventTicker = String(settlement?.event_ticker || '');
  return ignored.has(ticker) || ignored.has(eventTicker);
}

function buildStakeLadder(runtime) {
  const baseStake = Number(runtime.stakeUsd || 1);
  const maxStake = Math.max(baseStake, Number(runtime.recoveryMaxStakeUsd || 16));
  const ladder = [baseStake];
  let s = Math.max(baseStake, Number(runtime.recoveryStakeUsd || 2));
  while (s <= maxStake + 1e-9) {
    if (!ladder.includes(Number(s.toFixed(2)))) ladder.push(Number(s.toFixed(2)));
    s *= 2;
  }
  return ladder.sort((a, b) => a - b);
}

function roundToLadderStake(stakeUsd, ladder) {
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0 || !ladder.length) return null;
  let nearest = ladder[0];
  for (const s of ladder) {
    if (Math.abs(s - stakeUsd) < Math.abs(nearest - stakeUsd)) nearest = s;
  }
  return nearest;
}

function deriveStakeTierForSettlement(settlement, stateStore, ladder) {
  const meta = stateStore.getTradeMeta(settlement.event_ticker);
  const explicit = Number(meta?.stakeUsdTarget);
  if (Number.isFinite(explicit) && explicit > 0) return roundToLadderStake(explicit, ladder);
  const fallback = Number(parseFp(settlement.yes_total_cost_dollars) + parseFp(settlement.no_total_cost_dollars));
  return roundToLadderStake(fallback, ladder);
}

function deriveStakeTierForOpenPosition(position, stateStore, ladder) {
  const marketTicker = String(position?.ticker || '');
  const eventMeta = stateStore.findTradeMetaByMarketTicker(marketTicker);
  const explicit = Number(eventMeta?.stakeUsdTarget);
  if (Number.isFinite(explicit) && explicit > 0) return roundToLadderStake(explicit, ladder);
  const fallback = Math.abs(parseFp(position.market_exposure_dollars));
  return roundToLadderStake(fallback, ladder);
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

function computeRecoveryState(settlements, openPositions, openMarketMap, stateStore, runtime) {
  const baseStake = Number(runtime.stakeUsd || 1);
  const ladder = buildStakeLadder(runtime);
  const recoveryStake = ladder[1] || Math.max(baseStake, Number(runtime.recoveryStakeUsd || 2));
  if (!runtime.recoveryModeEnabled) {
    return {
      enabled: false,
      baseStakeUsd: baseStake,
      recoveryStakeUsd: recoveryStake,
      recoveryMaxStakeUsd: Math.max(...ladder),
      ladder,
      recoveryLossBalanceUsd: 0,
      nextStakeUsd: baseStake,
      perTier: {},
    };
  }

  const orderedSettlements = (settlements || [])
    .filter((s) => !isIgnoredSettlement(s, runtime.ignoredSettlementTickers || []))
    .filter((s) => stateStore.hasTradedEvent(s.event_ticker))
    .sort((a, b) => new Date(a.settled_time).getTime() - new Date(b.settled_time).getTime());

  const lossesByTier = {};
  const offsetsByTier = {};
  for (const s of ladder) {
    lossesByTier[s] = 0;
    offsetsByTier[s] = 0;
  }

  for (const s of orderedSettlements) {
    const tier = deriveStakeTierForSettlement(s, stateStore, ladder);
    if (!tier) continue;
    const pnl = settlementPnlUsd(s);
    if (pnl < 0) lossesByTier[tier] += Math.abs(pnl);
    else offsetsByTier[tier] += pnl;
  }

  const activeOpen = (openPositions || []).filter((p) => Math.abs(parseFp(p.position_fp)) > 0);
  for (const p of activeOpen) {
    const tier = deriveStakeTierForOpenPosition(p, stateStore, ladder);
    if (!tier) continue;
    const market = openMarketMap.get(p.ticker);
    const markPrice = markPriceForPosition(p, market);
    if (markPrice === null) continue;
    const qty = Math.abs(parseFp(p.position_fp));
    const cost = Math.abs(parseFp(p.market_exposure_dollars));
    const markValue = qty * markPrice;
    const pnl = markValue - cost;
    if (pnl < 0) lossesByTier[tier] += Math.abs(pnl);
    else offsetsByTier[tier] += pnl;
  }

  const remainingByTier = {};
  for (let i = 0; i < ladder.length - 1; i += 1) {
    const source = ladder[i];
    const next = ladder[i + 1];
    remainingByTier[source] = Math.max(0, lossesByTier[source] - offsetsByTier[next]);
  }
  const lastTier = ladder[ladder.length - 1];
  remainingByTier[lastTier] = Math.max(0, lossesByTier[lastTier]);

  let nextStakeUsd = baseStake;
  for (let i = ladder.length - 1; i >= 0; i -= 1) {
    const tier = ladder[i];
    const remaining = remainingByTier[tier] || 0;
    if (remaining <= 0.0001) continue;
    nextStakeUsd = i < ladder.length - 1 ? ladder[i + 1] : tier;
    break;
  }

  const recoveryLossBalanceUsd = Object.values(remainingByTier).reduce((acc, v) => acc + Number(v || 0), 0);
  return {
    enabled: true,
    baseStakeUsd: baseStake,
    recoveryStakeUsd: recoveryStake,
    recoveryMaxStakeUsd: Math.max(...ladder),
    ladder,
    recoveryLossBalanceUsd: Number(recoveryLossBalanceUsd.toFixed(4)),
    nextStakeUsd: Number(nextStakeUsd.toFixed(2)),
    perTier: Object.fromEntries(
      ladder.map((s) => [
        String(s),
        {
          lossUsd: Number((lossesByTier[s] || 0).toFixed(4)),
          offsetUsd: Number((offsetsByTier[s] || 0).toFixed(4)),
          remainingUsd: Number((remainingByTier[s] || 0).toFixed(4)),
        },
      ]),
    ),
  };
}

function deriveTriggerRule(game, runtime) {
  return deriveSignalRule(game, runtime)?.id || 'UNKNOWN_RULE';
}

function makeOrderPayload(candidate, balanceUsd, runtime, cycleStakeUsd) {
  const ask = candidate.ask;
  const stakeUsd = Number(cycleStakeUsd || runtime.stakeUsd || 1);
  const maxContractsByStake = Math.max(1, Math.floor(stakeUsd / ask));
  const maxContractsByBalance = Math.max(0, Math.floor(balanceUsd / ask));
  const count = Math.min(maxContractsByStake, maxContractsByBalance);
  if (count < 1) return null;

  return {
    ticker: candidate.market.ticker,
    side: 'yes',
    action: 'buy',
    count,
    yes_price_dollars: ask.toFixed(4),
    time_in_force: 'immediate_or_cancel',
    client_order_id: `openclaw-${candidate.event.event_ticker}-${Date.now()}`,
  };
}

async function runCycle(client) {
  const runtime = getRuntimeConfig(config);
  const cycleStarted = new Date();
  appendAction('cycle_started', { at: cycleStarted.toISOString() });

  const settlements = await client.getSettlements(Math.floor(Date.now() / 1000) - 14 * 24 * 3600, Math.floor(Date.now() / 1000));
  const dailyLossUsd = computeDailyLossUsd(settlements, config.timezone, runtime.ignoredSettlementTickers || []);
  stateStore.setDailyLossUsd(Date.now(), config.timezone, dailyLossUsd);

  if (dailyLossUsd >= runtime.maxDailyLossUsd) {
    const msg = `Trading paused: daily loss ${dailyLossUsd.toFixed(2)} reached limit ${runtime.maxDailyLossUsd.toFixed(2)}.`;
    logger.warn(msg);
    appendAction('risk_halt', { reason: 'daily_loss_limit', dailyLossUsd, maxDailyLossUsd: runtime.maxDailyLossUsd });
    await notifier.send(msg);
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  const [{ balance }, openPositions, events] = await Promise.all([
    client.getBalance(),
    client.getOpenPositions(),
    client.getOpenEventsWithMarkets(),
  ]);
  const liveCompetitionScope = await resolveSoccerCompetitionScope(client, events, runtime.leagues || [], logger);
  const liveSoccerMap = await getLiveSoccerEventData(client, liveCompetitionScope);
  const enrichedEvents = attachLiveDataToEvents(events, liveSoccerMap);
  const openMarketTickers = (openPositions || []).map((p) => p.ticker).filter(Boolean);
  const openMarkets = openMarketTickers.length ? await client.getMarketsByTickers(openMarketTickers) : [];
  const openMarketMap = new Map(openMarkets.map((m) => [m.ticker, m]));
  const recovery = computeRecoveryState(settlements, openPositions, openMarketMap, stateStore, runtime);
  const cycleStakeUsd = recovery.nextStakeUsd;

  const balanceUsd = Number(balance || 0) / 100;
  if (balanceUsd < 0.1) {
    logger.warn({ balanceUsd }, 'No available balance; skipping cycle');
    appendAction('skip_no_balance', { balanceUsd });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  if (openPositions.length >= runtime.maxOpenPositions) {
    logger.warn({ openPositions: openPositions.length }, 'Max open positions reached; skipping cycle');
    appendAction('skip_max_positions', { openPositions: openPositions.length, maxOpenPositions: runtime.maxOpenPositions });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  if (!runtime.tradingEnabled) {
    logger.warn('Trading paused by runtime override');
    appendAction('manual_pause', { reason: 'runtime_override' });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  const candidates = enrichedEvents
    .map((event) => eligibleTradeCandidate(event, runtime, stateStore))
    .filter(Boolean)
    .sort((a, b) => b.game.minute - a.game.minute);

  logger.info(
    {
      eventsScanned: enrichedEvents.length,
      candidates: candidates.length,
      balanceUsd,
      dailyLossUsd,
      maxYesPrice: runtime.maxYesPrice,
      cycleStakeUsd,
      recoveryModeEnabled: recovery.enabled,
      recoveryLossBalanceUsd: recovery.recoveryLossBalanceUsd,
    },
    'Cycle evaluation complete',
  );

  appendAction('cycle_evaluated', {
    eventsScanned: enrichedEvents.length,
    candidates: candidates.length,
    balanceUsd,
    dailyLossUsd,
    maxYesPrice: runtime.maxYesPrice,
    cycleStakeUsd,
    recoveryModeEnabled: recovery.enabled,
    recoveryLossBalanceUsd: recovery.recoveryLossBalanceUsd,
  });

  for (const candidate of candidates) {
    const payload = makeOrderPayload(candidate, balanceUsd, runtime, cycleStakeUsd);
    if (!payload) {
      appendAction('skip_no_contract_capacity', {
        eventTicker: candidate.event.event_ticker,
        marketTicker: candidate.market.ticker,
        ask: candidate.ask,
      });
      continue;
    }

    const logMeta = {
      eventTicker: candidate.event.event_ticker,
      eventTitle: candidate.event.title,
      competition: candidate.game.competition,
      minute: candidate.game.minute,
      score: `${candidate.game.homeScore}-${candidate.game.awayScore}`,
      cards:
        candidate.game.homeRedCards !== null && candidate.game.awayRedCards !== null
          ? `${candidate.game.homeRedCards}-${candidate.game.awayRedCards}`
          : null,
      leaderVsTrailingCards:
        candidate.game.leadingTeamRedCards !== null && candidate.game.trailingTeamRedCards !== null
          ? `${candidate.game.leadingTeamRedCards}-${candidate.game.trailingTeamRedCards}`
          : null,
      stakeUsd: cycleStakeUsd,
      leadingTeam: candidate.game.leadingTeam,
      marketTicker: candidate.market.ticker,
      ask: candidate.ask,
      count: payload.count,
    };

    if (runtime.dryRun) {
      logger.info(logMeta, 'DRY_RUN would place order');
      appendAction('dry_run_order', logMeta);
      continue;
    }

    appendAction('order_submit', { ...logMeta, payload });
    const result = await client.createOrder(payload);
    const order = result.order || {};
    const fillCount = parseFp(order.fill_count_fp);

    if (fillCount > 0) {
      const triggerRule = deriveTriggerRule(candidate.game, runtime);
      stateStore.markEventTraded(candidate.event.event_ticker, {
        orderId: order.order_id,
        marketTicker: candidate.market.ticker,
        fillCount,
        yesPrice: order.yes_price_dollars,
        stakeUsdTarget: cycleStakeUsd,
        triggerRule,
        placedMinute: candidate.game.minute,
        placedScore: `${candidate.game.homeScore}-${candidate.game.awayScore}`,
        placedCards:
          candidate.game.homeRedCards !== null && candidate.game.awayRedCards !== null
            ? `${candidate.game.homeRedCards}-${candidate.game.awayRedCards}`
            : null,
        placedLeaderVsTrailingCards:
          candidate.game.leadingTeamRedCards !== null && candidate.game.trailingTeamRedCards !== null
            ? `${candidate.game.leadingTeamRedCards}-${candidate.game.trailingTeamRedCards}`
            : null,
        leadingTeam: candidate.game.leadingTeam || null,
        competition: candidate.game.competition || null,
        eventTitle: candidate.event.title || null,
        selectedOutcome: candidate.market.yes_sub_title || null,
      });

      const msg = `Filled ${fillCount} contract(s): ${candidate.event.title} at ${candidate.ask.toFixed(4)} (minute ${candidate.game.minute}, score ${candidate.game.homeScore}-${candidate.game.awayScore})`;
      logger.info({ ...logMeta, orderId: order.order_id, fillCount }, 'Order filled');
      appendAction('order_filled', { ...logMeta, orderId: order.order_id, fillCount });
      await notifier.send(msg);
    } else {
      logger.info({ ...logMeta, orderStatus: order.status }, 'Order not filled this cycle (will retry until minute cutoff)');
      appendAction('order_not_filled', { ...logMeta, orderStatus: order.status || null });
    }
  }

  stateStore.setLastCycle(cycleStarted.toISOString());
  stateStore.persist();
}

async function main() {
  if (!config.keyId) throw new Error('Missing KALSHI_API_KEY_ID');

  const privateKey = loadPrivateKey({
    privateKeyPath: config.privateKeyPath,
    privateKeyPem: config.privateKeyPem,
  });

  const client = new KalshiClient({
    baseUrl: config.baseUrl,
    keyId: config.keyId,
    privateKey,
    logger,
  });

  logger.info(
    {
      dryRun: config.dryRun,
      stakeUsd: config.stakeUsd,
      recoveryModeEnabled: config.recoveryModeEnabled,
      recoveryStakeUsd: config.recoveryStakeUsd,
      recoveryMaxStakeUsd: config.recoveryMaxStakeUsd,
      leagues: config.leagues,
      minTriggerMinute: config.minTriggerMinute,
      minGoalLead: config.minGoalLead,
      retryUntilMinute: config.retryUntilMinute,
      minVolume24hContracts: config.minVolume24hContracts,
      minLiquidityDollars: config.minLiquidityDollars,
      maxYesPrice: config.maxYesPrice,
      maxDailyLossUsd: config.maxDailyLossUsd,
      ignoredSettlementTickers: config.ignoredSettlementTickers,
      runtimeOverrides: 'data/runtime-overrides.json',
      actionLog: LOG_PATH,
    },
    'Bot started',
  );

  await notifier.send(`Kalshi bot started (${config.dryRun ? 'DRY_RUN' : 'LIVE'}).`);

  while (true) {
    try {
      await runCycle(client);
    } catch (error) {
      logger.error({ err: error.message }, 'Cycle failed');
      appendAction('cycle_error', { message: error.message });
      await notifier.send(`Kalshi bot cycle error: ${error.message}`);
    }

    await sleep(config.pollSeconds * 1000);
  }
}

main().catch((error) => {
  logger.fatal({ err: error.message }, 'Fatal startup error');
  appendAction('fatal_error', { message: error.message });
  process.exit(1);
});
