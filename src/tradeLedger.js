const { parseFp } = require('./kalshiClient');

function settlementPnlUsd(settlement) {
  const revenue = Number(settlement?.revenue || 0) / 100;
  const costYes = parseFp(settlement?.yes_total_cost_dollars);
  const costNo = parseFp(settlement?.no_total_cost_dollars);
  const fee = parseFp(settlement?.fee_cost);
  return revenue - costYes - costNo - fee;
}

function round4(value) {
  return Number((Number(value || 0)).toFixed(4));
}

function inferLegWeight(leg) {
  const explicitStake = Number(leg?.stakeUsdTarget);
  if (Number.isFinite(explicitStake) && explicitStake > 0) return explicitStake;

  const fillCount = Number(leg?.fillCount ?? leg?.count);
  const yesPrice = Number(leg?.yesPrice ?? leg?.limitPrice);
  if (Number.isFinite(fillCount) && fillCount > 0 && Number.isFinite(yesPrice) && yesPrice > 0) {
    return fillCount * yesPrice;
  }

  return 1;
}

function allocateRounded(totalValue, weights) {
  const total = Number(totalValue || 0);
  const safeWeights = (weights || []).map((weight) => {
    const n = Number(weight || 0);
    return Number.isFinite(n) && n > 0 ? n : 1;
  });

  if (!safeWeights.length) return [];

  const weightSum = safeWeights.reduce((sum, weight) => sum + weight, 0) || safeWeights.length;
  let allocated = 0;

  return safeWeights.map((weight, index) => {
    if (index === safeWeights.length - 1) return round4(total - allocated);
    const share = round4((total * weight) / weightSum);
    allocated += share;
    return share;
  });
}

function getTradeLegsForEvent(stateSource, eventTicker) {
  if (!eventTicker) return [];
  if (stateSource && typeof stateSource.getTradeLegs === 'function') {
    return stateSource.getTradeLegs(eventTicker);
  }

  const explicitLegs = Array.isArray(stateSource?.tradeLegsByEvent?.[eventTicker])
    ? stateSource.tradeLegsByEvent[eventTicker]
    : [];
  const fallbackLeg = stateSource?.tradedEvents?.[eventTicker];
  const legs = explicitLegs.length ? explicitLegs : fallbackLeg ? [fallbackLeg] : [];

  return legs.map((leg, index) => ({
    ...(leg || {}),
    tradeLegId: leg?.tradeLegId || `${eventTicker}#${index + 1}`,
    tradeLegIndex: Number.isFinite(Number(leg?.tradeLegIndex)) ? Number(leg.tradeLegIndex) : index + 1,
  }));
}

function buildClosedTradesFromSettlements(settlements, stateSource) {
  return (settlements || []).flatMap((settlement) => {
    const eventTicker = settlement?.event_ticker || null;
    const settlementTicker = String(settlement?.ticker || '');
    const eventLegs = getTradeLegsForEvent(stateSource, eventTicker);
    const matchingMarketLegs = settlementTicker
      ? eventLegs.filter((leg) => String(leg?.marketTicker || '') === settlementTicker)
      : [];
    const legs = matchingMarketLegs.length ? matchingMarketLegs : eventLegs;
    const resolvedLegs = legs.length ? legs : [{}];
    const weights = resolvedLegs.map(inferLegWeight);

    const totalCostUsd = round4(parseFp(settlement?.yes_total_cost_dollars) + parseFp(settlement?.no_total_cost_dollars));
    const totalReturnUsd = round4(Number(settlement?.revenue || 0) / 100);
    const totalFeeUsd = round4(parseFp(settlement?.fee_cost));

    const allocatedCosts = allocateRounded(totalCostUsd, weights);
    const allocatedReturns = allocateRounded(totalReturnUsd, weights);
    const allocatedFees = allocateRounded(totalFeeUsd, weights);

    return resolvedLegs.map((leg, index) => {
      const costUsd = allocatedCosts[index] ?? 0;
      const returnUsd = allocatedReturns[index] ?? 0;
      const feeUsd = allocatedFees[index] ?? 0;
      const pnlUsd = round4(returnUsd - costUsd - feeUsd);
      return {
        ticker: settlement?.ticker,
        event_ticker: eventTicker,
        market_result: settlement?.market_result,
        yes_count_fp: settlement?.yes_count_fp,
        no_count_fp: settlement?.no_count_fp,
        revenue_cents: settlement?.revenue,
        fee_cost: settlement?.fee_cost,
        settled_time: settlement?.settled_time,
        pnl_usd: pnlUsd,
        total_cost_usd: costUsd,
        amount_bet_usd: costUsd,
        total_return_usd: returnUsd,
        fee_usd: feeUsd,
        roi_pct: costUsd > 0 ? pnlUsd / costUsd : null,
        placed_context: {
          ...(leg || {}),
          tradeLegId: leg?.tradeLegId || (eventTicker ? `${eventTicker}#${index + 1}` : null),
          tradeLegIndex: Number.isFinite(Number(leg?.tradeLegIndex)) ? Number(leg.tradeLegIndex) : index + 1,
        },
      };
    });
  });
}

module.exports = {
  buildClosedTradesFromSettlements,
  getTradeLegsForEvent,
  settlementPnlUsd,
};
