const fs = require('fs');
const axios = require('axios');

function parseStoredJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractWebSessionAuthFromStorageState(state) {
  if (!state || typeof state !== 'object') return null;

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const origins = Array.isArray(state.origins) ? state.origins : [];
  const sessionsCookie = cookies.find((cookie) => cookie?.name === 'sessions' && cookie?.value);
  const userIdCookie = cookies.find((cookie) => cookie?.name === 'userId' && cookie?.value);

  let csrfToken = '';
  let userId = userIdCookie?.value || '';

  for (const origin of origins) {
    if (origin?.origin !== 'https://kalshi.com') continue;
    const localStorage = Array.isArray(origin.localStorage) ? origin.localStorage : [];
    const csrfEntry = localStorage.find((item) => item?.name === 'csrfToken' && item?.value);
    const userIdEntry = localStorage.find((item) => item?.name === 'userId' && item?.value);

    if (csrfEntry?.value) {
      const parsedCsrf = parseStoredJson(csrfEntry.value);
      csrfToken = parsedCsrf?.value || csrfEntry.value || '';
    }
    if (userIdEntry?.value) {
      const parsedUserId = parseStoredJson(userIdEntry.value);
      userId = parsedUserId?.value || userIdEntry.value || userId;
    }
  }

  if (!sessionsCookie?.value || !csrfToken || !userId) return null;

  return {
    userId: String(userId).trim(),
    sessionCookie: String(sessionsCookie.value).trim(),
    csrfToken: String(csrfToken).trim(),
  };
}

function loadWebSessionAuthFromFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return extractWebSessionAuthFromStorageState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function resolveWebSessionAuth(cfg) {
  if (cfg.kalshiWebUserId && cfg.kalshiWebSessionCookie && cfg.kalshiWebCsrfToken) {
    return {
      userId: cfg.kalshiWebUserId,
      sessionCookie: cfg.kalshiWebSessionCookie,
      csrfToken: cfg.kalshiWebCsrfToken,
      source: 'env',
    };
  }

  const fileAuth = loadWebSessionAuthFromFile(cfg.kalshiWebAuthStatePath);
  if (fileAuth) {
    return {
      ...fileAuth,
      source: 'auth_state',
    };
  }

  return null;
}

function hasWebSessionConfig(cfg) {
  return Boolean(resolveWebSessionAuth(cfg));
}

class KalshiWebClient {
  constructor({ userId, sessionCookie, csrfToken, logger }) {
    this.userId = userId;
    this.sessionCookie = sessionCookie;
    this.csrfToken = csrfToken;
    this.logger = logger;
    this.http = axios.create({
      baseURL: 'https://api.elections.kalshi.com/v1',
      timeout: 15000,
      headers: {
        accept: 'application/json',
        origin: 'https://kalshi.com',
        referer: 'https://kalshi.com/account/banking',
        'x-csrf-token': csrfToken,
        cookie: `sessions=${sessionCookie}; userId=${userId}`,
      },
    });
  }

  async request(path) {
    try {
      const response = await this.http.get(path);
      return response.data;
    } catch (error) {
      this.logger.warn(
        {
          path,
          status: error.response?.status,
          details: error.response?.data || error.message,
        },
        'Kalshi web session request failed',
      );
      throw error;
    }
  }

  async getDeposits() {
    const data = await this.request(`/users/${this.userId}/deposits`);
    return data.deposits || [];
  }
}

module.exports = {
  KalshiWebClient,
  extractWebSessionAuthFromStorageState,
  loadWebSessionAuthFromFile,
  resolveWebSessionAuth,
  hasWebSessionConfig,
};
