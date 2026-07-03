// src/lib/distil-prompt.js — distil prompt builder, parser, and JSON schema.
//
// DISTIL_SCHEMA is the single source of truth for the 4-key shape; plugin.js
// imports it from here (never duplicates it).

/**
 * JSON Schema for the distiller's structured output.
 * adr_candidate is nullable; open_questions is an array of strings.
 */
export const DISTIL_SCHEMA = {
  type: 'object',
  properties: {
    last_worked_summary: { type: 'string' },
    next_action: { type: 'string' },
    open_questions: {
      type: 'array',
      items: { type: 'string' },
    },
    adr_candidate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['last_worked_summary', 'next_action', 'open_questions', 'adr_candidate'],
  additionalProperties: false,
};

/**
 * The empty record returned when there is no prior state and no signals.
 */
export const EMPTY_RECORD = {
  last_worked_summary: '',
  next_action: '',
  open_questions: [],
  adr_candidate: null,
};

/**
 * Build the distil prompt text (goes in body.parts, separate from body.system).
 *
 * PRIOR is the prior hot_state row (or null for cold start).
 * signals is the array of reduced memory_signal rows.
 *
 * @param {object|null} prior
 * @param {Array<{kind:string,payload:string}>} signals
 * @returns {string}
 */
export function buildDistilPrompt(prior, signals) {
  const priorText = prior
    ? JSON.stringify(
        {
          last_worked_summary: prior.last_worked_summary ?? '',
          next_action: prior.next_action ?? '',
          open_questions: Array.isArray(prior.open_questions)
            ? prior.open_questions
            : parseJsonField(prior.open_questions, []),
          adr_candidate: prior.adr_candidate ?? null,
        },
        null,
        2
      )
    : 'none';

  const signalLines =
    signals && signals.length > 0
      ? signals.map((s) => `[${String(s.kind).toUpperCase()}] ${s.payload}`).join('\n')
      : '(empty)';

  return `PRIOR:\n${priorText}\n\nSIGNALS:\n${signalLines}`;
}

/**
 * Parse the distiller reply text into the 4-key object, or return null if
 * it cannot be parsed or fails the shape check.
 *
 * Tolerant: tries direct JSON.parse first, then extracts from a markdown
 * code fence if that fails.
 *
 * @param {string} text
 * @returns {{ last_worked_summary:string, next_action:string, open_questions:string[], adr_candidate:string|null }|null}
 */
export function parseDistilReply(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  let obj = null;

  // Attempt 1: direct parse
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Attempt 2: extract from markdown code fence
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        obj = JSON.parse(fenceMatch[1].trim());
      } catch { /* fall through */ }
    }

    // Attempt 3: extract first {...} block from prose
    if (!obj) {
      const braceMatch = trimmed.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try {
          obj = JSON.parse(braceMatch[0]);
        } catch { /* fall through */ }
      }
    }
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const { last_worked_summary, next_action, open_questions, adr_candidate } = obj;

  if (typeof last_worked_summary !== 'string') return null;
  if (typeof next_action !== 'string') return null;
  if (!Array.isArray(open_questions)) return null;
  if (adr_candidate !== null && typeof adr_candidate !== 'string') return null;

  return { last_worked_summary, next_action, open_questions, adr_candidate };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Parse a JSON TEXT column value (stored as string in SQLite) into a JS value.
 * Returns `fallback` on any error.
 */
export function parseJsonField(text, fallback) {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
