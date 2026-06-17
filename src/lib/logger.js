const LEVELS = ['debug', 'info', 'warn', 'error'];

const levelPriority = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const configuredLevel = process.env.LOG_LEVEL || 'info';

function shouldLog(level) {
  return levelPriority[level] >= levelPriority[configuredLevel];
}

function formatMessage(level, message, meta) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
  };

  if (meta !== undefined) {
    entry.meta = meta;
  }

  return JSON.stringify(entry);
}

function write(level, message, meta) {
  if (!shouldLog(level)) {
    return;
  }

  const output = formatMessage(level, message, meta);

  if (level === 'error') {
    process.stderr.write(`${output}\n`);
    return;
  }

  process.stdout.write(`${output}\n`);
}

const logger = {};

for (const level of LEVELS) {
  logger[level] = (message, meta) => write(level, message, meta);
}

module.exports = logger;
