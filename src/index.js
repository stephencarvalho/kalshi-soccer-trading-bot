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
const { buildRecoveryQueue, contractsForTargetNetProfit, totalCostForYesBuy, kalshiImmediateFeeUsd } = require('./recoveryQueue');
const {
  getLiveSoccerEventData,
  attachLiveDataToEvents,
  eventLooksLikeSoccer,
  resolveSoccerCompetitionScope,
} = require('./kalshiLiveSoccer');

const logger = createLogger(config.logLevel);
const notifier = new Notifier(config, logger);
const stateStore = new StateStore(config.stateFile);
stateStore.load();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value, maxLength = 500) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function serializeError(error) {
  if (!error) {
    return {
      message: 'Unknown error',
      name: 'Error',
    };
  }

  const responseData = error.response?.data;
  const requestConfig = error.config || {};

  return {
    message: error.message || 'Unknown error',
    name: error.name || 'Error',
    code: error.code || null,
    stack: error.stack || null,
    status: error.response?.status ?? null,
    statusText: error.response?.statusText || null,
    method:
      error.kalshiRequest?.method ||
      (requestConfig.method ? String(requestConfig.method).toUpperCase() : null),
    path:
      error.kalshiRequest?.path ||
      requestConfig.url ||
      null,
    responseData:
      responseData === undefined
        ? null
        : truncateText(
            typeof responseData === 'string' ? responseData : JSON.stringify(responseData),
            1000,
          ),
    kalshiRequest: error.kalshiRequest || null,
  };
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

function computeRecoveryState(settlements, stateStore, runtime) {
  const baseStake = Number(runtime.stakeUsd || 1);
  const closedTrades = (settlements || [])
    .filter((s) => !isIgnoredSettlement(s, runtime.ignoredSettlementTickers || []))
    .filter(settlementHasExposure)
    .filter((s) => String(s?.event_ticker || '').includes('GAME'))
    .map((s) => {
      const meta = stateStore.getTradeMeta(s.event_ticker) || {};
      const totalCostUsd = Number((parseFp(s.yes_total_cost_dollars) + parseFp(s.no_total_cost_dollars)).toFixed(4));
      const pnlUsd = settlementPnlUsd(s);
      return {
        ticker: s.ticker,
        event_ticker: s.event_ticker,
        settled_time: s.settled_time,
        pnl_usd: pnlUsd,
        total_cost_usd: totalCostUsd,
        amount_bet_usd: totalCostUsd,
        total_return_usd: Number((Number(s.revenue || 0) / 100).toFixed(4)),
        roi_pct: totalCostUsd > 0 ? pnlUsd / totalCostUsd : null,
        placed_context: {
          ...meta,
        },
      };
    });

  if (!runtime.recoveryModeEnabled) {
    return {
      enabled: false,
      strategy: 'closed_loss_queue',
      baseStakeUsd: baseStake,
      recoveryLossBalanceUsd: 0,
      nextTargetProfitUsd: 0,
      unresolvedLossCount: 0,
      queue: [],
    };
  }

  const queueState = buildRecoveryQueue(closedTrades);
  return {
    enabled: true,
    strategy: 'closed_loss_queue',
    baseStakeUsd: baseStake,
    currentLossStreak: queueState.currentLossStreak,
    recoveryLossBalanceUsd: queueState.recoveryLossBalanceUsd,
    nextTargetProfitUsd: queueState.nextTargetProfitUsd,
    unresolvedLossCount: queueState.unresolvedLossCount,
    queue: queueState.queue,
  };
}

function deriveTriggerRule(game, runtime) {
  return deriveSignalRule(game, runtime)?.id || 'UNKNOWN_RULE';
}

function maxContractsWithinBudget(priceUsd, maxSpendUsd) {
  const budget = Number(maxSpendUsd || 0);
  if (!Number.isFinite(budget) || budget <= 0) return null;

  let candidateCount = 1;
  let latestAffordable = null;
  while (candidateCount <= 100000) {
    const candidateCostUsd = totalCostForYesBuy(candidateCount, priceUsd);
    if (candidateCostUsd === null || candidateCostUsd > budget + 1e-9) {
      break;
    }
    latestAffordable = candidateCount;
    candidateCount += 1;
  }

  if (!latestAffordable) return null;
  const totalCostUsd = totalCostForYesBuy(latestAffordable, priceUsd);
  const feeUsd = kalshiImmediateFeeUsd(latestAffordable, priceUsd);
  if (totalCostUsd === null) return null;
  return {
    count: latestAffordable,
    feeUsd,
    totalCostUsd,
    netProfitUsd: Number((latestAffordable * (1 - priceUsd) - feeUsd).toFixed(4)),
  };
}

function makeOrderPayload(candidate, balanceUsd, runtime, recoveryState) {
  const ask = candidate.ask;
  const limitPrice = Number(candidate.signalRule.stageMaxYesPrice.toFixed(4));
  const baseStakeUsd = Number(runtime.stakeUsd || 1);

  let sizingMode = 'BASE';
  let targetProfitUsd = 0;
  let queueItem = null;
  let count = 0;
  let feeUsd = 0;
  let totalCostUsd = 0;
  let netProfitUsd = 0;

  if (recoveryState?.enabled && Number(recoveryState.nextTargetProfitUsd || 0) > 0 && Array.isArray(recoveryState.queue)) {
    sizingMode = 'RECOVERY_QUEUE';
    targetProfitUsd = Number(recoveryState.nextTargetProfitUsd || 0);
    queueItem = recoveryState.queue.find((item) => Number(item.remainingTargetUsd || 0) > 0.0001) || null;
    const sized = contractsForTargetNetProfit(limitPrice, targetProfitUsd);
    const maxRecoverySpendUsd = Number(runtime.recoveryMaxStakeUsd || 0);
    const maxSpendUsd =
      Number.isFinite(maxRecoverySpendUsd) && maxRecoverySpendUsd > 0
        ? Math.min(maxRecoverySpendUsd, balanceUsd)
        : balanceUsd;
    const fitsBudget =
      sized &&
      sized.totalCostUsd <= maxSpendUsd + 1e-9;
    const fallbackSized = fitsBudget ? null : maxContractsWithinBudget(limitPrice, maxSpendUsd);
    const chosen = fitsBudget ? sized : fallbackSized;
    if (!chosen) return null;
    if (!fitsBudget) sizingMode = 'RECOVERY_QUEUE_CAPPED';
    count = chosen.count;
    feeUsd = chosen.feeUsd;
    totalCostUsd = chosen.totalCostUsd;
    netProfitUsd = chosen.netProfitUsd;
  } else {
    let candidateCount = 1;
    let latestAffordable = null;
    while (candidateCount <= 100000) {
      const candidateCostUsd = totalCostForYesBuy(candidateCount, limitPrice);
      if (candidateCostUsd === null || candidateCostUsd > baseStakeUsd + 1e-9 || candidateCostUsd > balanceUsd + 1e-9) {
        break;
      }
      latestAffordable = candidateCount;
      candidateCount += 1;
    }
    count = latestAffordable || 0;
    if (count < 1) return null;
    feeUsd = kalshiImmediateFeeUsd(count, limitPrice);
    totalCostUsd = totalCostForYesBuy(count, limitPrice);
    netProfitUsd = Number((count * (1 - limitPrice) - feeUsd).toFixed(4));
  }

  if (count < 1) return null;

  return {
    order: {
      ticker: candidate.market.ticker,
      side: 'yes',
      action: 'buy',
      count,
      yes_price_dollars: limitPrice.toFixed(4),
      time_in_force: 'good_till_canceled',
      cancel_order_on_pause: true,
      client_order_id: `openclaw-${candidate.event.event_ticker}-${Date.now()}`,
    },
    sizing: {
      sizingMode,
      count,
      feeUsd,
      totalCostUsd,
      netProfitUsd,
      limitPrice,
      targetProfitUsd: targetProfitUsd || null,
      recoveryQueueId: queueItem?.queueId || null,
      recoverySourceEventTitle: queueItem?.sourceEventTitle || null,
      recoverySourceLossUsd: queueItem?.lossUsd ?? null,
      recoveryRemainingUsd: queueItem?.remainingTargetUsd ?? null,
      baseStakeUsd,
    },
  };
}

function orderStatus(order) {
  return String(order?.status || '').toLowerCase();
}

function isRestingOrder(order) {
  return ['resting', 'open', 'pending'].includes(orderStatus(order));
}

function parseEventTickerFromClientOrderId(clientOrderId) {
  const text = String(clientOrderId || '');
  const match = text.match(/^openclaw-(.+)-\d+$/);
  return match ? match[1] : null;
}

function buildMarketToEventMap(events) {
  const marketToEvent = new Map();
  for (const event of events || []) {
    for (const market of event.markets || []) {
      if (market?.ticker) {
        marketToEvent.set(market.ticker, event.event_ticker);
      }
    }
  }
  return marketToEvent;
}

function syncRestingOrderState(restingOrders, stateStore, events) {
  const marketToEvent = buildMarketToEventMap(events);
  const activeByEvent = new Map();

  for (const order of restingOrders || []) {
    if (!isRestingOrder(order)) continue;
    const clientOrderId = order.client_order_id || order.clientOrderId || '';
    if (!String(clientOrderId).startsWith('openclaw-')) continue;
    const marketTicker = order.ticker || order.market_ticker || null;
    const eventTicker =
      order.event_ticker ||
      marketToEvent.get(marketTicker) ||
      parseEventTickerFromClientOrderId(clientOrderId);
    if (!eventTicker) continue;
    activeByEvent.set(eventTicker, {
      orderId: order.order_id || order.id || null,
      marketTicker,
      clientOrderId,
      limitPrice: Number.parseFloat(order.yes_price_dollars || order.price || 0) || null,
      count: parseFp(order.count || order.count_fp),
      status: order.status || null,
    });
  }

  for (const [eventTicker, meta] of activeByEvent.entries()) {
    stateStore.setEventOpenOrder(eventTicker, meta);
  }

  for (const meta of stateStore.listOpenOrders()) {
    if (!activeByEvent.has(meta.eventTicker)) {
      stateStore.clearEventOpenOrder(meta.eventTicker);
    }
  }

  return Array.from(activeByEvent.entries()).map(([eventTicker, meta]) => ({
    eventTicker,
    ...meta,
  }));
}

async function cancelRestingOrder(client, stateStore, openOrder, reason) {
  if (!openOrder?.orderId) {
    stateStore.clearEventOpenOrder(openOrder?.eventTicker);
    return;
  }
  try {
    await client.cancelOrder(openOrder.orderId);
    appendAction('order_cancel', {
      eventTicker: openOrder.eventTicker,
      marketTicker: openOrder.marketTicker || null,
      orderId: openOrder.orderId,
      reason,
    });
    stateStore.clearEventOpenOrder(openOrder.eventTicker);
  } catch (error) {
    appendAction('order_cancel_error', {
      eventTicker: openOrder.eventTicker,
      marketTicker: openOrder.marketTicker || null,
      orderId: openOrder.orderId,
      reason,
      message: error.message,
    });
  }
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

  const previousOpenOrders = stateStore.listOpenOrders();
  const [{ balance }, openPositions, events, restingOrders] = await Promise.all([
    client.getBalance(),
    client.getOpenPositions(),
    client.getOpenEventsWithMarkets(),
    client.getOrders({ status: 'resting' }),
  ]);
  const liveCompetitionScope = await resolveSoccerCompetitionScope(client, events, runtime.leagues || [], logger);
  const liveSoccerMap = await getLiveSoccerEventData(client, liveCompetitionScope);
  const enrichedEvents = attachLiveDataToEvents(events, liveSoccerMap);
  const recovery = computeRecoveryState(settlements, stateStore, runtime);
  let activeRestingOrders = syncRestingOrderState(restingOrders, stateStore, enrichedEvents);
  const openPositionByMarket = new Map(
    (openPositions || [])
      .filter((position) => Math.abs(parseFp(position.position_fp)) > 0)
      .map((position) => [position.ticker, position]),
  );
  const eventMap = new Map((enrichedEvents || []).map((event) => [event.event_ticker, event]));

  for (const previousOrder of previousOpenOrders) {
    if (stateStore.getEventOpenOrder(previousOrder.eventTicker)) continue;
    if (stateStore.hasTradedEvent(previousOrder.eventTicker)) continue;
    const openPosition = openPositionByMarket.get(previousOrder.marketTicker);
    if (!openPosition) continue;
    const event = eventMap.get(previousOrder.eventTicker);
    stateStore.markEventTraded(previousOrder.eventTicker, {
      orderId: previousOrder.orderId || null,
      marketTicker: previousOrder.marketTicker || null,
      fillCount: Math.abs(parseFp(openPosition.position_fp)),
      yesPrice: null,
      triggerRule: 'GTC_RESTING_FILL',
      competition: event?.product_metadata?.competition || event?.__live?.competition || null,
      eventTitle: event?.title || null,
      selectedOutcome: event?.markets?.find((market) => market.ticker === previousOrder.marketTicker)?.yes_sub_title || null,
    });
    appendAction('order_fill_detected_from_position', {
      eventTicker: previousOrder.eventTicker,
      marketTicker: previousOrder.marketTicker || null,
      orderId: previousOrder.orderId || null,
      fillCount: Math.abs(parseFp(openPosition.position_fp)),
    });
  }

  const balanceUsd = Number(balance || 0) / 100;

  const candidates = enrichedEvents
    .filter((event) => eventLooksLikeSoccer(event, liveSoccerMap))
    .map((event) => eligibleTradeCandidate(event, runtime, stateStore))
    .filter(Boolean)
    .sort((a, b) => b.game.minute - a.game.minute);
  const candidateByEvent = new Map(candidates.map((candidate) => [candidate.event.event_ticker, candidate]));

  if (!runtime.tradingEnabled || dailyLossUsd >= runtime.maxDailyLossUsd || openPositions.length >= runtime.maxOpenPositions) {
    const reason = !runtime.tradingEnabled
      ? 'runtime_override'
      : dailyLossUsd >= runtime.maxDailyLossUsd
        ? 'daily_loss_limit'
        : 'max_open_positions';
    for (const openOrder of activeRestingOrders) {
      await cancelRestingOrder(client, stateStore, openOrder, reason);
    }
    activeRestingOrders = [];
  } else {
    for (const openOrder of activeRestingOrders) {
      const candidate = candidateByEvent.get(openOrder.eventTicker);
      const shouldCancel =
        stateStore.hasTradedEvent(openOrder.eventTicker) ||
        !candidate ||
        candidate.market.ticker !== openOrder.marketTicker;
      if (shouldCancel) {
        await cancelRestingOrder(client, stateStore, openOrder, !candidate ? 'signal_invalidated' : 'filled_or_market_changed');
      }
    }
    activeRestingOrders = stateStore.listOpenOrders();
  }

  if (dailyLossUsd >= runtime.maxDailyLossUsd) {
    const msg = `Trading paused: daily loss ${dailyLossUsd.toFixed(2)} reached limit ${runtime.maxDailyLossUsd.toFixed(2)}.`;
    logger.warn(msg);
    appendAction('risk_halt', { reason: 'daily_loss_limit', dailyLossUsd, maxDailyLossUsd: runtime.maxDailyLossUsd });
    await notifier.send(msg);
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  if (balanceUsd < 0.1) {
    logger.warn({ balanceUsd }, 'No available balance; skipping cycle');
    appendAction('skip_no_balance', { balanceUsd });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  const activeExposureCount = openPositions.length + activeRestingOrders.length;
  if (activeExposureCount >= runtime.maxOpenPositions) {
    logger.warn({ openPositions: openPositions.length, restingOrders: activeRestingOrders.length }, 'Max position/exposure limit reached; skipping cycle');
    appendAction('skip_max_positions', {
      openPositions: openPositions.length,
      restingOrders: activeRestingOrders.length,
      maxOpenPositions: runtime.maxOpenPositions,
    });
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

  logger.info(
    {
      eventsScanned: enrichedEvents.length,
      candidates: candidates.length,
      balanceUsd,
      dailyLossUsd,
      maxYesPrice: runtime.maxYesPrice,
      cycleStakeUsd: recovery.nextTargetProfitUsd || runtime.stakeUsd,
      recoveryModeEnabled: recovery.enabled,
      recoveryLossBalanceUsd: recovery.recoveryLossBalanceUsd,
      activeRestingOrders: activeRestingOrders.length,
    },
    'Cycle evaluation complete',
  );

  appendAction('cycle_evaluated', {
    eventsScanned: enrichedEvents.length,
    candidates: candidates.length,
    balanceUsd,
    dailyLossUsd,
    maxYesPrice: runtime.maxYesPrice,
    cycleStakeUsd: recovery.nextTargetProfitUsd || runtime.stakeUsd,
    recoveryModeEnabled: recovery.enabled,
    recoveryLossBalanceUsd: recovery.recoveryLossBalanceUsd,
    activeRestingOrders: activeRestingOrders.length,
  });

  for (const candidate of candidates) {
    const existingResting = stateStore.getEventOpenOrder(candidate.event.event_ticker);
    if (existingResting?.orderId) {
      appendAction('skip_existing_open_order', {
        eventTicker: candidate.event.event_ticker,
        marketTicker: candidate.market.ticker,
        orderId: existingResting.orderId,
      });
      continue;
    }
    const orderPlan = makeOrderPayload(candidate, balanceUsd, runtime, recovery);
    if (!orderPlan) {
      appendAction('skip_no_contract_capacity', {
        eventTicker: candidate.event.event_ticker,
        marketTicker: candidate.market.ticker,
        ask: candidate.ask,
        recoveryTargetProfitUsd: recovery.nextTargetProfitUsd || null,
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
      stakeUsd: orderPlan.sizing.totalCostUsd,
      targetProfitUsd: orderPlan.sizing.targetProfitUsd,
      recoveryQueueId: orderPlan.sizing.recoveryQueueId,
      recoveryRemainingUsd: orderPlan.sizing.recoveryRemainingUsd,
      recoverySourceLossUsd: orderPlan.sizing.recoverySourceLossUsd,
      recoverySourceEventTitle: orderPlan.sizing.recoverySourceEventTitle,
      sizingMode: orderPlan.sizing.sizingMode,
      leadingTeam: candidate.game.leadingTeam,
      selectedOutcome: candidate.selectedOutcome || candidate.game.leadingTeam || null,
      leadingTeamMaxLead: candidate.game.leadingTeamMaxLead,
      marketTicker: candidate.market.ticker,
      ask: candidate.ask,
      limitPrice: orderPlan.sizing.limitPrice,
      count: orderPlan.order.count,
      estimatedFeeUsd: orderPlan.sizing.feeUsd,
      estimatedNetProfitUsd: orderPlan.sizing.netProfitUsd,
    };

    if (runtime.dryRun) {
      logger.info(logMeta, 'DRY_RUN would place order');
      appendAction('dry_run_order', logMeta);
      continue;
    }

    appendAction('order_submit', { ...logMeta, payload: orderPlan.order });
    const result = await client.createOrder(orderPlan.order);
    const order = result.order || {};
    const fillCount = parseFp(order.fill_count_fp);

    const remainingCount = parseFp(order.remaining_count_fp || order.resting_count_fp);

    if (fillCount > 0) {
      const triggerRule = deriveTriggerRule(candidate.game, runtime);
      stateStore.markEventTraded(candidate.event.event_ticker, {
        orderId: order.order_id,
        marketTicker: candidate.market.ticker,
        fillCount,
        yesPrice: candidate.ask,
        stakeUsdTarget: orderPlan.sizing.totalCostUsd,
        targetProfitUsd: orderPlan.sizing.targetProfitUsd,
        recoveryQueueId: orderPlan.sizing.recoveryQueueId,
        recoveryRemainingUsd: orderPlan.sizing.recoveryRemainingUsd,
        recoverySourceLossUsd: orderPlan.sizing.recoverySourceLossUsd,
        recoverySourceEventTitle: orderPlan.sizing.recoverySourceEventTitle,
        sizingMode: orderPlan.sizing.sizingMode,
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
        leadingTeamMaxLead: candidate.game.leadingTeamMaxLead ?? null,
        competition: candidate.game.competition || null,
        eventTitle: candidate.event.title || null,
        selectedOutcome: candidate.selectedOutcome || candidate.market.yes_sub_title || null,
        limitPrice: orderPlan.sizing.limitPrice,
      });

      if (remainingCount > 0 || isRestingOrder(order)) {
        await cancelRestingOrder(
          client,
          stateStore,
          {
            eventTicker: candidate.event.event_ticker,
            orderId: order.order_id,
            marketTicker: candidate.market.ticker,
          },
          'cancel_remainder_after_fill',
        );
      } else {
        stateStore.clearEventOpenOrder(candidate.event.event_ticker);
      }

      const msg = `Filled ${fillCount} contract(s): ${candidate.event.title} at ${candidate.ask.toFixed(4)} (minute ${candidate.game.minute}, score ${candidate.game.homeScore}-${candidate.game.awayScore})`;
      logger.info({ ...logMeta, orderId: order.order_id, fillCount }, 'Order filled');
      appendAction('order_filled', { ...logMeta, orderId: order.order_id, fillCount });
      await notifier.send(msg);
    } else if (isRestingOrder(order)) {
      stateStore.setEventOpenOrder(candidate.event.event_ticker, {
        orderId: order.order_id,
        marketTicker: candidate.market.ticker,
        clientOrderId: order.client_order_id || orderPlan.order.client_order_id,
        limitPrice: orderPlan.sizing.limitPrice,
        count: orderPlan.order.count,
        status: order.status || null,
      });
      logger.info({ ...logMeta, orderId: order.order_id, orderStatus: order.status }, 'Order resting on book');
      appendAction('order_resting', { ...logMeta, orderId: order.order_id, orderStatus: order.status || null });
    } else {
      stateStore.clearEventOpenOrder(candidate.event.event_ticker);
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
      const errorMeta = serializeError(error);
      logger.error({ err: errorMeta }, 'Cycle failed');
      appendAction('cycle_error', errorMeta);
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
