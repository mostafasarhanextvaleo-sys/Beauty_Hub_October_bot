const COLORS = {
  reset: '\x1b[0m',
  info: '\x1b[36m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  dim: '\x1b[2m',
};

function timestamp() {
  return new Date().toISOString();
}

function format(level, color, message) {
  return `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${message}`;
}

const logger = {
  info(message) {
    console.log(format('INFO', COLORS.info, message));
  },
  success(message) {
    console.log(format('OK', COLORS.success, message));
  },
  warn(message) {
    console.warn(format('WARN', COLORS.warn, message));
  },
  error(message, err) {
    console.error(format('ERROR', COLORS.error, message));
    if (err && err.stack) {
      console.error(err.stack);
    } else if (err) {
      console.error(err);
    }
  },
};

module.exports = logger;
