require('dotenv').config();

const { config } = require('./config');
const { createLogger } = require('./logger');
const { loadPrivateKey } = require('./kalshiAuth');
const { KalshiClient, parseFp } = require('./kalshiClient');
const { StateStore } = require('./stateStore');
const { eligibleTradeCandidate, computeDailyLossUsd } = require('./strategy');
const { Notifier } = require('./notifier');
const { appendAction, LOG_PATH } = require('./actionLog');
const { getRuntimeConfig } = require('./runtimeConfig');
const { getLiveSoccerEventData, attachLiveDataToEvents } = require('./kalshiLiveSoccer');

const logger = createLogger(config.logLevel);
const notifier = new Notifier(config, logger);
const stateStore = new StateStore(config.stateFile);
stateStore.load();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveTriggerRule(game, runtime) {
  if (game.minute >= runtime.post80StartMinute) {
    return `POST_${runtime.post80StartMinute}_LEAD_${runtime.post80MinGoalLead}`;
  }
  return `POST_${runtime.minTriggerMinute}_LEAD_${runtime.minGoalLead}`;
}

function makeOrderPayload(candidate, balanceUsd, runtime) {
  const ask = candidate.ask;
  const maxContractsByStake = Math.max(1, Math.floor(runtime.stakeUsd / ask));
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
  const dailyLossUsd = computeDailyLossUsd(settlements, config.timezone);
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

  const [{ balance }, openPositions, events, liveSoccerMap] = await Promise.all([
    client.getBalance(),
    client.getOpenPositions(),
    client.getOpenEventsWithMarkets(),
    getLiveSoccerEventData(client, runtime.leagues || []),
  ]);
  const enrichedEvents = attachLiveDataToEvents(events, liveSoccerMap);

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
    },
    'Cycle evaluation complete',
  );

  appendAction('cycle_evaluated', {
    eventsScanned: enrichedEvents.length,
    candidates: candidates.length,
    balanceUsd,
    dailyLossUsd,
    maxYesPrice: runtime.maxYesPrice,
  });

  for (const candidate of candidates) {
    const payload = makeOrderPayload(candidate, balanceUsd, runtime);
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
        triggerRule,
        placedMinute: candidate.game.minute,
        placedScore: `${candidate.game.homeScore}-${candidate.game.awayScore}`,
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
      leagues: config.leagues,
      minTriggerMinute: config.minTriggerMinute,
      minGoalLead: config.minGoalLead,
      retryUntilMinute: config.retryUntilMinute,
      minVolume24hContracts: config.minVolume24hContracts,
      minLiquidityDollars: config.minLiquidityDollars,
      maxYesPrice: config.maxYesPrice,
      maxDailyLossUsd: config.maxDailyLossUsd,
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
