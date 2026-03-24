const serverless = require('serverless-http');
const { app } = require('../../src/monitorServer');

const handler = serverless(app);

function extractRequestedPath(event) {
  const rawPath = event.path || event.rawPath || '';
  
  if (rawPath.startsWith('/.netlify/functions/monitor/')) {
    const suffix = rawPath.slice('/.netlify/functions/monitor/'.length);
    return `/api/${suffix}`.replace(/\/+$/, '') || '/api/';
  }

  if (rawPath === '/.netlify/functions/monitor') {
    return '/api/';
  }

  if (rawPath.startsWith('/api/')) return rawPath.replace(/\/+$/, '') || '/api/';
  if (rawPath === '/api') return '/api/';

  const splat = String(event.pathParameters?.splat || '').replace(/^\/+/, '');
  return splat ? `/api/${splat}`.replace(/\/+$/, '') : '/api/';
}

exports.handler = async (event, context) => {
  const normalizedPath = extractRequestedPath(event);
  const normalizedEvent = {
    ...event,
    path: normalizedPath,
    rawUrl: event.rawUrl ? event.rawUrl.replace(event.path, normalizedPath) : event.rawUrl,
  };

  return handler(normalizedEvent, context);
};
