require("dotenv").config();

const { config } = require("./config");
const { createLogger } = require("./logger");
const { loadPrivateKey } = require("./kalshiAuth");
const { KalshiClient, parseFp } = require("./kalshiClient");
const { StateStore } = require("./stateStore");
const {
  eligibleTradeCandidate,
  computeDailyLossUsd,
  deriveSignalRule,
} = require("./strategy");
const { Notifier } = require("./notifier");
const { appendAction, LOG_PATH } = require("./actionLog");
const { getRuntimeConfig } = require("./runtimeConfig");
const {
  buildRecoveryQueue,
  contractsForTargetNetProfit,
  totalCostForYesBuy,
  kalshiImmediateFeeUsd,
} = require("./recoveryQueue");
const { isRecoverySizingEligible } = require("./recoveryConditions");
const {
  buildClosedTradesFromSettlements,
  settlementPnlUsd,
} = require("./tradeLedger");
const {
  publishDashboardSnapshotsForStoredCredentials,
} = require("./monitorServer");
const {
  getLiveSoccerEventData,
  attachLiveDataToEvents,
  eventLooksLikeSoccer,
  resolveSoccerCompetitionScope,
} = require("./kalshiLiveSoccer");

const logger = createLogger(config.logLevel);
const notifier = new Notifier(config, logger);
const stateStore = new StateStore(config.stateFile);
stateStore.load();
const ORDER_REJECTION_COOLDOWN_MS = 10 * 60 * 1000;
const ABSOLUTE_BET_CAP_USD = 20;
const RECOVERY_MAX_BET_CAP_USD = 100;

function describeTradingMode(runtime) {
  if (!runtime?.tradingEnabled) return "PAUSED";
  return runtime?.dryRun ? "DRY_RUN" : "LIVE";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishDashboardSnapshotsSafely(source) {
  try {
    const result = await publishDashboardSnapshotsForStoredCredentials(source);
    logger.info({ source, ...result }, "Dashboard snapshots refreshed");
  } catch (error) {
    logger.warn(
      { err: error?.message || error, source },
      "Dashboard snapshot refresh failed",
    );
  }
}

function truncateText(value, maxLength = 500) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function serializeError(error) {
  if (!error) {
    return {
      message: "Unknown error",
      name: "Error",
    };
  }

  const responseData = error.response?.data;
  const requestConfig = error.config || {};

  return {
    message: error.message || "Unknown error",
    name: error.name || "Error",
    code: error.code || null,
    stack: error.stack || null,
    status: error.response?.status ?? null,
    statusText: error.response?.statusText || null,
    method:
      error.kalshiRequest?.method ||
      (requestConfig.method
        ? String(requestConfig.method).toUpperCase()
        : null),
    path: error.kalshiRequest?.path || requestConfig.url || null,
    responseData:
      responseData === undefined
        ? null
        : truncateText(
            typeof responseData === "string"
              ? responseData
              : JSON.stringify(responseData),
            1000,
          ),
    kalshiRequest: error.kalshiRequest || null,
  };
}

async function getMarketDiagnostics(client, marketTicker) {
  if (!client || !marketTicker) return null;
  try {
    const markets = await client.getMarketsByTickers([marketTicker]);
    const market = markets[0] || null;
    if (!market) return { found: false, ticker: marketTicker };
    return {
      found: true,
      ticker: market.ticker || marketTicker,
      eventTicker: market.event_ticker || null,
      status: market.status || null,
      yesAsk: parseFp(market.yes_ask_dollars),
      yesBid: parseFp(market.yes_bid_dollars),
      noAsk: parseFp(market.no_ask_dollars),
      noBid: parseFp(market.no_bid_dollars),
      lastPrice: parseFp(market.last_price_dollars),
      liquidityDollars: parseFp(market.liquidity_dollars),
      volume24h: parseFp(market.volume_24h),
      yesSubtitle: market.yes_sub_title || null,
      noSubtitle: market.no_sub_title || null,
      closeTime: market.close_time || null,
      result: market.result || null,
    };
  } catch (error) {
    return {
      found: false,
      ticker: marketTicker,
      diagnosticsError: error.message || "Failed to fetch market diagnostics",
    };
  }
}

function settlementHasExposure(settlement) {
  const yesCount = Math.abs(parseFp(settlement?.yes_count_fp));
  const noCount = Math.abs(parseFp(settlement?.no_count_fp));
  const yesCost = Math.abs(parseFp(settlement?.yes_total_cost_dollars));
  const noCost = Math.abs(parseFp(settlement?.no_total_cost_dollars));
  const revenue = Math.abs(Number(settlement?.revenue || 0));
  const fee = Math.abs(parseFp(settlement?.fee_cost));
  return (
    yesCount > 0 ||
    noCount > 0 ||
    yesCost > 0 ||
    noCost > 0 ||
    revenue > 0 ||
    fee > 0
  );
}

function isIgnoredSettlement(settlement, ignoredTickers = []) {
  const ignored = new Set((ignoredTickers || []).map((x) => String(x)));
  const ticker = String(settlement?.ticker || "");
  const eventTicker = String(settlement?.event_ticker || "");
  return ignored.has(ticker) || ignored.has(eventTicker);
}

function computeRecoveryState(settlements, stateStore, runtime) {
  const baseStake = Number(runtime.stakeUsd || 1);
  const closedTrades = buildClosedTradesFromSettlements(
    (settlements || [])
      .filter(
        (s) => !isIgnoredSettlement(s, runtime.ignoredSettlementTickers || []),
      )
      .filter(settlementHasExposure)
      .filter((s) => String(s?.event_ticker || "").includes("GAME")),
    stateStore,
  );

  if (!runtime.recoveryModeEnabled) {
    return {
      enabled: false,
      strategy: "closed_loss_queue",
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
    strategy: "closed_loss_queue",
    baseStakeUsd: baseStake,
    currentLossStreak: queueState.currentLossStreak,
    recoveryLossBalanceUsd: queueState.recoveryLossBalanceUsd,
    nextTargetProfitUsd: queueState.nextTargetProfitUsd,
    unresolvedLossCount: queueState.unresolvedLossCount,
    queue: queueState.queue,
  };
}

function roundRecoveryUsd(value) {
  return Number(Number(value || 0).toFixed(4));
}

function inferReservedRecoveryUsd(meta) {
  const explicit = Number(meta?.reservedRecoveryUsd);
  if (Number.isFinite(explicit) && explicit > 0)
    return roundRecoveryUsd(explicit);

  const netProfitUsd = Number(
    meta?.estimatedNetProfitUsd ?? meta?.netProfitUsd,
  );
  if (Number.isFinite(netProfitUsd) && netProfitUsd > 0)
    return roundRecoveryUsd(netProfitUsd);

  const count = Number(meta?.count ?? meta?.fillCount);
  const limitPrice = Number(meta?.limitPrice ?? meta?.yesPrice);
  if (
    Number.isFinite(count) &&
    count > 0 &&
    Number.isFinite(limitPrice) &&
    limitPrice > 0 &&
    limitPrice < 1
  ) {
    return roundRecoveryUsd(
      count * (1 - limitPrice) - kalshiImmediateFeeUsd(count, limitPrice),
    );
  }

  const targetProfitUsd = Number(meta?.targetProfitUsd);
  if (Number.isFinite(targetProfitUsd) && targetProfitUsd > 0)
    return roundRecoveryUsd(targetProfitUsd);

  return 0;
}

function computePendingRecoveryReservations(settlements, stateStore) {
  const settledEventTickers = new Set(
    (settlements || [])
      .map((settlement) => String(settlement?.event_ticker || ""))
      .filter(Boolean),
  );
  const reservedByQueueId = new Map();

  function reserve(queueId, targetProfitUsd) {
    const key = String(queueId || "");
    const amount = Number(targetProfitUsd || 0);
    if (!key) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    reservedByQueueId.set(
      key,
      roundRecoveryUsd((reservedByQueueId.get(key) || 0) + amount),
    );
  }

  for (const trade of stateStore.listTradeLegs()) {
    const queueId = String(trade?.recoveryQueueId || "");
    if (!queueId) continue;
    if (settledEventTickers.has(String(trade?.eventTicker || ""))) continue;
    reserve(queueId, inferReservedRecoveryUsd(trade));
  }

  for (const openOrder of stateStore.listOpenOrders()) {
    const queueId = String(openOrder?.recoveryQueueId || "");
    if (!queueId) continue;
    reserve(queueId, inferReservedRecoveryUsd(openOrder));
  }

  return reservedByQueueId;
}

function applyPendingRecoveryReservations(recoveryState, reservedByQueueId) {
  if (!recoveryState?.enabled || !Array.isArray(recoveryState.queue))
    return recoveryState;

  const queue = recoveryState.queue.map((item) => {
    const reservedUsd = roundRecoveryUsd(
      reservedByQueueId?.get(String(item.queueId || "")) || 0,
    );
    const availableTargetUsd = roundRecoveryUsd(
      Math.max(0, Number(item.remainingTargetUsd || 0) - reservedUsd),
    );
    return {
      ...item,
      reservedInFlightUsd: reservedUsd,
      availableTargetUsd,
    };
  });

  const nextQueueItem =
    queue.find((item) => Number(item.availableTargetUsd || 0) > 0.0001) || null;

  return {
    ...recoveryState,
    queue,
    nextTargetProfitUsd: nextQueueItem
      ? roundRecoveryUsd(nextQueueItem.availableTargetUsd)
      : 0,
  };
}

function deriveTriggerRule(game, runtime) {
  return deriveSignalRule(game, runtime)?.id || "UNKNOWN_RULE";
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
    netProfitUsd: Number(
      (latestAffordable * (1 - priceUsd) - feeUsd).toFixed(4),
    ),
  };
}

function candidateCanUseRecoverySizing(candidate, runtime) {
  if (!candidate) return false;
  if (typeof candidate.recoverySizingEligible === "boolean")
    return candidate.recoverySizingEligible;
  return isRecoverySizingEligible(candidate, runtime);
}

function canPlaceSameEventRecoveryAddOn(
  candidate,
  stateStore,
  recoveryState,
  runtime,
) {
  const eventTicker = candidate?.event?.event_ticker;
  const marketTicker = candidate?.market?.ticker;
  if (!eventTicker || !marketTicker) return false;
  if (
    !recoveryState?.enabled ||
    Number(recoveryState.nextTargetProfitUsd || 0) <= 0
  )
    return false;
  if (!candidateCanUseRecoverySizing(candidate, runtime)) return false;
  if (!stateStore.hasTradedEvent(eventTicker)) return false;
  if (stateStore.hasRecoveryTradeForEvent(eventTicker)) return false;

  return stateStore.getTradeLegs(eventTicker).some((leg) => {
    const sizingMode = String(leg?.sizingMode || "").toUpperCase();
    const isRecoveryLeg =
      Boolean(leg?.recoveryQueueId) || sizingMode.startsWith("RECOVERY");
    return (
      !isRecoveryLeg && String(leg?.marketTicker || "") === String(marketTicker)
    );
  });
}

function shouldConsiderCandidate(
  candidate,
  stateStore,
  recoveryState,
  runtime,
) {
  if (!candidate?.event?.event_ticker) return false;
  if (!stateStore.hasTradedEvent(candidate.event.event_ticker)) return true;
  return canPlaceSameEventRecoveryAddOn(
    candidate,
    stateStore,
    recoveryState,
    runtime,
  );
}

function makeOrderPayload(candidate, balanceUsd, runtime, recoveryState) {
  const ask = candidate.ask;
  const limitPrice = Number(candidate.signalRule.stageMaxYesPrice.toFixed(4));
  const baseStakeUsd = Math.min(
    Number(runtime.stakeUsd || 1),
    ABSOLUTE_BET_CAP_USD,
  );

  let sizingMode = "BASE";
  let targetProfitUsd = 0;
  let queueItem = null;
  let count = 0;
  let feeUsd = 0;
  let totalCostUsd = 0;
  let netProfitUsd = 0;

  if (
    candidateCanUseRecoverySizing(candidate, runtime) &&
    recoveryState?.enabled &&
    Number(recoveryState.nextTargetProfitUsd || 0) > 0 &&
    Array.isArray(recoveryState.queue)
  ) {
    sizingMode = "RECOVERY_QUEUE";
    targetProfitUsd = Number(recoveryState.nextTargetProfitUsd || 0);
    queueItem =
      recoveryState.queue.find(
        (item) =>
          Number(item.availableTargetUsd ?? item.remainingTargetUsd ?? 0) >
          0.0001,
      ) || null;
    const sized = contractsForTargetNetProfit(limitPrice, targetProfitUsd);
    const maxRecoverySpendUsd = Number(runtime.recoveryMaxStakeUsd || 0);
    const maxSpendUsd =
      Number.isFinite(maxRecoverySpendUsd) && maxRecoverySpendUsd > 0
        ? Math.min(maxRecoverySpendUsd, RECOVERY_MAX_BET_CAP_USD, balanceUsd)
        : Math.min(RECOVERY_MAX_BET_CAP_USD, balanceUsd);
    const fitsBudget = sized && sized.totalCostUsd <= maxSpendUsd + 1e-9;
    const fallbackSized = fitsBudget
      ? null
      : maxContractsWithinBudget(limitPrice, maxSpendUsd);
    const chosen = fitsBudget ? sized : fallbackSized;
    if (!chosen) return null;
    if (!fitsBudget) sizingMode = "RECOVERY_QUEUE_CAPPED";
    count = chosen.count;
    feeUsd = chosen.feeUsd;
    totalCostUsd = chosen.totalCostUsd;
    netProfitUsd = chosen.netProfitUsd;
  } else {
    let candidateCount = 1;
    let latestAffordable = null;
    while (candidateCount <= 100000) {
      const candidateCostUsd = totalCostForYesBuy(candidateCount, limitPrice);
      if (
        candidateCostUsd === null ||
        candidateCostUsd > baseStakeUsd + 1e-9 ||
        candidateCostUsd > balanceUsd + 1e-9
      ) {
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
      side: "yes",
      action: "buy",
      count,
      yes_price_dollars: limitPrice.toFixed(4),
      time_in_force: "good_till_canceled",
      cancel_order_on_pause: true,
      client_order_id: `kalshi-soccer-bot-${candidate.event.event_ticker}-${Date.now()}`,
    },
    sizing: {
      sizingMode,
      count,
      feeUsd,
      totalCostUsd,
      netProfitUsd,
      limitPrice,
      targetProfitUsd: targetProfitUsd || null,
      reservedRecoveryUsd: targetProfitUsd ? netProfitUsd : null,
      recoveryQueueId: queueItem?.queueId || null,
      recoverySourceEventTitle: queueItem?.sourceEventTitle || null,
      recoverySourceLossUsd: queueItem?.lossUsd ?? null,
      recoveryRemainingUsd:
        queueItem?.availableTargetUsd ?? queueItem?.remainingTargetUsd ?? null,
      baseStakeUsd,
    },
  };
}

function orderStatus(order) {
  return String(order?.status || "").toLowerCase();
}

function isRestingOrder(order) {
  return ["resting", "open", "pending"].includes(orderStatus(order));
}

function parseEventTickerFromClientOrderId(clientOrderId) {
  const text = String(clientOrderId || "");
  const match = text.match(/^kalshi-soccer-bot-(.+)-\d+$/);
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
    const clientOrderId = order.client_order_id || order.clientOrderId || "";
    if (!String(clientOrderId).startsWith("kalshi-soccer-bot-")) continue;
    const marketTicker = order.ticker || order.market_ticker || null;
    const eventTicker =
      order.event_ticker ||
      marketToEvent.get(marketTicker) ||
      parseEventTickerFromClientOrderId(clientOrderId);
    if (!eventTicker) continue;
    const existing = stateStore.getEventOpenOrder(eventTicker) || {};
    activeByEvent.set(eventTicker, {
      orderId: order.order_id || order.id || null,
      marketTicker,
      clientOrderId,
      triggerRule: existing.triggerRule || null,
      eventTitle: existing.eventTitle || null,
      competition: existing.competition || null,
      selectedOutcome: existing.selectedOutcome || null,
      yesPrice: existing.yesPrice ?? null,
      limitPrice:
        Number.parseFloat(order.yes_price_dollars || order.price || 0) || null,
      count: parseFp(order.count || order.count_fp),
      status: order.status || null,
      stakeUsdTarget: existing.stakeUsdTarget ?? null,
      recoveryQueueId: existing.recoveryQueueId || null,
      recoveryRemainingUsd: existing.recoveryRemainingUsd ?? null,
      recoverySourceLossUsd: existing.recoverySourceLossUsd ?? null,
      recoverySourceEventTitle: existing.recoverySourceEventTitle || null,
      targetProfitUsd: existing.targetProfitUsd ?? null,
      reservedRecoveryUsd: existing.reservedRecoveryUsd ?? null,
      sizingMode: existing.sizingMode || null,
      placedMinute: existing.placedMinute ?? null,
      placedScore: existing.placedScore || null,
      placedCards: existing.placedCards || null,
      placedLeaderVsTrailingCards: existing.placedLeaderVsTrailingCards || null,
      leadingTeam: existing.leadingTeam || null,
      leadingTeamMaxLead: existing.leadingTeamMaxLead ?? null,
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
    appendAction("order_cancel", {
      eventTicker: openOrder.eventTicker,
      marketTicker: openOrder.marketTicker || null,
      orderId: openOrder.orderId,
      reason,
    });
    stateStore.clearEventOpenOrder(openOrder.eventTicker);
  } catch (error) {
    appendAction("order_cancel_error", {
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
  const startupMode = config.dryRun ? "DRY_RUN" : "LIVE";
  const activeMode = describeTradingMode(runtime);
  appendAction("cycle_started", { at: cycleStarted.toISOString() });
  logger.info(
    {
      startupMode,
      activeMode,
      runtimeDryRun: Boolean(runtime.dryRun),
      tradingEnabled: Boolean(runtime.tradingEnabled),
      runtimeOverridesActive:
        Boolean(runtime.dryRun) !== Boolean(config.dryRun) ||
        Boolean(runtime.tradingEnabled) !== true,
    },
    "Cycle mode state",
  );

  const settlements = await client.getSettlements(
    Math.floor(Date.now() / 1000) - 14 * 24 * 3600,
    Math.floor(Date.now() / 1000),
  );
  const dailyLossUsd = computeDailyLossUsd(
    settlements,
    config.timezone,
    runtime.ignoredSettlementTickers || [],
  );
  stateStore.setDailyLossUsd(Date.now(), config.timezone, dailyLossUsd);

  if (
    !runtime.ignoreDailyLossLimit &&
    dailyLossUsd >= runtime.maxDailyLossUsd
  ) {
    const msg = `Trading paused: daily loss ${dailyLossUsd.toFixed(2)} reached limit ${runtime.maxDailyLossUsd.toFixed(2)}.`;
    logger.warn(msg);
    appendAction("risk_halt", {
      reason: "daily_loss_limit",
      dailyLossUsd,
      maxDailyLossUsd: runtime.maxDailyLossUsd,
    });
    await notifier.send(msg);
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  const previousOpenOrders = stateStore.listOpenOrders();
  const [{ balance }, openPositions, events, restingOrders] = await Promise.all(
    [
      client.getBalance(),
      client.getOpenPositions(),
      client.getOpenEventsWithMarkets(),
      client.getOrders({ status: "resting" }),
    ],
  );
  const liveCompetitionScope = await resolveSoccerCompetitionScope(
    client,
    events,
    runtime.leagues || [],
    logger,
  );
  const liveSoccerMap = await getLiveSoccerEventData(
    client,
    liveCompetitionScope,
  );
  const enrichedEvents = attachLiveDataToEvents(events, liveSoccerMap);
  const recoveryBase = computeRecoveryState(settlements, stateStore, runtime);
  let activeRestingOrders = syncRestingOrderState(
    restingOrders,
    stateStore,
    enrichedEvents,
  );
  const pendingRecoveryReservations = computePendingRecoveryReservations(
    settlements,
    stateStore,
  );
  const recovery = applyPendingRecoveryReservations(
    recoveryBase,
    pendingRecoveryReservations,
  );
  const openPositionByMarket = new Map(
    (openPositions || [])
      .filter((position) => Math.abs(parseFp(position.position_fp)) > 0)
      .map((position) => [position.ticker, position]),
  );
  const eventMap = new Map(
    (enrichedEvents || []).map((event) => [event.event_ticker, event]),
  );

  for (const previousOrder of previousOpenOrders) {
    if (stateStore.getEventOpenOrder(previousOrder.eventTicker)) continue;
    if (
      previousOrder.orderId &&
      stateStore.hasTradeLegForOrderId(previousOrder.orderId)
    )
      continue;
    const openPosition = openPositionByMarket.get(previousOrder.marketTicker);
    if (!openPosition) continue;
    const event = eventMap.get(previousOrder.eventTicker);
    const priorTradeMeta = {
      ...(stateStore.getTradeMeta(previousOrder.eventTicker) || {}),
      ...(previousOrder || {}),
    };
    stateStore.markEventTraded(previousOrder.eventTicker, {
      orderId: previousOrder.orderId || null,
      marketTicker:
        previousOrder.marketTicker || priorTradeMeta.marketTicker || null,
      fillCount: Math.abs(parseFp(openPosition.position_fp)),
      yesPrice: priorTradeMeta.yesPrice ?? priorTradeMeta.limitPrice ?? null,
      stakeUsdTarget: priorTradeMeta.stakeUsdTarget ?? null,
      targetProfitUsd: priorTradeMeta.targetProfitUsd ?? null,
      reservedRecoveryUsd: priorTradeMeta.reservedRecoveryUsd ?? null,
      recoveryQueueId: priorTradeMeta.recoveryQueueId || null,
      recoveryRemainingUsd: priorTradeMeta.recoveryRemainingUsd ?? null,
      recoverySourceLossUsd: priorTradeMeta.recoverySourceLossUsd ?? null,
      recoverySourceEventTitle: priorTradeMeta.recoverySourceEventTitle || null,
      sizingMode: priorTradeMeta.sizingMode || null,
      triggerRule: priorTradeMeta.triggerRule || null,
      executionDetail: "GTC_RESTING_FILL",
      placedMinute: priorTradeMeta.placedMinute ?? null,
      placedScore: priorTradeMeta.placedScore || null,
      placedCards: priorTradeMeta.placedCards || null,
      placedLeaderVsTrailingCards:
        priorTradeMeta.placedLeaderVsTrailingCards || null,
      leadingTeam: priorTradeMeta.leadingTeam || null,
      leadingTeamMaxLead: priorTradeMeta.leadingTeamMaxLead ?? null,
      competition:
        priorTradeMeta.competition ||
        event?.product_metadata?.competition ||
        event?.__live?.competition ||
        null,
      eventTitle: priorTradeMeta.eventTitle || event?.title || null,
      selectedOutcome:
        priorTradeMeta.selectedOutcome ||
        event?.markets?.find(
          (market) => market.ticker === previousOrder.marketTicker,
        )?.yes_sub_title ||
        null,
      limitPrice: priorTradeMeta.limitPrice ?? priorTradeMeta.yesPrice ?? null,
    });
    appendAction("order_fill_detected_from_position", {
      eventTicker: previousOrder.eventTicker,
      marketTicker: previousOrder.marketTicker || null,
      orderId: previousOrder.orderId || null,
      fillCount: Math.abs(parseFp(openPosition.position_fp)),
      targetProfitUsd: priorTradeMeta.targetProfitUsd ?? null,
      recoveryQueueId: priorTradeMeta.recoveryQueueId || null,
      recoveryRemainingUsd: priorTradeMeta.recoveryRemainingUsd ?? null,
      recoverySourceLossUsd: priorTradeMeta.recoverySourceLossUsd ?? null,
      recoverySourceEventTitle: priorTradeMeta.recoverySourceEventTitle || null,
      sizingMode: priorTradeMeta.sizingMode || null,
      triggerRule: priorTradeMeta.triggerRule || null,
      executionDetail: "GTC_RESTING_FILL",
    });
  }

  const balanceUsd = Number(balance || 0) / 100;

  const candidates = enrichedEvents
    .filter((event) => eventLooksLikeSoccer(event, liveSoccerMap))
    .map((event) =>
      eligibleTradeCandidate(event, runtime, stateStore, {
        allowRepeatEvent: true,
      }),
    )
    .filter((candidate) =>
      shouldConsiderCandidate(candidate, stateStore, recovery, runtime),
    )
    .filter(Boolean)
    .sort((a, b) => b.game.minute - a.game.minute);
  const candidateByEvent = new Map(
    candidates.map((candidate) => [candidate.event.event_ticker, candidate]),
  );

  if (
    !runtime.tradingEnabled ||
    (!runtime.ignoreDailyLossLimit &&
      dailyLossUsd >= runtime.maxDailyLossUsd) ||
    openPositions.length >= runtime.maxOpenPositions
  ) {
    const reason = !runtime.tradingEnabled
      ? "runtime_override"
      : !runtime.ignoreDailyLossLimit && dailyLossUsd >= runtime.maxDailyLossUsd
        ? "daily_loss_limit"
        : "max_open_positions";
    for (const openOrder of activeRestingOrders) {
      await cancelRestingOrder(client, stateStore, openOrder, reason);
    }
    activeRestingOrders = [];
  } else {
    for (const openOrder of activeRestingOrders) {
      const candidate = candidateByEvent.get(openOrder.eventTicker);
      const shouldCancel =
        !candidate || candidate.market.ticker !== openOrder.marketTicker;
      if (shouldCancel) {
        await cancelRestingOrder(
          client,
          stateStore,
          openOrder,
          !candidate ? "signal_invalidated" : "filled_or_market_changed",
        );
      }
    }
    activeRestingOrders = stateStore.listOpenOrders();
  }

  if (
    !runtime.ignoreDailyLossLimit &&
    dailyLossUsd >= runtime.maxDailyLossUsd
  ) {
    const msg = `Trading paused: daily loss ${dailyLossUsd.toFixed(2)} reached limit ${runtime.maxDailyLossUsd.toFixed(2)}.`;
    logger.warn(msg);
    appendAction("risk_halt", {
      reason: "daily_loss_limit",
      dailyLossUsd,
      maxDailyLossUsd: runtime.maxDailyLossUsd,
    });
    await notifier.send(msg);
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  if (balanceUsd < 0.1) {
    logger.warn({ balanceUsd }, "No available balance; skipping cycle");
    appendAction("skip_no_balance", { balanceUsd });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  const activeExposureCount = openPositions.length + activeRestingOrders.length;
  if (activeExposureCount >= runtime.maxOpenPositions) {
    logger.warn(
      {
        openPositions: openPositions.length,
        restingOrders: activeRestingOrders.length,
      },
      "Max position/exposure limit reached; skipping cycle",
    );
    appendAction("skip_max_positions", {
      openPositions: openPositions.length,
      restingOrders: activeRestingOrders.length,
      maxOpenPositions: runtime.maxOpenPositions,
    });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  if (!runtime.tradingEnabled) {
    logger.warn("Trading paused by runtime override");
    appendAction("manual_pause", { reason: "runtime_override" });
    stateStore.setLastCycle(cycleStarted.toISOString());
    stateStore.persist();
    return;
  }

  logger.info(
    {
      startupMode,
      activeMode,
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
    "Cycle evaluation complete",
  );

  appendAction("cycle_evaluated", {
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
    const effectiveRecovery = applyPendingRecoveryReservations(
      recoveryBase,
      pendingRecoveryReservations,
    );
    const existingResting = stateStore.getEventOpenOrder(
      candidate.event.event_ticker,
    );
    if (existingResting?.orderId) {
      appendAction("skip_existing_open_order", {
        eventTicker: candidate.event.event_ticker,
        marketTicker: candidate.market.ticker,
        orderId: existingResting.orderId,
      });
      continue;
    }

    const existingRejection = stateStore.getEventRejection(
      candidate.event.event_ticker,
    );
    if (existingRejection) {
      appendAction("skip_recent_order_rejection", {
        eventTicker: candidate.event.event_ticker,
        marketTicker: candidate.market.ticker,
        reason: existingRejection.reason || null,
        errorCode: existingRejection.errorCode || null,
        untilTs: existingRejection.untilTs || null,
      });
      continue;
    }

    const orderPlan = makeOrderPayload(
      candidate,
      balanceUsd,
      runtime,
      effectiveRecovery,
    );
    if (!orderPlan) {
      appendAction("skip_no_contract_capacity", {
        eventTicker: candidate.event.event_ticker,
        marketTicker: candidate.market.ticker,
        ask: candidate.ask,
        recoveryTargetProfitUsd: effectiveRecovery.nextTargetProfitUsd || null,
      });
      continue;
    }

    const logMeta = {
      triggerRule: deriveTriggerRule(candidate.game, runtime),
      eventTicker: candidate.event.event_ticker,
      eventTitle: candidate.event.title,
      competition: candidate.game.competition,
      minute: candidate.game.minute,
      score: `${candidate.game.homeScore}-${candidate.game.awayScore}`,
      cards:
        candidate.game.homeRedCards !== null &&
        candidate.game.awayRedCards !== null
          ? `${candidate.game.homeRedCards}-${candidate.game.awayRedCards}`
          : null,
      leaderVsTrailingCards:
        candidate.game.leadingTeamRedCards !== null &&
        candidate.game.trailingTeamRedCards !== null
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
      selectedOutcome:
        candidate.selectedOutcome || candidate.game.leadingTeam || null,
      leadingTeamMaxLead: candidate.game.leadingTeamMaxLead,
      marketTicker: candidate.market.ticker,
      ask: candidate.ask,
      limitPrice: orderPlan.sizing.limitPrice,
      count: orderPlan.order.count,
      estimatedFeeUsd: orderPlan.sizing.feeUsd,
      estimatedNetProfitUsd: orderPlan.sizing.netProfitUsd,
    };

    if (runtime.dryRun) {
      logger.info(logMeta, "DRY_RUN would place order");
      appendAction("dry_run_order", logMeta);
      if (orderPlan.sizing.recoveryQueueId) {
        const queueId = String(orderPlan.sizing.recoveryQueueId);
        pendingRecoveryReservations.set(
          queueId,
          roundRecoveryUsd(
            (pendingRecoveryReservations.get(queueId) || 0) +
              Number(orderPlan.sizing.reservedRecoveryUsd || 0),
          ),
        );
      }
      continue;
    }

    appendAction("order_submit", { ...logMeta, payload: orderPlan.order });
    let result;
    try {
      result = await client.createOrder(orderPlan.order);
    } catch (error) {
      const errorMeta = serializeError(error);
      const marketDiagnostics = await getMarketDiagnostics(
        client,
        candidate.market.ticker,
      );
      const errorCode = error.response?.data?.error?.code || null;
      const rejectionUntilTs =
        error.response?.status === 400 && errorCode === "invalid_parameters"
          ? Date.now() + ORDER_REJECTION_COOLDOWN_MS
          : null;

      appendAction("order_submit_error", {
        ...logMeta,
        ...errorMeta,
        payload: orderPlan.order,
        marketDiagnostics,
        rejectionUntilTs,
      });

      logger.error(
        {
          ...logMeta,
          err: errorMeta,
          payload: orderPlan.order,
          marketDiagnostics,
          rejectionUntilTs,
        },
        "Order submission failed",
      );

      if (rejectionUntilTs) {
        stateStore.setEventRejected(candidate.event.event_ticker, {
          marketTicker: candidate.market.ticker,
          reason: "order_invalid_parameters",
          errorCode,
          untilTs: rejectionUntilTs,
          reservedRecoveryUsd: orderPlan.sizing.reservedRecoveryUsd,
        });
      }
      continue;
    }
    const order = result.order || {};
    const fillCount = parseFp(order.fill_count_fp);

    const remainingCount = parseFp(
      order.remaining_count_fp || order.resting_count_fp,
    );

    if (fillCount > 0) {
      stateStore.clearEventRejection(candidate.event.event_ticker);
      stateStore.markEventTraded(candidate.event.event_ticker, {
        orderId: order.order_id,
        marketTicker: candidate.market.ticker,
        fillCount,
        yesPrice: candidate.ask,
        stakeUsdTarget: orderPlan.sizing.totalCostUsd,
        targetProfitUsd: orderPlan.sizing.targetProfitUsd,
        reservedRecoveryUsd: orderPlan.sizing.reservedRecoveryUsd,
        recoveryQueueId: orderPlan.sizing.recoveryQueueId,
        recoveryRemainingUsd: orderPlan.sizing.recoveryRemainingUsd,
        recoverySourceLossUsd: orderPlan.sizing.recoverySourceLossUsd,
        recoverySourceEventTitle: orderPlan.sizing.recoverySourceEventTitle,
        sizingMode: orderPlan.sizing.sizingMode,
        triggerRule: logMeta.triggerRule,
        placedMinute: candidate.game.minute,
        placedScore: `${candidate.game.homeScore}-${candidate.game.awayScore}`,
        placedCards:
          candidate.game.homeRedCards !== null &&
          candidate.game.awayRedCards !== null
            ? `${candidate.game.homeRedCards}-${candidate.game.awayRedCards}`
            : null,
        placedLeaderVsTrailingCards:
          candidate.game.leadingTeamRedCards !== null &&
          candidate.game.trailingTeamRedCards !== null
            ? `${candidate.game.leadingTeamRedCards}-${candidate.game.trailingTeamRedCards}`
            : null,
        leadingTeam: candidate.game.leadingTeam || null,
        leadingTeamMaxLead: candidate.game.leadingTeamMaxLead ?? null,
        competition: candidate.game.competition || null,
        eventTitle: candidate.event.title || null,
        selectedOutcome:
          candidate.selectedOutcome || candidate.market.yes_sub_title || null,
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
          "cancel_remainder_after_fill",
        );
      } else {
        stateStore.clearEventOpenOrder(candidate.event.event_ticker);
      }

      const msg = `Filled ${fillCount} contract(s): ${candidate.event.title} at ${candidate.ask.toFixed(4)} (minute ${candidate.game.minute}, score ${candidate.game.homeScore}-${candidate.game.awayScore})`;
      logger.info(
        { ...logMeta, orderId: order.order_id, fillCount },
        "Order filled",
      );
      appendAction("order_filled", {
        ...logMeta,
        orderId: order.order_id,
        fillCount,
      });
      if (orderPlan.sizing.recoveryQueueId) {
        const queueId = String(orderPlan.sizing.recoveryQueueId);
        pendingRecoveryReservations.set(
          queueId,
          roundRecoveryUsd(
            (pendingRecoveryReservations.get(queueId) || 0) +
              Number(orderPlan.sizing.reservedRecoveryUsd || 0),
          ),
        );
      }
      await notifier.send(msg);
    } else if (isRestingOrder(order)) {
      stateStore.clearEventRejection(candidate.event.event_ticker);
      stateStore.setEventOpenOrder(candidate.event.event_ticker, {
        orderId: order.order_id,
        marketTicker: candidate.market.ticker,
        clientOrderId: order.client_order_id || orderPlan.order.client_order_id,
        triggerRule: logMeta.triggerRule,
        eventTitle: candidate.event.title || null,
        competition: candidate.game.competition || null,
        selectedOutcome:
          candidate.selectedOutcome || candidate.market.yes_sub_title || null,
        yesPrice: candidate.ask,
        limitPrice: orderPlan.sizing.limitPrice,
        count: orderPlan.order.count,
        status: order.status || null,
        stakeUsdTarget: orderPlan.sizing.totalCostUsd,
        recoveryQueueId: orderPlan.sizing.recoveryQueueId,
        recoveryRemainingUsd: orderPlan.sizing.recoveryRemainingUsd,
        recoverySourceLossUsd: orderPlan.sizing.recoverySourceLossUsd,
        recoverySourceEventTitle: orderPlan.sizing.recoverySourceEventTitle,
        targetProfitUsd: orderPlan.sizing.targetProfitUsd,
        reservedRecoveryUsd: orderPlan.sizing.reservedRecoveryUsd,
        sizingMode: orderPlan.sizing.sizingMode,
        placedMinute: candidate.game.minute,
        placedScore: `${candidate.game.homeScore}-${candidate.game.awayScore}`,
        placedCards:
          candidate.game.homeRedCards !== null &&
          candidate.game.awayRedCards !== null
            ? `${candidate.game.homeRedCards}-${candidate.game.awayRedCards}`
            : null,
        placedLeaderVsTrailingCards:
          candidate.game.leadingTeamRedCards !== null &&
          candidate.game.trailingTeamRedCards !== null
            ? `${candidate.game.leadingTeamRedCards}-${candidate.game.trailingTeamRedCards}`
            : null,
        leadingTeam: candidate.game.leadingTeam || null,
        leadingTeamMaxLead: candidate.game.leadingTeamMaxLead ?? null,
      });
      logger.info(
        { ...logMeta, orderId: order.order_id, orderStatus: order.status },
        "Order resting on book",
      );
      appendAction("order_resting", {
        ...logMeta,
        orderId: order.order_id,
        orderStatus: order.status || null,
      });
      if (orderPlan.sizing.recoveryQueueId) {
        const queueId = String(orderPlan.sizing.recoveryQueueId);
        pendingRecoveryReservations.set(
          queueId,
          roundRecoveryUsd(
            (pendingRecoveryReservations.get(queueId) || 0) +
              Number(orderPlan.sizing.reservedRecoveryUsd || 0),
          ),
        );
      }
    } else {
      stateStore.clearEventOpenOrder(candidate.event.event_ticker);
      logger.info(
        { ...logMeta, orderStatus: order.status },
        "Order not filled this cycle (will retry until minute cutoff)",
      );
      appendAction("order_not_filled", {
        ...logMeta,
        orderStatus: order.status || null,
      });
    }
  }

  stateStore.setLastCycle(cycleStarted.toISOString());
  stateStore.persist();
}

async function main() {
  if (!config.keyId) throw new Error("Missing KALSHI_API_KEY_ID");

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
      startupMode: config.dryRun ? "DRY_RUN" : "LIVE",
      initialActiveMode: describeTradingMode(getRuntimeConfig(config)),
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
      runtimeOverrides: "data/runtime-overrides.json",
      actionLog: LOG_PATH,
    },
    "Bot started",
  );

  await notifier.send(
    `Kalshi bot started (${config.dryRun ? "DRY_RUN" : "LIVE"}).`,
  );

  while (true) {
    try {
      await runCycle(client);
      await publishDashboardSnapshotsSafely("bot_cycle");
    } catch (error) {
      const errorMeta = serializeError(error);
      logger.error({ err: errorMeta }, "Cycle failed");
      appendAction("cycle_error", errorMeta);
      stateStore.setLastCycle(new Date().toISOString());
      stateStore.persist();
      await notifier.send(`Kalshi bot cycle error: ${error.message}`);
      await publishDashboardSnapshotsSafely("bot_cycle_error");
    }

    await sleep(config.pollSeconds * 1000);
  }
}

main().catch((error) => {
  logger.fatal({ err: error.message }, "Fatal startup error");
  appendAction("fatal_error", { message: error.message });
  process.exit(1);
});
