// test/distil-prompt.test.js — distil-prompt builder, parser, and schema.

import {
  DISTIL_SCHEMA,
  EMPTY_RECORD,
  buildDistilPrompt,
  parseDistilReply,
  parseJsonField,
} from '../src/lib/distil-prompt.js';

// ── DISTIL_SCHEMA shape ──────────────────────────────────────────────────────

describe('DISTIL_SCHEMA', () => {
  test('has the four required keys', () => {
    const { required, properties } = DISTIL_SCHEMA;
    for (const key of ['last_worked_summary', 'next_action', 'open_questions', 'adr_candidate']) {
      expect(required).toContain(key);
      expect(properties).toHaveProperty(key);
    }
  });

  test('open_questions is typed as array of strings', () => {
    const { properties } = DISTIL_SCHEMA;
    expect(properties.open_questions.type).toBe('array');
    expect(properties.open_questions.items).toEqual({ type: 'string' });
  });

  test('adr_candidate is nullable (anyOf string|null)', () => {
    const { properties } = DISTIL_SCHEMA;
    const adr = properties.adr_candidate;
    // Must support null — expressed as anyOf or type array
    const supportsNull =
      (Array.isArray(adr.anyOf) &&
        adr.anyOf.some((s) => s.type === 'null')) ||
      (Array.isArray(adr.type) && adr.type.includes('null'));
    expect(supportsNull).toBe(true);
  });

  test('additionalProperties is false', () => {
    expect(DISTIL_SCHEMA.additionalProperties).toBe(false);
  });
});

// ── EMPTY_RECORD ──────────────────────────────────────────────────────────────

describe('EMPTY_RECORD', () => {
  test('has the four keys with empty/null values', () => {
    expect(EMPTY_RECORD.last_worked_summary).toBe('');
    expect(EMPTY_RECORD.next_action).toBe('');
    expect(EMPTY_RECORD.open_questions).toEqual([]);
    expect(EMPTY_RECORD.adr_candidate).toBeNull();
  });
});

// ── buildDistilPrompt ────────────────────────────────────────────────────────

describe('buildDistilPrompt', () => {
  test('includes PRIOR section with prior fields', () => {
    const prior = {
      last_worked_summary: 'did some work',
      next_action: 'next thing',
      open_questions: ['q1'],
      adr_candidate: null,
    };
    const result = buildDistilPrompt(prior, []);
    expect(result).toContain('PRIOR:');
    expect(result).toContain('did some work');
    expect(result).toContain('next thing');
    expect(result).toContain('q1');
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
      adr_candidate: null,
    };
    const result = buildDistilPrompt(prior, []);
    expect(result).toContain('question one');
  });
});

// ── parseDistilReply ─────────────────────────────────────────────────────────

const VALID_JSON = JSON.stringify({
  last_worked_summary: 'worked on foo',
  next_action: 'fix bar',
  open_questions: ['what about baz'],
  adr_candidate: null,
});

describe('parseDistilReply — valid inputs', () => {
  test('parses a bare JSON string', () => {
    const result = parseDistilReply(VALID_JSON);
    expect(result).not.toBeNull();
    expect(result.last_worked_summary).toBe('worked on foo');
    expect(result.next_action).toBe('fix bar');
    expect(result.open_questions).toEqual(['what about baz']);
    expect(result.adr_candidate).toBeNull();
  });

  test('parses JSON wrapped in a markdown code fence', () => {
    const wrapped = `\`\`\`json\n${VALID_JSON}\n\`\`\``;
    const result = parseDistilReply(wrapped);
    expect(result).not.toBeNull();
    expect(result.next_action).toBe('fix bar');
  });

  test('parses JSON embedded in prose', () => {
    const withProse = `Here is the output:\n${VALID_JSON}\nThat is all.`;
    const result = parseDistilReply(withProse);
    expect(result).not.toBeNull();
    expect(result.last_worked_summary).toBe('worked on foo');
  });

  test('accepts a non-null adr_candidate string', () => {
    const withAdr = JSON.stringify({
      last_worked_summary: 'a',
      next_action: 'b',
      open_questions: [],
      adr_candidate: 'consider ADR: use SQLite for persistence',
    });
    const result = parseDistilReply(withAdr);
    expect(result).not.toBeNull();
    expect(result.adr_candidate).toBe('consider ADR: use SQLite for persistence');
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
      adr_candidate: null,
    });
    expect(parseDistilReply(bad)).toBeNull();
  });

  test('returns null when open_questions is not an array', () => {
    const bad = JSON.stringify({
      last_worked_summary: 'a',
      next_action: 'b',
      open_questions: 'not an array',
      adr_candidate: null,
    });
    expect(parseDistilReply(bad)).toBeNull();
  });

  test('returns null when adr_candidate is a number (not string|null)', () => {
    const bad = JSON.stringify({
      last_worked_summary: 'a',
      next_action: 'b',
      open_questions: [],
      adr_candidate: 42,
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
