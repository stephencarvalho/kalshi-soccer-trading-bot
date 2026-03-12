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

  markEventTraded(eventTicker, tradeMeta) {
    this.state.tradedEvents[eventTicker] = {
      ...tradeMeta,
      markedAt: new Date().toISOString(),
    };
  }

  setEventOpenOrder(eventTicker, orderId) {
    this.state.openOrderIdsByEvent[eventTicker] = orderId;
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
