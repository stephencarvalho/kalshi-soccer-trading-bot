const pino = require('pino');

function shouldUsePrettyTransport() {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NETLIFY) return false;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return false;
  return true;
}

function createLogger(level) {
  const transport = shouldUsePrettyTransport()
    ? {
        target: require.resolve('pino-pretty'),
        options: {
          colorize: true,
          singleLine: true,
          translateTime: 'SYS:standard',
        },
      }
    : undefined;

  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport,
  });
}

module.exports = { createLogger };
