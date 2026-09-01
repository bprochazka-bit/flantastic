'use strict';

/*
 * Tiny leveled logger -> stdout/stderr (so `journalctl -u flantastic` or the
 * terminal shows what's happening). Set LOG_LEVEL=error|warn|info|debug
 * (default info).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 2;

function emit(level, scope, args) {
  if (LEVELS[level] > current) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(prefix, ...args);
}

// logger('mac') -> { error, warn, info, debug }
module.exports = function logger(scope) {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
  };
};
