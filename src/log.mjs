/**
 * Logging, with one rule that is not about formatting: a transcript is speech,
 * and speech does not go into a log file by default.
 *
 * The plan's failure policy is "always loudly" — no silent catch anywhere,
 * because a shim that degrades quietly is indistinguishable from Codex simply
 * mishearing, and that bug survives for months. Loud means the *event* is
 * always logged. It does not mean the *content* is: length is enough to
 * correlate a log line with a dictation, and `SHIM_LOG_TRANSCRIPTS=1` exists
 * for the session where it genuinely is not.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export const LOG_LEVELS = Object.freeze(Object.keys(LEVELS));

export function createLogger({ level = 'info', logTranscripts = false, sink = console } = {}) {
  const threshold = LEVELS[level];
  if (threshold === undefined) {
    throw new Error(`Unknown log level "${level}". Use one of: ${LOG_LEVELS.join(', ')}.`);
  }

  const emit = (name, write) => (message, fields) => {
    if (LEVELS[name] > threshold) return;
    const line = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}`;
    write.call(sink, fields === undefined ? line : `${line} ${format(fields)}`);
  };

  return {
    level,
    logTranscripts,
    error: emit('error', sink.error),
    warn: emit('warn', sink.warn),
    info: emit('info', sink.info ?? sink.log),
    debug: emit('debug', sink.debug ?? sink.log),

    /**
     * Render dictated text for a log line. Returns the length unless the
     * operator has explicitly asked to see the words.
     */
    text(value) {
      if (typeof value !== 'string') return '<none>';
      return logTranscripts ? JSON.stringify(value) : `<${[...value].length} chars>`;
    },
  };
}

/** `key=value` pairs, quoted only where a bare value would be ambiguous. */
function format(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(' ');
}

function renderValue(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  return /^[\w.:/@+-]+$/.test(text) ? text : JSON.stringify(text);
}
