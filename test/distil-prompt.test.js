// test/distil-prompt.test.js — distil-prompt builder, parser, and schema.
//
// Updated for v2: 3-key schema (adr_candidate removed).
// Covers task 8.16.

import {
  DISTIL_SCHEMA,
  EMPTY_RECORD,
  buildDistilPrompt,
  parseDistilReply,
  parseJsonField,
} from '../src/lib/distil-prompt.js';

// ── DISTIL_SCHEMA shape ──────────────────────────────────────────────────────

describe('DISTIL_SCHEMA', () => {
  test('has exactly three required keys', () => {
    const { required, properties } = DISTIL_SCHEMA;
    for (const key of ['last_worked_summary', 'next_action', 'open_questions']) {
      expect(required).toContain(key);
      expect(properties).toHaveProperty(key);
    }
    expect(required).not.toContain('adr_candidate');
    expect(properties).not.toHaveProperty('adr_candidate');
  });

  test('open_questions is typed as array of strings', () => {
    const { properties } = DISTIL_SCHEMA;
    expect(properties.open_questions.type).toBe('array');
    expect(properties.open_questions.items).toEqual({ type: 'string' });
  });

  test('additionalProperties is false', () => {
    expect(DISTIL_SCHEMA.additionalProperties).toBe(false);
  });
});

// ── EMPTY_RECORD ──────────────────────────────────────────────────────────────

describe('EMPTY_RECORD', () => {
  test('has three keys with empty values — no adr_candidate', () => {
    expect(EMPTY_RECORD.last_worked_summary).toBe('');
    expect(EMPTY_RECORD.next_action).toBe('');
    expect(EMPTY_RECORD.open_questions).toEqual([]);
    expect(EMPTY_RECORD).not.toHaveProperty('adr_candidate');
  });
});

// ── buildDistilPrompt ────────────────────────────────────────────────────────

describe('buildDistilPrompt', () => {
  test('includes PRIOR section with prior fields (3 keys)', () => {
    const prior = {
      last_worked_summary: 'did some work',
      next_action: 'next thing',
      open_questions: ['q1'],
    };
    const result = buildDistilPrompt(prior, []);
    expect(result).toContain('PRIOR:');
    expect(result).toContain('did some work');
    expect(result).toContain('next thing');
    expect(result).toContain('q1');
    // adr_candidate must not appear
    expect(result).not.toContain('adr_candidate');
  });

  test('renders "none" as PRIOR when prior is null', () => {
    const result = buildDistilPrompt(null, []);
    expect(result).toContain('PRIOR:\nnone');
  });

  test('includes SIGNALS section with kind and payload', () => {
    const signals = [
      { kind: 'file', payload: 'src/foo.js' },
      { kind: 'message', payload: 'stop that' },
    ];
    const result = buildDistilPrompt(null, signals);
    expect(result).toContain('SIGNALS:');
    expect(result).toContain('[FILE] src/foo.js');
    expect(result).toContain('[MESSAGE] stop that');
  });

  test('renders "(empty)" when signals array is empty', () => {
    const result = buildDistilPrompt(null, []);
    expect(result).toContain('SIGNALS:\n(empty)');
  });

  test('parses open_questions from a JSON string if needed', () => {
    const prior = {
      last_worked_summary: 'x',
      next_action: 'y',
      open_questions: '["question one"]', // stored as JSON TEXT in SQLite
    };
    const result = buildDistilPrompt(prior, []);
    expect(result).toContain('question one');
  });
});

// ── parseDistilReply ─────────────────────────────────────────────────────────

const VALID_JSON_3 = JSON.stringify({
  last_worked_summary: 'worked on foo',
  next_action: 'fix bar',
  open_questions: ['what about baz'],
});

describe('parseDistilReply — valid inputs (3-key)', () => {
  test('parses a bare 3-key JSON string', () => {
    const result = parseDistilReply(VALID_JSON_3);
    expect(result).not.toBeNull();
    expect(result.last_worked_summary).toBe('worked on foo');
    expect(result.next_action).toBe('fix bar');
    expect(result.open_questions).toEqual(['what about baz']);
    expect(result).not.toHaveProperty('adr_candidate');
  });

  test('parses JSON wrapped in a markdown code fence', () => {
    const wrapped = `\`\`\`json\n${VALID_JSON_3}\n\`\`\``;
    const result = parseDistilReply(wrapped);
    expect(result).not.toBeNull();
    expect(result.next_action).toBe('fix bar');
  });

  test('parses JSON embedded in prose', () => {
    const withProse = `Here is the output:\n${VALID_JSON_3}\nThat is all.`;
    const result = parseDistilReply(withProse);
    expect(result).not.toBeNull();
    expect(result.last_worked_summary).toBe('worked on foo');
  });

  test('silently ignores a 4th key (adr_candidate from older prompt)', () => {
    const with4th = JSON.stringify({
      last_worked_summary: 'a',
      next_action: 'b',
      open_questions: [],
      adr_candidate: 'some decision',
    });
    const result = parseDistilReply(with4th);
    // Should parse successfully (not return null)
    expect(result).not.toBeNull();
    expect(result.last_worked_summary).toBe('a');
    // adr_candidate key is ignored, not forwarded
    expect(result).not.toHaveProperty('adr_candidate');
  });
});

describe('parseDistilReply — invalid / malformed inputs', () => {
  test('returns null for empty string', () => {
    expect(parseDistilReply('')).toBeNull();
  });

  test('returns null for null/undefined', () => {
    expect(parseDistilReply(null)).toBeNull();
    expect(parseDistilReply(undefined)).toBeNull();
  });

  test('returns null for invalid JSON with no extractable object', () => {
    expect(parseDistilReply('this is not json at all')).toBeNull();
  });

  test('returns null when a required key is missing', () => {
    const bad = JSON.stringify({
      last_worked_summary: 'a',
      next_action: 'b',
      // open_questions missing
    });
    expect(parseDistilReply(bad)).toBeNull();
  });

  test('returns null when open_questions is not an array', () => {
    const bad = JSON.stringify({
      last_worked_summary: 'a',
      next_action: 'b',
      open_questions: 'not an array',
    });
    expect(parseDistilReply(bad)).toBeNull();
  });
});

// ── parseJsonField ────────────────────────────────────────────────────────────

describe('parseJsonField', () => {
  test('parses a valid JSON string', () => {
    expect(parseJsonField('["a","b"]', [])).toEqual(['a', 'b']);
  });

  test('returns fallback for invalid JSON', () => {
    expect(parseJsonField('not json', [])).toEqual([]);
  });

  test('returns fallback for null', () => {
    expect(parseJsonField(null, [])).toEqual([]);
  });

  test('returns fallback for undefined', () => {
    expect(parseJsonField(undefined, null)).toBeNull();
  });
});
