const serverless = require('serverless-http');
const { app } = require('../../src/monitorServer');

const handler = serverless(app);

exports.handler = async (event, context) => {
  const splat = String(event.pathParameters?.splat || '').replace(/^\/+/, '');
  const apiPath = `/api/${splat}`.replace(/\/+$/, '');
  const normalizedPath = apiPath === '/api' ? '/api/' : apiPath;
  const normalizedEvent = {
    ...event,
    path: normalizedPath,
    rawUrl: event.rawUrl ? event.rawUrl.replace(event.path, normalizedPath) : event.rawUrl,
  };

  return handler(normalizedEvent, context);
};
