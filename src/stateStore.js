const fs = require('fs');
const path = require('path');

function toISODateInTz(tsMs, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(tsMs))
    .replaceAll('/', '-');
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      tradedEvents: {},
      tradeLegsByEvent: {},
      rejectedEvents: {},
      openOrderIdsByEvent: {},
      dailyLossByDate: {},
      lastCycleAt: null,
    };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.state = { ...this.state, ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.persist();
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  setLastCycle(tsIso) {
    this.state.lastCycleAt = tsIso;
  }

  hasTradedEvent(eventTicker) {
    return this.getTradeLegs(eventTicker).length > 0;
  }

  getTradeMeta(eventTicker) {
    const legs = this.getTradeLegs(eventTicker);
    return legs.length ? legs[legs.length - 1] : null;
  }

  listTradedEvents() {
    return Object.entries(this.state.tradedEvents || {}).map(([eventTicker, value]) => ({
      eventTicker,
      ...(value || {}),
    }));
  }

  getTradeLegs(eventTicker) {
    const explicitLegs = Array.isArray(this.state.tradeLegsByEvent?.[eventTicker])
      ? this.state.tradeLegsByEvent[eventTicker]
      : [];
    const fallbackLeg = this.state.tradedEvents?.[eventTicker];
    const legs = explicitLegs.length ? explicitLegs : fallbackLeg ? [fallbackLeg] : [];
    return legs.map((leg, index) => ({
      ...(leg || {}),
      tradeLegId: leg?.tradeLegId || `${eventTicker}#${index + 1}`,
      tradeLegIndex: Number.isFinite(Number(leg?.tradeLegIndex)) ? Number(leg.tradeLegIndex) : index + 1,
    }));
  }

  listTradeLegs() {
    const eventTickers = new Set([
      ...Object.keys(this.state.tradeLegsByEvent || {}),
      ...Object.keys(this.state.tradedEvents || {}),
    ]);
    return Array.from(eventTickers).flatMap((eventTicker) =>
      this.getTradeLegs(eventTicker).map((leg) => ({
        eventTicker,
        ...leg,
      })),
    );
  }

  findTradeMetaByMarketTicker(marketTicker) {
    const entries = this.listTradeLegs().reverse();
    return entries.find((x) => x && x.marketTicker === marketTicker) || null;
  }

  markEventTraded(eventTicker, tradeMeta) {
    delete this.state.rejectedEvents[eventTicker];
    const nextMarkedAt = new Date().toISOString();
    const existingLegs = this.getTradeLegs(eventTicker);
    const targetOrderId = tradeMeta?.orderId ? String(tradeMeta.orderId) : null;
    let updated = false;
    const nextLegs = existingLegs.map((leg, index) => {
      if (updated) return leg;
      if (targetOrderId && String(leg?.orderId || '') === targetOrderId) {
        updated = true;
        return {
          ...leg,
          ...tradeMeta,
          tradeLegId: leg.tradeLegId || `${eventTicker}#${index + 1}`,
          tradeLegIndex: index + 1,
          markedAt: nextMarkedAt,
        };
      }
      return leg;
    });

    if (!updated) {
      nextLegs.push({
        ...tradeMeta,
        tradeLegId: tradeMeta?.tradeLegId || `${eventTicker}#${nextLegs.length + 1}`,
        tradeLegIndex: nextLegs.length + 1,
        markedAt: nextMarkedAt,
      });
    }

    this.state.tradeLegsByEvent[eventTicker] = nextLegs;
    this.state.tradedEvents[eventTicker] = nextLegs[nextLegs.length - 1];
  }

  hasRecoveryTradeForEvent(eventTicker) {
    return this.getTradeLegs(eventTicker).some((leg) => {
      const sizingMode = String(leg?.sizingMode || '').toUpperCase();
      return Boolean(leg?.recoveryQueueId) || sizingMode.startsWith('RECOVERY');
    });
  }

  hasTradeLegForOrderId(orderId) {
    const target = String(orderId || '');
    if (!target) return false;
    return this.listTradeLegs().some((leg) => String(leg?.orderId || '') === target);
  }

  setEventRejected(eventTicker, rejectionMeta) {
    if (!eventTicker || !rejectionMeta) return;
    this.state.rejectedEvents[eventTicker] = {
      ...rejectionMeta,
      markedAt: new Date().toISOString(),
    };
  }

  getEventRejection(eventTicker) {
    const value = this.state.rejectedEvents?.[eventTicker];
    if (!value) return null;
    const untilTs = Number(value.untilTs || 0);
    if (Number.isFinite(untilTs) && untilTs > Date.now()) return value;
    delete this.state.rejectedEvents[eventTicker];
    return null;
  }

  hasRecentEventRejection(eventTicker) {
    return Boolean(this.getEventRejection(eventTicker));
  }

  clearEventRejection(eventTicker) {
    delete this.state.rejectedEvents[eventTicker];
  }

  setEventOpenOrder(eventTicker, orderId) {
    if (!eventTicker || !orderId) return;
    const payload =
      typeof orderId === 'object'
        ? {
            ...orderId,
            markedAt: new Date().toISOString(),
          }
        : {
            orderId,
            markedAt: new Date().toISOString(),
          };
    this.state.openOrderIdsByEvent[eventTicker] = payload;
  }

  getEventOpenOrder(eventTicker) {
    const value = this.state.openOrderIdsByEvent[eventTicker];
    if (!value) return null;
    if (typeof value === 'string') {
      return { orderId: value };
    }
    return value;
  }

  clearEventOpenOrder(eventTicker) {
    delete this.state.openOrderIdsByEvent[eventTicker];
  }

  listOpenOrders() {
    return Object.entries(this.state.openOrderIdsByEvent || {}).map(([eventTicker, value]) => ({
      eventTicker,
      ...(typeof value === 'string' ? { orderId: value } : value),
    }));
  }

  getDailyLossUsd(nowMs, timezone) {
    const key = toISODateInTz(nowMs, timezone);
    return this.state.dailyLossByDate[key] || 0;
  }

  setDailyLossUsd(nowMs, timezone, lossUsd) {
    const key = toISODateInTz(nowMs, timezone);
    this.state.dailyLossByDate[key] = Number(lossUsd.toFixed(2));
  }
}

module.exports = { StateStore, toISODateInTz };
