import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clip, createLogger } from '../src/log.mjs';

/**
 * The log is a published surface: it holds speech if allowed to, it is read by
 * a human under time pressure, and on this project it is the only evidence that
 * a dictation degraded rather than Codex mishearing. So the rules about what
 * may go into it are worth pinning down.
 */

function capture(options = {}) {
  const lines = [];
  const push = (line) => lines.push(line);
  const sink = { error: push, warn: push, info: push, debug: push, log: push };
  return { lines, logger: createLogger({ sink, ...options }) };
}

describe('what reaches a log line', () => {
  it('reports the length of speech, not the speech', () => {
    const { logger } = capture();
    assert.equal(logger.text('six ch'), '<6 chars>');
    assert.equal(logger.text(''), '<0 chars>');
    assert.equal(logger.text(undefined), '<none>');
  });

  it('counts characters the way a person would', () => {
    // Not bytes, and not UTF-16 units: an emoji is one thing that was said.
    const { logger } = capture();
    assert.equal(logger.text('привет'), '<6 chars>');
    assert.equal(logger.text('👋'), '<1 chars>');
  });

  it('quotes speech only when explicitly told to', () => {
    const { logger } = capture({ logTranscripts: true });
    assert.equal(logger.text('what I said'), '"what I said"');
  });

  it('keeps one event on one line even when a value contains newlines', () => {
    // Values here come from requests and from other programs' stderr. A value
    // that could break the line could forge a whole log entry, and the reader
    // has no way to tell the forgery from the record.
    const { lines, logger } = capture();
    logger.info('event', { path: '/ok\n2026-01-01 INFO  everything is fine' });

    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('\n'), 'a field value must not be able to start a new line');
    assert.match(lines[0], /\\n/, 'the newline should survive as an escape, not vanish');
  });

  it('leaves simple values unquoted so the common line stays readable', () => {
    const { lines, logger } = capture();
    logger.info('listening', { url: 'http://127.0.0.1:8756', count: 3, ok: true, missing: null });
    assert.match(lines[0], /url=http:\/\/127\.0\.0\.1:8756 count=3 ok=true missing=-/);
  });

  it('honours the level threshold', () => {
    const { lines, logger } = capture({ level: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');
    assert.equal(lines.length, 2);
  });

  it('refuses a level it does not understand instead of guessing one', () => {
    assert.throws(() => createLogger({ level: 'chatty' }), /Unknown log level/);
  });
});

describe('clip', () => {
  it('bounds client-controlled values before they reach a log or an error', () => {
    assert.equal(clip('short'), 'short');
    assert.equal(clip('x'.repeat(200)).length, 121);
    assert.match(clip('x'.repeat(200)), /…$/);
    assert.equal(clip('abcdef', 3), 'abc…');
  });
});
