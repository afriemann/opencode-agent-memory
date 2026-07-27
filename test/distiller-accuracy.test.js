// test/distiller-accuracy.test.js — distiller prompt PRIOR vs SIGNALS accuracy tests.
//
// spec: openspec/changes/distiller-accuracy-agent-signals-cost/specs/distiller-accuracy/spec.md
//
// Tests verify the distiller system prompt text contains the contradiction rule
// that makes SIGNALS take precedence over PRIOR when they conflict.
// The LLM's actual output cannot be unit-tested, but the instruction substance
// can be verified against the prompt file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildDistilPrompt } from '../src/lib/distil-prompt.js';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadDistillerPrompt() {
  const raw = readFileSync(join(__dir, '../src/prompts/distiller.md'), 'utf8');
  return raw.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
}

// ── Requirement: PRIOR vs SIGNALS precedence section ─────────────────────────
// spec: openspec/changes/distiller-accuracy-agent-signals-cost/specs/distiller-accuracy/spec.md

describe('distiller prompt — PRIOR vs SIGNALS contradiction rule', () => {
  test('prompt contains a PRIOR vs SIGNALS section', () => {
    const prompt = loadDistillerPrompt();
    expect(prompt).toContain('PRIOR vs SIGNALS');
  });

  test('prompt states that SIGNALS take precedence over PRIOR when they conflict', () => {
    const prompt = loadDistillerPrompt();
    // The contradiction rule must be clearly expressed
    expect(prompt.toLowerCase()).toMatch(/signals.*take precedence|signals.*supersede|signals.*override/i);
  });

  test('prompt distinguishes contradiction (override) from silence (preserve)', () => {
    const prompt = loadDistillerPrompt();
    // The prompt must NOT instruct the distiller to drop all PRIOR content
    // simply because it is absent from SIGNALS — only contradicted content is dropped.
    // Presence of a phrase like "do not address" or "domains that SIGNALS do not" signals the nuance.
    const hasNuance = prompt.includes('do not address') ||
      prompt.includes("don't address") ||
      prompt.includes('SIGNALS do not') ||
      prompt.includes('not mentioned in SIGNALS') ||
      prompt.includes('absent from SIGNALS');
    expect(hasNuance).toBe(true);
  });

  test('SIGNALS description mentions agent messages (decisions, ruled-out approaches)', () => {
    const prompt = loadDistillerPrompt();
    // The SIGNALS description must make clear that agent responses are included
    const mentionsAgent = prompt.includes('agent') ||
      prompt.includes('ruled-out') ||
      prompt.includes('decisions') ||
      prompt.includes('pivots');
    expect(mentionsAgent).toBe(true);
  });
});

// ── buildDistilPrompt renders agent signals with [AGENT] label ────────────────
// spec: openspec/changes/distiller-accuracy-agent-signals-cost/specs/signal-processing/spec.md

describe('buildDistilPrompt — agent signal label', () => {
  test('renders [AGENT] label for agent kind signals', () => {
    const signals = [
      { kind: 'agent', payload: 'Ruling out acpi_osi — SSDT override is the correct approach.' },
    ];
    const result = buildDistilPrompt(null, signals);
    expect(result).toContain('[AGENT]');
    expect(result).toContain('Ruling out acpi_osi');
  });

  test('renders agent signal in SIGNALS section alongside other kinds', () => {
    const signals = [
      { kind: 'file',    payload: 'src/plugin.js' },
      { kind: 'message', payload: 'actually use the SSDT approach' },
      { kind: 'agent',   payload: 'I have ruled out acpi_osi. Switching to SSDT.' },
    ];
    const result = buildDistilPrompt(null, signals);
    expect(result).toContain('[FILE] src/plugin.js');
    expect(result).toContain('[MESSAGE] actually use the SSDT approach');
    expect(result).toContain('[AGENT] I have ruled out acpi_osi');
  });
});
