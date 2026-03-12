const pino = require('pino');

function createLogger(level) {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:standard',
            },
          }
        : undefined,
  });
}

module.exports = { createLogger };
