import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chatCompletionEnvelope,
  draftFromRequest,
  normalizeRoute,
  transcriptionFieldFromRequest,
} from '../src/shim.mjs';
import { handyLegacyRequest, handyStructuredRequest } from './helpers.mjs';

/**
 * The response has to be the shape Handy asked for, and Handy asks in two
 * different ways: structured output first, then plain content once structured
 * output has failed. Getting the second one wrong is invisible — Handy parses
 * the JSON, fails to find its field, and pastes the raw JSON as if it were
 * speech.
 */
describe('transcription field discovery', () => {
  it('takes the field name from the schema Handy sent', () => {
    assert.equal(transcriptionFieldFromRequest(handyStructuredRequest()), 'transcription');
  });

  it('follows a renamed field instead of assuming "transcription"', () => {
    // The point of the whole mechanism: upstream renames the property and the
    // shim keeps working without a code change.
    const request = handyStructuredRequest('draft', 'cleaned_up_text');
    assert.equal(transcriptionFieldFromRequest(request), 'cleaned_up_text');
  });

  it('falls back to the first property when the schema has no required list', () => {
    const request = handyStructuredRequest();
    delete request.response_format.json_schema.schema.required;
    assert.equal(transcriptionFieldFromRequest(request), 'transcription');
  });

  it('reads a schema that is inlined instead of nested under "schema"', () => {
    const request = {
      response_format: {
        type: 'json_schema',
        json_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      },
    };
    assert.equal(transcriptionFieldFromRequest(request), 'text');
  });

  it('reports legacy mode when there is no response_format at all', () => {
    assert.equal(transcriptionFieldFromRequest(handyLegacyRequest()), null);
  });

  it('reports legacy mode for a response_format with no schema', () => {
    assert.equal(transcriptionFieldFromRequest({ response_format: { type: 'text' } }), null);
    assert.equal(transcriptionFieldFromRequest({}), null);
    assert.equal(transcriptionFieldFromRequest(null), null);
  });

  it('ignores a required list that holds no usable name', () => {
    const request = handyStructuredRequest();
    request.response_format.json_schema.schema.required = ['', 42];
    request.response_format.json_schema.schema.properties = {};
    assert.equal(transcriptionFieldFromRequest(request), null);
  });
});

describe('chat completion envelope', () => {
  it('puts the content where Handy reads it', () => {
    const envelope = chatCompletionEnvelope({
      content: 'hello',
      model: 'whatever',
      createdSec: 1_700_000_000,
      id: 'chatcmpl-test',
    });

    // llm_client.rs deserializes exactly this path and nothing else.
    assert.equal(envelope.choices[0].message.content, 'hello');
    assert.equal(envelope.choices[0].message.role, 'assistant');
    assert.equal(envelope.choices[0].finish_reason, 'stop');
    assert.equal(envelope.object, 'chat.completion');
    assert.equal(envelope.model, 'whatever');
    // Round-trips through JSON without losing anything, which is the only
    // property that matters to a client that is not Handy.
    assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope);
  });
});

describe('draft extraction', () => {
  it('takes the last user message', () => {
    assert.equal(draftFromRequest(handyStructuredRequest('what I said')), 'what I said');
  });

  it('returns null when there is no user message to read', () => {
    assert.equal(draftFromRequest({ messages: [{ role: 'system', content: 'x' }] }), null);
    assert.equal(draftFromRequest({}), null);
  });
});

describe('route normalization', () => {
  it('accepts the base URL Handy is configured with', () => {
    assert.equal(normalizeRoute('/v1/chat/completions'), '/chat/completions');
  });

  it('accepts the same path without the /v1 prefix', () => {
    // Someone will set the base URL without /v1 eventually; refusing that is a
    // confusing 404 in exchange for nothing.
    assert.equal(normalizeRoute('/chat/completions'), '/chat/completions');
  });

  it('drops the query string and a trailing slash', () => {
    assert.equal(normalizeRoute('/v1/health?verbose=1'), '/health');
    assert.equal(normalizeRoute('/v1/models/'), '/models');
    assert.equal(normalizeRoute('/v1'), '/');
  });

  it('does not mistake a longer segment for the /v1 prefix', () => {
    assert.equal(normalizeRoute('/v1beta/chat/completions'), '/v1beta/chat/completions');
  });
});
