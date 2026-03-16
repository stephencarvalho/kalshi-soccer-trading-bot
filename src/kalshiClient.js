const axios = require('axios');
const { signRequest } = require('./kalshiAuth');

function toPathWithQuery(urlObj) {
  return `${urlObj.pathname}${urlObj.search || ''}`;
}

function parseFp(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

class KalshiClient {
  constructor({ baseUrl, keyId, privateKey, logger }) {
    this.baseUrl = baseUrl;
    this.keyId = keyId;
    this.privateKey = privateKey;
    this.logger = logger;
    const parsed = new URL(baseUrl);
    this.origin = parsed.origin;
    this.apiBasePath = parsed.pathname.replace(/\/+$/, '');
    this.http = axios.create({
      baseURL: this.origin,
      timeout: 15000,
    });
    this.timeOffsetMs = 0;
  }

  currentTimestampMs() {
    return Math.round(Date.now() + this.timeOffsetMs).toString();
  }

  syncTimeOffset(dateHeader, { log = false } = {}) {
    const serverMs = Date.parse(String(dateHeader || ''));
    if (!Number.isFinite(serverMs)) return false;
    this.timeOffsetMs = serverMs - Date.now();
    if (log) {
      this.logger.warn(
        { timeOffsetMs: this.timeOffsetMs, serverDate: new Date(serverMs).toISOString() },
        'Adjusted Kalshi client clock offset from server Date header',
      );
    }
    return true;
  }

  async request(method, path, { params, data } = {}) {
    const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`;
    const urlObj = new URL(`${this.apiBasePath}${normalizedPath}`, this.origin);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          urlObj.searchParams.set(k, String(v));
        }
      });
    }

    const pathWithQuery = toPathWithQuery(urlObj);
    const signPath = urlObj.pathname;

    const methodUpper = String(method || '').toUpperCase();
    const isRead = methodUpper === 'GET';
    const maxAttempts = isRead ? 3 : 2;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      const ts = this.currentTimestampMs();
      const signature = signRequest({
        method,
        path: signPath,
        timestampMs: ts,
        privateKey: this.privateKey,
      });

      const headers = {
        'KALSHI-ACCESS-KEY': this.keyId,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': signature,
      };

      try {
        const response = await this.http.request({
          method,
          url: pathWithQuery,
          data,
          headers,
        });
        this.syncTimeOffset(response.headers?.date);
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        const details = error.response?.data || error.message;
        const errorCode = error.response?.data?.error?.code;
        const timestampExpired = status === 401 && errorCode === 'header_timestamp_expired';
        const adjustedClock = timestampExpired
          ? this.syncTimeOffset(error.response?.headers?.date, { log: true })
          : false;
        const retriable =
          (isRead && (status === 429 || (status >= 500 && status < 600))) ||
          (timestampExpired && adjustedClock);
        const canRetry = retriable && attempt < maxAttempts;

        this.logger.error(
          { method, path: pathWithQuery, status, details, attempt, maxAttempts, timeOffsetMs: this.timeOffsetMs },
          canRetry ? 'Kalshi API request failed, retrying' : 'Kalshi API request failed',
        );

        if (!canRetry) throw error;
        const backoffMs = 250 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  async getBalance() {
    return this.request('GET', '/portfolio/balance');
  }

  async getSettlements(minTs, maxTs) {
    const out = [];
    let cursor = '';
    do {
      const data = await this.request('GET', '/portfolio/settlements', {
        params: { min_ts: minTs, max_ts: maxTs, limit: 200, cursor },
      });
      const settlements = data.settlements || [];
      out.push(...settlements);
      cursor = data.cursor || '';
    } while (cursor);
    return out;
  }

  async getOpenPositions() {
    const positions = [];
    let cursor = '';
    do {
      const data = await this.request('GET', '/portfolio/positions', {
        params: { settlement_status: 'unsettled', limit: 200, cursor },
      });
      const batch = data.market_positions || data.positions || [];
      positions.push(...batch);
      cursor = data.cursor || '';
    } while (cursor);
    return positions;
  }

  async getOrders(params = {}) {
    const orders = [];
    let cursor = '';
    do {
      const data = await this.request('GET', '/portfolio/orders', {
        params: { ...params, limit: 200, cursor },
      });
      orders.push(...(data.orders || []));
      cursor = data.cursor || '';
    } while (cursor);
    return orders;
  }

  async getOrder(orderId) {
    return this.request('GET', `/portfolio/orders/${orderId}`);
  }

  async cancelOrder(orderId) {
    return this.request('DELETE', `/portfolio/orders/${orderId}`);
  }

  async getOpenEventsWithMarkets() {
    const allEvents = [];
    let cursor = '';
    do {
      const data = await this.request('GET', '/events', {
        params: {
          status: 'open',
          with_nested_markets: true,
          limit: 200,
          cursor,
        },
      });
      allEvents.push(...(data.events || []));
      cursor = data.cursor || '';
    } while (cursor);

    return allEvents;
  }

  async getMarketsByTickers(tickers) {
    const cleaned = Array.from(new Set((tickers || []).filter(Boolean)));
    if (!cleaned.length) return [];
    const out = [];

    for (let i = 0; i < cleaned.length; i += 100) {
      const chunk = cleaned.slice(i, i + 100);
      const data = await this.request('GET', '/markets', {
        params: {
          tickers: chunk.join(','),
          limit: 200,
        },
      });
      out.push(...(data.markets || []));
    }

    return out;
  }

  async createOrder(payload) {
    return this.request('POST', '/portfolio/orders', { data: payload });
  }

  static parseFp = parseFp;
}

module.exports = { KalshiClient, parseFp };
