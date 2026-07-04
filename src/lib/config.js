// src/lib/config.js — JSONC config file loader for opencode-agent-memory.
//
// Loads and parses ~/.config/opencode/agent-memory.jsonc with JSONC support
// (// and /* */ comments + trailing commas). Falls back gracefully on any
// error. Never throws; uses console.warn for degradation notices.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_FILE_PATH = join(homedir(), '.config', 'opencode', 'agent-memory.jsonc');

/**
 * Strip JSONC extensions from a string to produce valid JSON.
 *
 * Accepted subset:
 *   - // line comments (to end of line)
 *   - /* block comments * /
 *   - Trailing commas before } or ]
 *
 * Limitation: string values that contain //, /*, or *\/ will be corrupted.
 * The three documented keys (targetAgent, distilMinIntervalMs, distillerModel)
 * never contain these token sequences, so this is safe for the known keyset.
 *
 * @param {string} str - Raw JSONC string.
 * @returns {string} Cleaned JSON string.
 */
export function stripJsonc(str) {
  return str
    // Remove // line comments (to end of line)
    .replace(/\/\/[^\n]*/g, '')
    // Remove /* */ block comments (including multi-line)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Load and parse the agent-memory config file.
 *
 * Handles all failure modes gracefully:
 *   - Absent file → silent empty object
 *   - Empty or comments-only file → silent empty object
 *   - Parse error → console.warn + empty object
 *   - Non-object root value → console.warn + empty object
 *
 * @param {string} [configPath] - Override config file path (for testing).
 * @returns {object} Parsed config object (may be empty).
 */
export function loadConfigFile(configPath = CONFIG_FILE_PATH) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // File absent — silent defaults
    console.warn(`[agent-memory] could not read config file ${configPath}: ${err.message}`);
    return {};
  }

  const stripped = stripJsonc(raw).trim();
  if (!stripped) return {}; // Empty or comments-only — silent defaults

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    console.warn(
      `[agent-memory] config file ${configPath} contains invalid JSON (after JSONC stripping): ${err.message}`
    );
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      `[agent-memory] config file ${configPath} root value must be a JSON object; ignoring config`
    );
    return {};
  }

  return parsed;
}

/**
 * Resolve the three tuneable plugin values from env vars and file config.
 *
 * Precedence per key (independent per key):
 *   env var > config file value > hardcoded default
 *
 * Per-key type validation: invalid file values emit console.warn and fall
 * back to the hardcoded default; other keys are not affected.
 *
 * @param {object} env - Environment variable map (typically process.env).
 * @param {object} fileCfg - Parsed config file object (from loadConfigFile()).
 * @returns {{
 *   targetAgent: string,
 *   distilMinIntervalMs: number,
 *   distillerModel: { providerID: string, modelID: string }
 * }}
 */
export function resolveConfig(env, fileCfg) {
  // ── targetAgent ──────────────────────────────────────────────────────────
  let targetAgent = 'engineer';
  if (env.MEMORY_TARGET_AGENT !== undefined) {
    targetAgent = env.MEMORY_TARGET_AGENT;
  } else if (fileCfg.targetAgent !== undefined) {
    if (typeof fileCfg.targetAgent === 'string' && fileCfg.targetAgent !== '') {
      targetAgent = fileCfg.targetAgent;
    } else {
      console.warn(
        '[agent-memory] config key "targetAgent" must be a non-empty string; using default "engineer"'
      );
    }
  }

  // ── distilMinIntervalMs ──────────────────────────────────────────────────
  let distilMinIntervalMs = 60_000;
  if (env.DISTIL_MIN_INTERVAL_MS !== undefined) {
    distilMinIntervalMs = Number(env.DISTIL_MIN_INTERVAL_MS);
  } else if (fileCfg.distilMinIntervalMs !== undefined) {
    const v = Number(fileCfg.distilMinIntervalMs);
    if (Number.isFinite(v) && v > 0) {
      distilMinIntervalMs = v;
    } else {
      console.warn(
        '[agent-memory] config key "distilMinIntervalMs" must be a finite positive number; using default 60000'
      );
    }
  }

  // ── distillerModel ───────────────────────────────────────────────────────
  let _modelRaw = 'github-copilot/gpt-5-mini';
  if (env.MEMORY_DISTILLER_MODEL !== undefined) {
    _modelRaw = env.MEMORY_DISTILLER_MODEL;
  } else if (fileCfg.distillerModel !== undefined) {
    if (typeof fileCfg.distillerModel === 'string' && fileCfg.distillerModel !== '') {
      _modelRaw = fileCfg.distillerModel;
    } else {
      console.warn(
        '[agent-memory] config key "distillerModel" must be a non-empty string; using default "github-copilot/gpt-5-mini"'
      );
    }
  }
  const _slash = _modelRaw.indexOf('/');
  const distillerModel =
    _slash >= 0
      ? { providerID: _modelRaw.slice(0, _slash), modelID: _modelRaw.slice(_slash + 1) }
      : { providerID: 'github-copilot', modelID: _modelRaw };

  return { targetAgent, distilMinIntervalMs, distillerModel };
}
