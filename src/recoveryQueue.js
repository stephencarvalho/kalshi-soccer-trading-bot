function roundUpCent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil((n - 1e-9) * 100) / 100;
}

function kalshiImmediateFeeUsd(contracts, priceUsd) {
  const count = Number(contracts || 0);
  const price = Number(priceUsd || 0);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  return roundUpCent(0.07 * count * price * (1 - price));
}

function netProfitForYesBuy(contracts, priceUsd) {
  const count = Number(contracts || 0);
  const price = Number(priceUsd || 0);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return Number((count * (1 - price) - kalshiImmediateFeeUsd(count, price)).toFixed(4));
}

function totalCostForYesBuy(contracts, priceUsd) {
  const count = Number(contracts || 0);
  const price = Number(priceUsd || 0);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return Number((count * price + kalshiImmediateFeeUsd(count, price)).toFixed(4));
}

function contractsForTargetNetProfit(priceUsd, targetProfitUsd) {
  const price = Number(priceUsd || 0);
  const target = Number(targetProfitUsd || 0);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  if (!Number.isFinite(target) || target <= 0) return null;

  const rough = Math.max(1, Math.ceil(target / Math.max(1e-9, 1 - price)));
  let count = Math.max(1, rough - 2);

  while (count <= 100000) {
    const netProfitUsd = netProfitForYesBuy(count, price);
    const totalCostUsd = totalCostForYesBuy(count, price);
    const feeUsd = kalshiImmediateFeeUsd(count, price);
    if (netProfitUsd !== null && totalCostUsd !== null && netProfitUsd + 1e-9 >= target) {
      return {
        count,
        feeUsd,
        totalCostUsd,
        netProfitUsd,
      };
    }
    count += 1;
  }

  return null;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeTradeKey(trade) {
  const legId = trade?.placed_context?.tradeLegId || trade?.trade_leg_id || '';
  return `${String(trade?.ticker || trade?.event_ticker || 'TRADE')}@${String(trade?.settled_time || '')}@${String(legId)}`;
}

function buildRecoveryQueue(closedTrades) {
  const ordered = [...(closedTrades || [])].sort((a, b) => new Date(a.settled_time).getTime() - new Date(b.settled_time).getTime());
  const unresolved = [];
  let lossCount = 0;
  let currentLossStreak = 0;

  for (const trade of ordered) {
    const pnlUsd = Number(trade.pnl_usd || 0);
    const tradeSummary = {
      tradeKey: makeTradeKey(trade),
      ticker: trade.ticker,
      eventTicker: trade.event_ticker || null,
      eventTitle: trade.placed_context?.eventTitle || trade.event_title || trade.event_ticker || '-',
      competition: trade.placed_context?.competition || 'Unknown',
      settledTime: trade.settled_time,
      pnlUsd: Number(pnlUsd.toFixed(4)),
      roiPct: safeNumber(trade.roi_pct),
      amountBetUsd: safeNumber(trade.amount_bet_usd ?? trade.total_cost_usd),
      totalReturnUsd: safeNumber(trade.total_return_usd),
      stakeUsdTarget: safeNumber(trade.placed_context?.stakeUsdTarget),
      targetProfitUsd: safeNumber(trade.placed_context?.targetProfitUsd),
      yesPrice: safeNumber(trade.placed_context?.yesPrice),
      contracts: safeNumber(trade.placed_context?.fillCount ?? trade.yes_count_fp ?? trade.no_count_fp),
      triggerRule: trade.placed_context?.triggerRule || null,
    };

    const targetedQueueId = String(trade?.placed_context?.recoveryQueueId || '');
    const targetedItem = targetedQueueId
      ? unresolved.find((item) => item.queueId === targetedQueueId) || null
      : null;

    if (targetedItem) {
      const targetedRemainingUsdBefore =
        safeNumber(trade?.placed_context?.recoveryRemainingUsd) ?? Number(targetedItem.remainingTargetUsd.toFixed(4));
      const attempt = {
        ...tradeSummary,
        targetedRemainingUsdBefore,
      };
      targetedItem.recoveryAttempts.push(attempt);
      if (!targetedItem.recoveryBet) {
        targetedItem.recoveryBet = attempt;
      }
    }

    if (pnlUsd > 0) {
      let remainingWinUsd = pnlUsd;
      currentLossStreak = 0;
      while (remainingWinUsd > 0.0001 && unresolved.length > 0) {
        const item = unresolved[0];
        const allocatedUsd = Math.min(item.remainingTargetUsd, remainingWinUsd);
        item.recoveredUsd = Number((item.recoveredUsd + allocatedUsd).toFixed(4));
        item.remainingTargetUsd = Number((item.remainingTargetUsd - allocatedUsd).toFixed(4));
        const linkedAttempt = item.recoveryAttempts.find((attempt) => attempt.tradeKey === tradeSummary.tradeKey);
        if (linkedAttempt) {
          linkedAttempt.allocatedRecoveryUsd = Number(
            ((linkedAttempt.allocatedRecoveryUsd || 0) + allocatedUsd).toFixed(4),
          );
        }
        item.recoverySettlements.push({
          ...tradeSummary,
          allocatedRecoveryUsd: Number(allocatedUsd.toFixed(4)),
        });
        remainingWinUsd = Number((remainingWinUsd - allocatedUsd).toFixed(4));
        if (item.remainingTargetUsd <= 0.0001) {
          item.remainingTargetUsd = 0;
          item.status = 'RESOLVED';
          item.resolvedAt = trade.settled_time;
          unresolved.shift();
        } else {
          break;
        }
      }
    }

    if (pnlUsd < 0) {
      currentLossStreak += 1;
      const lossUsd = Math.abs(pnlUsd);
      lossCount += 1;
      const item = {
        queueId: `LOSS-${lossCount}`,
        sourceTradeKey: tradeSummary.tradeKey,
        sourceTicker: tradeSummary.ticker,
        sourceEventTicker: tradeSummary.eventTicker,
        sourceEventTitle: tradeSummary.eventTitle,
        competition: tradeSummary.competition,
        lossSettledTime: tradeSummary.settledTime,
        lossUsd: Number(lossUsd.toFixed(4)),
        recoveredUsd: 0,
        remainingTargetUsd: Number(lossUsd.toFixed(4)),
        status: 'QUEUED',
        resolvedAt: null,
        recoveryBet: null,
        recoveryAttempts: [],
        recoverySettlements: [],
      };
      unresolved.push(item);
    }
  }

  const queueRows = unresolved.map((item) => {
    const resolutionTrade = item.recoverySettlements[item.recoverySettlements.length - 1] || null;
    return {
      ...item,
      status: item.recoveredUsd > 0 ? 'PARTIAL' : 'QUEUED',
      recoveryBetResultUsd: item.recoveryBet?.pnlUsd ?? null,
      resolutionTrade,
    };
  });

  const recoveryLossBalanceUsd = Number(
    unresolved.reduce((acc, item) => acc + Number(item.remainingTargetUsd || 0), 0).toFixed(4),
  );

  return {
    currentLossStreak,
    unresolvedLossCount: unresolved.length,
    nextTargetProfitUsd: unresolved.length ? Number(unresolved[0].remainingTargetUsd.toFixed(4)) : 0,
    recoveryLossBalanceUsd,
    queue: queueRows,
  };
}

module.exports = {
  kalshiImmediateFeeUsd,
  totalCostForYesBuy,
  netProfitForYesBuy,
  contractsForTargetNetProfit,
  buildRecoveryQueue,
};
