// test/config-file.test.js — Unit and integration tests for JSONC config loading.
//
// Tests cover:
//   - stripJsonc: pure function, unit tested directly
//   - loadConfigFile: file loading, JSONC parsing, error handling
//   - resolveConfig: per-key precedence and validation

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { stripJsonc, loadConfigFile, resolveConfig } from '../src/lib/config.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let _tmpDir;
function getTmpDir() {
  if (!_tmpDir) {
    _tmpDir = join(tmpdir(), `agent-memory-cfg-test-${Date.now()}`);
    mkdirSync(_tmpDir, { recursive: true });
  }
  return _tmpDir;
}

let _fileCounter = 0;
function writeTmpConfig(content) {
  const p = join(getTmpDir(), `cfg-${++_fileCounter}.jsonc`);
  writeFileSync(p, content, 'utf8');
  return p;
}

function absentPath() {
  return join(getTmpDir(), `nonexistent-${++_fileCounter}.jsonc`);
}

// ── 3.1 stripJsonc unit tests ─────────────────────────────────────────────────

describe('stripJsonc', () => {
  test('removes // line comments', () => {
    const input = '{ "a": 1 // inline comment\n}';
    expect(stripJsonc(input)).not.toContain('//');
    // the JSON value should survive
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: 1 });
  });

  test('removes /* */ block comments', () => {
    const input = '{ /* block */ "b": 2 }';
    expect(stripJsonc(input)).not.toContain('/*');
    expect(JSON.parse(stripJsonc(input))).toEqual({ b: 2 });
  });

  test('removes trailing comma before }', () => {
    const input = '{ "c": 3, }';
    expect(stripJsonc(input)).not.toMatch(/,\s*}/);
    expect(JSON.parse(stripJsonc(input))).toEqual({ c: 3 });
  });

  test('removes trailing comma before ]', () => {
    const input = '[1, 2, 3,]';
    expect(stripJsonc(input)).not.toMatch(/,\s*]/);
    expect(JSON.parse(stripJsonc(input))).toEqual([1, 2, 3]);
  });

  test('passes through valid JSON unchanged (no comments, no trailing commas)', () => {
    const input = '{"x": "hello", "y": 42}';
    expect(stripJsonc(input)).toBe(input);
  });

  test('returns empty string for empty input', () => {
    expect(stripJsonc('')).toBe('');
  });
});

// ── 3.2 Absent file → defaults, no warning ───────────────────────────────────

describe('loadConfigFile — absent file', () => {
  test('returns {} silently when file does not exist', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadConfigFile(absentPath());
    expect(result).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── 3.3 Comments-only / empty → defaults, no warning ─────────────────────────

describe('loadConfigFile — empty / comments-only', () => {
  test('returns {} silently for an empty file', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('');
    const result = loadConfigFile(path);
    expect(result).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('returns {} silently for a comments-only file', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('// just a comment\n/* and a block comment */');
    const result = loadConfigFile(path);
    expect(result).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── 3.9 Malformed JSON → warn, defaults ──────────────────────────────────────

describe('loadConfigFile — malformed JSON', () => {
  test('returns {} and warns when JSON is invalid', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('{ not valid json ]');
    const result = loadConfigFile(path);
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });
});

// ── 3.10 Non-object root → warn, defaults ─────────────────────────────────────

describe('loadConfigFile — non-object root', () => {
  test('returns {} and warns when root is a number (42)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('42');
    const result = loadConfigFile(path);
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('returns {} and warns when root is an array', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('[1, 2, 3]');
    const result = loadConfigFile(path);
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('returns {} and warns when root is null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('null');
    const result = loadConfigFile(path);
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });
});

// ── 3.8 JSONC line comments + trailing comma → parses ok ──────────────────────

describe('loadConfigFile — JSONC syntax support', () => {
  test('parses file with // comments and trailing commas successfully', () => {
    const path = writeTmpConfig(`{
  // Agent to track
  "targetAgent": "engineer",
  // Minimum distil interval in ms
  "distilMinIntervalMs": 30000,
}`);
    const result = loadConfigFile(path);
    expect(result).toEqual({ targetAgent: 'engineer', distilMinIntervalMs: 30000 });
  });

  test('parses file with /* */ block comments successfully', () => {
    const path = writeTmpConfig(`{
  /* distiller model setting */
  "distillerModel": "github-copilot/gpt-5-mini"
}`);
    const result = loadConfigFile(path);
    expect(result).toEqual({ distillerModel: 'github-copilot/gpt-5-mini' });
  });
});

// ── resolveConfig — core precedence and validation tests ─────────────────────

// 3.4 Valid targetAgent in file → value used
describe('resolveConfig — targetAgent', () => {
  test('uses file value when no env var set', () => {
    const cfg = resolveConfig({}, { targetAgent: 'architect' });
    expect(cfg.targetAgent).toBe('architect');
  });

  // 3.7 env var wins over file
  test('env var overrides file value', () => {
    const cfg = resolveConfig({ MEMORY_TARGET_AGENT: 'from-env' }, { targetAgent: 'from-file' });
    expect(cfg.targetAgent).toBe('from-env');
  });

  // 3.13 empty string → warn, default
  test('warns and uses default "engineer" when file value is empty string', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveConfig({}, { targetAgent: '' });
    expect(cfg.targetAgent).toBe('engineer');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('uses default "engineer" when neither env nor file set', () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.targetAgent).toBe('engineer');
  });
});

// 3.5 Valid distilMinIntervalMs → value used
describe('resolveConfig — distilMinIntervalMs', () => {
  test('uses file value when no env var set', () => {
    const cfg = resolveConfig({}, { distilMinIntervalMs: 30000 });
    expect(cfg.distilMinIntervalMs).toBe(30000);
  });

  // 3.7 env var wins over file
  test('env var overrides file value', () => {
    const cfg = resolveConfig({ DISTIL_MIN_INTERVAL_MS: '45000' }, { distilMinIntervalMs: 30000 });
    expect(cfg.distilMinIntervalMs).toBe(45000);
  });

  // 3.11 non-numeric → warn, default, other keys unaffected
  test('warns and uses default when file value is a string (non-numeric)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveConfig({}, { distilMinIntervalMs: 'not-a-number', targetAgent: 'architect' });
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(cfg.targetAgent).toBe('architect'); // other keys unaffected
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  // 3.12 zero / negative → warn, default
  test('warns and uses default when file value is 0', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveConfig({}, { distilMinIntervalMs: 0 });
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('warns and uses default when file value is negative', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveConfig({}, { distilMinIntervalMs: -5000 });
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('uses default 60000 when neither env nor file set', () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.distilMinIntervalMs).toBe(60_000);
  });
});

// 3.6 Valid distillerModel string → correct { providerID, modelID }
describe('resolveConfig — distillerModel', () => {
  test('parses file value "provider/model" into { providerID, modelID }', () => {
    const cfg = resolveConfig({}, { distillerModel: 'openai/gpt-4o' });
    expect(cfg.distillerModel).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  // 3.7 env var wins over file
  test('env var overrides file value', () => {
    const cfg = resolveConfig(
      { MEMORY_DISTILLER_MODEL: 'anthropic/claude-3' },
      { distillerModel: 'openai/gpt-4o' }
    );
    expect(cfg.distillerModel).toEqual({ providerID: 'anthropic', modelID: 'claude-3' });
  });

  test('uses default when neither env nor file set', () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.distillerModel).toEqual({ providerID: 'github-copilot', modelID: 'gpt-5-mini' });
  });

  test('falls back to github-copilot provider for bare modelID (no slash)', () => {
    const cfg = resolveConfig({}, { distillerModel: 'gpt-4o' });
    expect(cfg.distillerModel).toEqual({ providerID: 'github-copilot', modelID: 'gpt-4o' });
  });

  test('warns and uses default when file value is empty string', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveConfig({}, { distillerModel: '' });
    expect(cfg.distillerModel).toEqual({ providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });
});

// ── 3.14 Unknown keys → silently ignored ─────────────────────────────────────

describe('resolveConfig — unknown keys', () => {
  test('ignores unknown keys without warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveConfig({}, { unknownKey: 'something', anotherUnknown: 42 });
    // known keys use defaults
    expect(cfg.targetAgent).toBe('engineer');
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(cfg.distillerModel).toEqual({ providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── End-to-end: loadConfigFile + resolveConfig ────────────────────────────────

describe('end-to-end: file load + resolve', () => {
  test('3.4 valid targetAgent in file is used in resolution', () => {
    const path = writeTmpConfig('{"targetAgent": "code-reviewer"}');
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('code-reviewer');
  });

  test('3.5 valid distilMinIntervalMs in file is used in resolution', () => {
    const path = writeTmpConfig('{"distilMinIntervalMs": 120000}');
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.distilMinIntervalMs).toBe(120000);
  });

  test('3.6 valid distillerModel string in file resolves to correct object', () => {
    const path = writeTmpConfig('{"distillerModel": "anthropic/claude-3-5-sonnet"}');
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.distillerModel).toEqual({ providerID: 'anthropic', modelID: 'claude-3-5-sonnet' });
  });

  test('3.7 env var wins over file value for all three keys', () => {
    const path = writeTmpConfig(`{
  "targetAgent": "from-file",
  "distilMinIntervalMs": 30000,
  "distillerModel": "openai/gpt-4o"
}`);
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig(
      {
        MEMORY_TARGET_AGENT: 'env-agent',
        DISTIL_MIN_INTERVAL_MS: '99000',
        MEMORY_DISTILLER_MODEL: 'anthropic/claude',
      },
      fileCfg
    );
    expect(cfg.targetAgent).toBe('env-agent');
    expect(cfg.distilMinIntervalMs).toBe(99000);
    expect(cfg.distillerModel).toEqual({ providerID: 'anthropic', modelID: 'claude' });
  });

  test('3.8 JSONC file with line comments and trailing comma resolves correctly', () => {
    const path = writeTmpConfig(`{
  // which agent to watch
  "targetAgent": "engineer", // trailing comma on this line too
}`);
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('engineer');
  });

  test('3.9 malformed JSON file → warn, all keys use defaults', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('{ bad json !!! }');
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('engineer');
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(cfg.distillerModel).toEqual({ providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('3.10 non-object root → warn, all keys use defaults', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmpConfig('42');
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('engineer');
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(cfg.distillerModel).toEqual({ providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('3.11 distilMinIntervalMs non-numeric → warn for that key, other keys ok', () => {
    const path = writeTmpConfig(`{
  "targetAgent": "architect",
  "distilMinIntervalMs": "oops"
}`);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('architect');         // unaffected
    expect(cfg.distilMinIntervalMs).toBe(60_000);      // fell back
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('3.12 distilMinIntervalMs zero → warn, default used', () => {
    const path = writeTmpConfig('{"distilMinIntervalMs": 0}');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.distilMinIntervalMs).toBe(60_000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('3.13 targetAgent empty string → warn, default "engineer"', () => {
    const path = writeTmpConfig('{"targetAgent": ""}');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('engineer');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[agent-memory]'));
    warnSpy.mockRestore();
  });

  test('3.14 unknown keys in file → silently ignored', () => {
    const path = writeTmpConfig('{"targetAgent": "engineer", "unknownFeature": true}');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fileCfg = loadConfigFile(path);
    const cfg = resolveConfig({}, fileCfg);
    expect(cfg.targetAgent).toBe('engineer');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
