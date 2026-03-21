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
    return Boolean(this.state.tradedEvents[eventTicker]);
  }

  getTradeMeta(eventTicker) {
    return this.state.tradedEvents[eventTicker] || null;
  }

  listTradedEvents() {
    return Object.entries(this.state.tradedEvents || {}).map(([eventTicker, value]) => ({
      eventTicker,
      ...(value || {}),
    }));
  }

  findTradeMetaByMarketTicker(marketTicker) {
    const entries = Object.values(this.state.tradedEvents || {});
    return entries.find((x) => x && x.marketTicker === marketTicker) || null;
  }

  markEventTraded(eventTicker, tradeMeta) {
    delete this.state.rejectedEvents[eventTicker];
    this.state.tradedEvents[eventTicker] = {
      ...tradeMeta,
      markedAt: new Date().toISOString(),
    };
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
