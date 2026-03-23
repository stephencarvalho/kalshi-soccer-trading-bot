const serverless = require('serverless-http');
const { app } = require('../../src/monitorServer');

const handler = serverless(app);

function extractRequestedPath(event) {
  const candidates = [
    event.rawUrl
      ? (() => {
          try {
            return new URL(event.rawUrl).pathname;
          } catch {
            return '';
          }
        })()
      : '',
    event.path,
    event.rawPath,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith('/api/')) return candidate;
    if (candidate === '/api') return '/api/';
    if (candidate.startsWith('/.netlify/functions/monitor/')) {
      const suffix = candidate.slice('/.netlify/functions/monitor/'.length);
      return `/api/${suffix}`.replace(/\/+$/, '');
    }
    if (candidate === '/.netlify/functions/monitor') return '/api/';
  }

  const splat = String(event.pathParameters?.splat || '').replace(/^\/+/, '');
  if (!splat) return '/api/';
  return `/api/${splat}`.replace(/\/+$/, '');
}

exports.handler = async (event, context) => {
  const normalizedPath = extractRequestedPath(event) || '/api/';
  const normalizedEvent = {
    ...event,
    path: normalizedPath,
    rawUrl: event.rawUrl ? event.rawUrl.replace(event.path, normalizedPath) : event.rawUrl,
  };

  return handler(normalizedEvent, context);
};
