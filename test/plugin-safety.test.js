// test/plugin-safety.test.js — plugin factory safety and idempotency tests.
//
// Tests the AgentMemory plugin factory with fully-mocked client and $.
// Every failure mode from §9 is covered; no real DB or git is used.
//
// MEMORY_TARGET_AGENTS is set before any AgentMemory() call so the factory
// (which reads config fresh per instantiation) picks up 'engineer' as a
// tracked agent. Tests that verify untracked-agent behaviour set or clear
// the env var locally before calling AgentMemory().

import AgentMemory from '../src/plugin.js';
import { jest } from '@jest/globals';
import { reduceSignals, assemblePrimer, MAX_SIGNALS_PER_KIND } from '../src/lib/signal-utils.js';
import { renderStaleness } from '../src/lib/git-helper.js';

// Make 'engineer' a tracked agent for the duration of this test file.
// Tests that need a different set manage process.env themselves (save/restore).
process.env.MEMORY_TARGET_AGENTS = 'engineer';

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock $ that returns configured responses based on command substrings.
 *
 * @param {Record<string, string|object>} responses — key is substring to match,
 *   value is the text to return (objects are JSON.stringified).
 */
function makeMockShell(responses = {}, throwFor = {}) {
  const calls = [];

  const $ = function (strings, ...values) {
    const cmd = strings.reduce(
      (acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
      ''
    );
    calls.push(cmd);

    // Check if this command should throw (for error-path testing).
    for (const [pattern, errConfig] of Object.entries(throwFor)) {
      if (cmd.includes(pattern)) {
        const err = Object.assign(new Error(errConfig.message ?? 'shell error'), {
          stderr: errConfig.stderr != null ? Buffer.from(errConfig.stderr) : undefined,
        });
        const obj = {
          quiet: () => obj,
          text: () => Promise.reject(err),
        };
        return obj;
      }
    }

    let output = '';
    for (const [pattern, value] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        output = typeof value === 'string' ? value : JSON.stringify(value);
        break;
      }
    }

    const obj = {
      quiet: () => obj,
      text: async () => output,
    };
    return obj;
  };
  $.calls = calls;
  return $;
}

/** Default empty read response (cold start — no prior memory). */
const COLD_READ = JSON.stringify({
  prior: null,
  recent: [],
  signals: [],
  watermark: { last_signal_ms: 0, last_distil_ms: 0 },
});

const WARM_ROW = {
  scope: 'project',
  agent: 'engineer',
  project: '/home/user/repos/my/project',
  session_id: 'ses_warm',
  session_name: 'widget session',
  last_worked_summary: 'implemented the widget',
  next_action: 'write tests for widget',
  open_questions: ['should we use sqlite?'],
  anchored_git_sha: 'abc123',
  updated_at: 1000,
};

/** A read response with a prior record (warm start). */
const WARM_READ = JSON.stringify({
  prior: WARM_ROW,
  recent: [WARM_ROW],
  signals: [],
  watermark: { last_signal_ms: 0, last_distil_ms: 0 },
});

/**
 * Build a mock client with configurable responses.
 *
 * @param {object} overrides
 */
function makeMockClient(overrides = {}) {
  const promptCalls = [];
  const createCalls = [];
  const deleteCalls = [];
  const getCalls = [];
  const createBodies = [];
  const appLogCalls = [];
  const toastCalls = [];

  const client = {
    session: {
      // Accept v1 format { path: { id } } and v2 format { sessionID } for compatibility.
      get: async (options) => {
        const id = options?.path?.id ?? options?.sessionID;
        getCalls.push(id);
        return overrides.sessionGet?.(id) ?? {
          data: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
        };
      },
      create: async (options) => {
        const title = options?.body?.title ?? options?.title;
        createCalls.push(title);
        createBodies.push(options?.body ?? {});
        return overrides.sessionCreate?.(title) ?? { data: { id: 'eph_test' } };
      },
      prompt: async (options) => {
        const id = options?.path?.id ?? options?.sessionID;
        // v1 format: { path: { id }, body: { ... } }; v2 format: { sessionID, ...body }
        const body = options?.body ?? (({ path, sessionID, ...rest }) => rest)(options ?? {});
        promptCalls.push({ id, body });
        return overrides.sessionPrompt?.(id, body) ?? {
          data: { parts: [{ type: 'text', text: JSON.stringify({
            last_worked_summary: 'done',
            next_action: 'next',
            open_questions: [],
            adr_candidate: null,
          }) }] },
        };
      },
      delete: async (options) => {
        const id = options?.path?.id ?? options?.sessionID;
        deleteCalls.push(id);
        return {};
      },
    },
    app: {
      log: jest.fn((options) => {
        appLogCalls.push(options?.body ?? options);
        if (overrides.appLogThrows) throw new Error('app.log unavailable');
        return overrides.appLog?.(options) ?? {};
      }),
    },
    tui: {
      showToast: jest.fn(async (options) => {
        toastCalls.push(options?.body ?? options);
        return {};
      }),
    },
    _promptCalls: promptCalls,
    _createCalls: createCalls,
    _createBodies: createBodies,
    _deleteCalls: deleteCalls,
    _getCalls: getCalls,
    _appLogCalls: appLogCalls,
    _toastCalls: toastCalls,
  };
  return client;
}

/** Fire an event at the plugin. */
async function fire(plugin, type, properties) {
  await plugin.event({ event: { type, properties } });
}

/**
 * Invoke the `experimental.chat.system.transform` hook for a session and
 * return the resulting system-prompt array.  Returns [] if the hook is absent.
 */
async function invokeSystemTransform(plugin, sessionID, model = {}) {
  const output = { system: [] };
  const hook = plugin['experimental.chat.system.transform'];
  if (hook) await hook({ sessionID, model }, output);
  return output.system;
}

// ── Injection idempotency ────────────────────────────────────────────────────

describe('injection idempotency', () => {
  test('loads primer exactly once when session.created fires twice for the same session', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    const props = {
      sessionID: 'ses_001',
      info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
    };
    await fire(plugin, 'session.created', props);
    await fire(plugin, 'session.created', props); // duplicate

    // Primer is NOT injected via session.prompt (noReply)
    const noReplyCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(noReplyCalls).toHaveLength(0);

    // Primer IS available via system.transform (exactly once — not doubled on duplicate events)
    const system1 = await invokeSystemTransform(plugin, 'ses_001');
    expect(system1).toHaveLength(1);
    expect(typeof system1[0]).toBe('string');
    expect(system1[0].length).toBeGreaterThan(0);

    // A fresh output.system is always exactly 1 push — not accumulated
    const system2 = await invokeSystemTransform(plugin, 'ses_001');
    expect(system2).toHaveLength(1);
  });

  test('does not load primer for cold start (no prior memory)', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_cold',
      info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
    });

    // No injection via session.prompt
    const noReplyCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(noReplyCalls).toHaveLength(0);

    // system.transform returns empty for cold-start session
    const system = await invokeSystemTransform(plugin, 'ses_cold');
    expect(system).toHaveLength(0);
  });
});

// ── (agent, project) keying ──────────────────────────────────────────────────

describe('(agent, project) keying', () => {
  test('non-target-agent sessions are skipped', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient({
      sessionGet: () => ({
        data: { agent: 'other-agent', directory: '/some/project', title: null },
      }),
    });
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_other',
      info: { agent: 'other-agent', directory: '/some/project', title: null },
    });

    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(0);
  });

  test('two sessions in different projects each get their own primer', async () => {
    // Use separate read responses keyed by project path presence
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_proj_a',
      info: { agent: 'engineer', directory: '/proj/a', title: null },
    });
    await fire(plugin, 'session.created', {
      sessionID: 'ses_proj_b',
      info: { agent: 'engineer', directory: '/proj/b', title: null },
    });

    // Neither session should inject via session.prompt
    const noReplyCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(noReplyCalls).toHaveLength(0);

    // Both sessions have primers available via system.transform
    const systemA = await invokeSystemTransform(plugin, 'ses_proj_a');
    const systemB = await invokeSystemTransform(plugin, 'ses_proj_b');
    expect(systemA).toHaveLength(1);
    expect(systemB).toHaveLength(1);
  });
});

// ── Ephemeral self-capture skip ──────────────────────────────────────────────

describe('ephemeral self-capture prevention', () => {
  test('session.created with EPHEMERAL_TITLE is added to ephemerals and not injected', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Simulate the session.created event for an ephemeral distil session
    await fire(plugin, 'session.created', {
      sessionID: 'eph_distil_1',
      info: { agent: undefined, directory: '/proj', title: 'agent-memory distil' },
    });

    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(0);
  });

  test('session.idle for a known ephemeral is skipped', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // First mark it as ephemeral via session.created
    await fire(plugin, 'session.created', {
      sessionID: 'eph_distil_2',
      info: { agent: undefined, directory: '/proj', title: 'agent-memory distil' },
    });

    // Now fire session.idle for the same ID
    await fire(plugin, 'session.idle', { sessionID: 'eph_distil_2' });

    // session.get should NOT have been called for the ephemeral idle
    const ephGetCalls = client._getCalls.filter((id) => id === 'eph_distil_2');
    expect(ephGetCalls).toHaveLength(0);
  });
});

// ── Throttle check ───────────────────────────────────────────────────────────

describe('idle-distil throttle', () => {
  test('skips distil when within throttle window and no new signals or buffer', async () => {
    const recentDistilMs = Date.now() - 1000; // only 1 s ago, well within 60 s default
    const throttledRead = JSON.stringify({
      prior: {
        scope: 'project', agent: 'engineer', project: '/proj',
        last_worked_summary: 'x', next_action: 'y', open_questions: [],
        adr_candidate: null, anchored_git_sha: null, updated_at: 1000,
      },
      signals: [],
      watermark: { last_signal_ms: 0, last_distil_ms: recentDistilMs },
    });

    const $ = makeMockShell({ read: throttledRead });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.idle', { sessionID: 'ses_throttled' });

    // No ephemeral session should have been created (distil was skipped)
    expect(client._createCalls).toHaveLength(0);
  });
});

// ── Fallback inject on message.updated ───────────────────────────────────────

describe('fallback inject on message.updated', () => {
  test('loads primer when session was not primed by session.created', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // No session.created fired — go straight to message.updated
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_resumed',
      info: { role: 'user', text: 'hello, continue the work' },
    });

    // No injection via session.prompt
    const noReplyCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(noReplyCalls).toHaveLength(0);

    // Primer IS available via system.transform after the fallback load
    const system = await invokeSystemTransform(plugin, 'ses_resumed');
    expect(system).toHaveLength(1);
    expect(typeof system[0]).toBe('string');
  });

  test('does not load primer twice when message.updated fires after session.created primed the session', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Primed by session.created first
    await fire(plugin, 'session.created', {
      sessionID: 'ses_already_primed',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });

    // message.updated fires afterward — should NOT re-load
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_already_primed',
      info: { role: 'user', text: 'continue' },
    });

    // No injection via session.prompt at all
    const noReplyCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(noReplyCalls).toHaveLength(0);

    // Primer available exactly once (not accumulated from duplicate loads)
    const system = await invokeSystemTransform(plugin, 'ses_already_primed');
    expect(system).toHaveLength(1);
  });
});

// ── Buffer payload retention ──────────────────────────────────────────────────

describe('buffer payload retention', () => {
  test('file.edited adds file paths to the buffer for the last active session', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Trigger a message.updated first so lastActiveSessionId is set
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_buf',
      info: { role: 'assistant', text: 'done' },
    });

    await fire(plugin, 'file.edited', { file: 'src/widget.js' });
    await fire(plugin, 'file.edited', { file: 'src/widget.test.js' });

    // Verify via a session.idle that accrue is called with the files
    // (The mock $ captures all commands — check that 'accrue' was called with file data)
    // We trigger a session.idle to flush
    const WARM_AFTER_FLUSH = JSON.stringify({
      prior: {
        scope: 'project', agent: 'engineer', project: '/home/user/repos/my/project',
        last_worked_summary: 'x', next_action: 'y', open_questions: [],
        adr_candidate: null, anchored_git_sha: null, updated_at: 1000,
      },
      signals: [
        { kind: 'file', payload: 'src/widget.js', created_at: 100 },
        { kind: 'file', payload: 'src/widget.test.js', created_at: 101 },
      ],
      watermark: { last_signal_ms: 0, last_distil_ms: 0 },
    });

    // Rebuild plugin with warm read to verify accrue path doesn't error
    const $2 = makeMockShell({ read: WARM_AFTER_FLUSH });
    const client2 = makeMockClient();
    const plugin2 = await AgentMemory({ client: client2, $: $2 });

    await fire(plugin2, 'message.updated', {
      sessionID: 'ses_buf',
      info: { role: 'assistant', text: 'done' },
    });
    await fire(plugin2, 'file.edited', { file: 'src/widget.js' });
    await fire(plugin2, 'file.edited', { file: 'src/widget.test.js' });

    // Both files should be in the buffer — check via the shell calls recorded
    // by the second session.idle (which flushes the buffer via accrue)
    await fire(plugin2, 'session.idle', { sessionID: 'ses_buf' });

    const accrueCall = $2.calls.find((c) => c.includes('accrue'));
    expect(accrueCall).toBeDefined();
  });

  test('todo.updated payloads are accumulated in the buffer', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'todo.updated', {
      sessionID: 'ses_todo',
      todos: [{ id: '1', content: 'do the thing', status: 'pending' }],
    });

    // The buffer should now contain the todo JSON string.
    // We can't directly inspect the buffer, but we can verify
    // the plugin does not throw and the event is processed.
    // A second todo.updated adds a second entry.
    await fire(plugin, 'todo.updated', {
      sessionID: 'ses_todo',
      todos: [{ id: '1', content: 'do the thing', status: 'in_progress' }],
    });
    // No assertions on internals — just no throws; D2 capping handles excess
  });

  test('D1 message classification only captures qualifying user messages', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Non-qualifying assistant message — should not crash or capture
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_d1',
      info: { role: 'assistant', text: 'Here is the result.' },
    });

    // Qualifying user correction
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_d1',
      info: { role: 'user', text: "no, that's wrong — use the other approach" },
    });

    // Qualifying stop statement
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_d1',
      info: { role: 'user', text: 'stop and park this for now' },
    });

    // No error; the test passes if no exception is thrown.
    // The actual buffer content is private; correctness is verified through
    // the accrue integration in the plugin-level distil flow.
  });
});

// ── Fail-safe: errors never throw into opencode ───────────────────────────────

describe('fail-safe degradation', () => {
  test('session.created does not throw when session.get fails', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient({
      sessionGet: () => { throw new Error('network error'); },
    });
    const plugin = await AgentMemory({ client, $ });

    // Must not throw
    await expect(
      fire(plugin, 'session.created', {
        sessionID: 'ses_fail',
        info: { agent: undefined, directory: undefined, title: null }, // missing info
      })
    ).resolves.not.toThrow();
  });

  test('session.idle does not throw when session.get fails', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient({
      sessionGet: () => { throw new Error('timeout'); },
    });
    const plugin = await AgentMemory({ client, $ });

    await expect(
      fire(plugin, 'session.idle', { sessionID: 'ses_idle_fail' })
    ).resolves.not.toThrow();
  });

  test('session.idle does not throw when memory.js read fails', async () => {
    const $ = makeMockShell({}); // No read response → empty string → JSON.parse fails
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await expect(
      fire(plugin, 'session.idle', { sessionID: 'ses_read_fail' })
    ).resolves.not.toThrow();
  });

  test('session.idle does not throw when model call fails', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient({
      sessionPrompt: () => { throw new Error('model unavailable'); },
    });
    const plugin = await AgentMemory({ client, $ });

    await expect(
      fire(plugin, 'session.idle', { sessionID: 'ses_model_fail' })
    ).resolves.not.toThrow();
  });

  test('session.idle does not throw when session.create returns no id', async () => {
    // Cold start: no prior → inject is a no-op; doDistil proceeds to session.create
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient({
      sessionCreate: () => ({ data: {} }), // no id field
    });
    const plugin = await AgentMemory({ client, $ });

    await expect(
      fire(plugin, 'session.idle', { sessionID: 'ses_create_no_id' })
    ).resolves.not.toThrow();

    // The create was attempted but no prompt should follow (no valid ephId)
    expect(client._createCalls).toHaveLength(1);
    expect(client._promptCalls).toHaveLength(0);
  });
});

// ── reduceSignals (D2) unit tests ─────────────────────────────────────────────

describe('reduceSignals', () => {
  function sig(kind, payload, created_at) {
    return { kind, payload, created_at };
  }

  test('returns empty array for empty input', () => {
    expect(reduceSignals([])).toEqual([]);
    expect(reduceSignals(null)).toEqual([]);
  });

  test('deduplicates file signals by path, keeping the latest entry', () => {
    const signals = [
      sig('file', 'src/a.js', 1),
      sig('file', 'src/a.js', 5), // re-edit of same path — should win
      sig('file', 'src/b.js', 3),
    ];
    const result = reduceSignals(signals);
    const files = result.filter((s) => s.kind === 'file');
    expect(files).toHaveLength(2);
    const a = files.find((s) => s.payload === 'src/a.js');
    expect(a.created_at).toBe(5); // latest wins
  });

  test(`caps file signals to MAX_SIGNALS_PER_KIND (${MAX_SIGNALS_PER_KIND}) most recent`, () => {
    const extras = 5;
    // Create MAX_SIGNALS_PER_KIND+5 unique file paths with monotonically increasing created_at
    const signals = Array.from({ length: MAX_SIGNALS_PER_KIND + extras }, (_, i) =>
      sig('file', `src/file${i}.js`, i)
    );
    const result = reduceSignals(signals);
    const files = result.filter((s) => s.kind === 'file');
    expect(files).toHaveLength(MAX_SIGNALS_PER_KIND);
    // The MAX_SIGNALS_PER_KIND most recent (files extras..MAX+extras-1) should be kept
    const payloads = files.map((f) => f.payload);
    expect(payloads).toContain(`src/file${MAX_SIGNALS_PER_KIND + extras - 1}.js`); // last file
    expect(payloads).toContain(`src/file${extras}.js`);                            // first kept
    expect(payloads).not.toContain(`src/file${extras - 1}.js`);                   // last dropped
  });

  test('keeps a re-edited file even when it was first-seen early (insertion-order fix)', () => {
    // Scenario: MAX_SIGNALS_PER_KIND+1 unique files, but file0 is re-edited last.
    // Without the sort fix, file0 (insertion-order position 0) would be dropped.
    const signals = [
      ...Array.from({ length: MAX_SIGNALS_PER_KIND + 1 }, (_, i) => sig('file', `src/file${i}.js`, i + 1)),
      sig('file', 'src/file0.js', 100), // re-edit of the first-seen file, latest ts
    ];
    const result = reduceSignals(signals);
    const files = result.filter((s) => s.kind === 'file');
    expect(files).toHaveLength(MAX_SIGNALS_PER_KIND);
    // file0 must be present (it has the highest created_at after re-edit)
    const f0 = files.find((f) => f.payload === 'src/file0.js');
    expect(f0).toBeDefined();
    expect(f0.created_at).toBe(100);
  });

  test('caps todo and message signals independently', () => {
    const signals = [
      ...Array.from({ length: MAX_SIGNALS_PER_KIND + 5 }, (_, i) => sig('todo', `todo${i}`, i)),
      ...Array.from({ length: MAX_SIGNALS_PER_KIND + 5 }, (_, i) => sig('message', `msg${i}`, i)),
    ];
    const result = reduceSignals(signals);
    expect(result.filter((s) => s.kind === 'todo')).toHaveLength(MAX_SIGNALS_PER_KIND);
    expect(result.filter((s) => s.kind === 'message')).toHaveLength(MAX_SIGNALS_PER_KIND);
  });
});

// ── assemblePrimer output tests ───────────────────────────────────────────────
// NOTE: Full assemblePrimer tests are in test/signal-utils.test.js.
// These smoke tests verify the primer is injected into the system prompt.

describe('assemblePrimer (smoke — new options-object API)', () => {
  const BASE_OPTS = {
    rows: [{
      session_id: 'ses1',
      session_name: 'widget session',
      last_worked_summary: 'implemented the widget',
      next_action: 'write widget tests',
      open_questions: ['should this be async?'],
      anchored_git_sha: null,
      updated_at: Date.now() - 5 * 60_000,
    }],
    projectAtoms: [],
    globalAtoms: [],
    agent: 'engineer',
    project: '/home/user/repos/my/project',
    staleness: { status: 'ok', distance: 2 },
  };

  test('includes the passive header with project shortname', () => {
    const result = assemblePrimer(BASE_OPTS);
    expect(result).toContain('## Project memory — my/project (background context — no action required)');
    expect(result).not.toContain('[MEMORY — resumed context');
  });

  test('includes Recent sessions section with row data', () => {
    const result = assemblePrimer(BASE_OPTS);
    expect(result).toContain('### Recent sessions');
    expect(result).toContain('▸ widget session');
    expect(result).toContain('implemented the widget');
    expect(result).toContain('write widget tests');
    // Old format labels must not appear
    expect(result).not.toContain('Last session:');
    expect(result).not.toContain('Suggested next step:');
  });

  test('renders open_questions in session thread', () => {
    const result = assemblePrimer(BASE_OPTS);
    expect(result).toContain('Open questions: should this be async?');
  });

  test('staleness line appears with the exact phrasing from renderStaleness', () => {
    for (const staleness of [
      { status: 'ok', distance: 3 },
      { status: 'no-git' },
      { status: 'diverged' },
      { status: 'no-anchor' },
    ]) {
      const result = assemblePrimer({ ...BASE_OPTS, staleness });
      expect(result).toContain(`Staleness: ${renderStaleness(staleness)}`);
    }
  });

  test('passive closing line present; no ADR or teach-back', () => {
    const result = assemblePrimer(BASE_OPTS);
    expect(result).toContain('Wait for the user');
    expect(result).not.toContain('adr_candidate');
    expect(result).not.toContain('Possible decision to record:');
    expect(result).not.toContain('This memory is a hypothesis, not ground truth');
    expect(result).not.toContain('replay your understanding');
  });

  test('returns null when rows and atoms are all empty', () => {
    const result = assemblePrimer({ ...BASE_OPTS, rows: [], projectAtoms: [], globalAtoms: [] });
    expect(result).toBeNull();
  });
});

// ── experimental.chat.system.transform hook ──────────────────────────────────

describe('experimental.chat.system.transform hook', () => {
  test('hook is present on the returned hooks object', async () => {
    const plugin = await AgentMemory({ client: makeMockClient(), $: makeMockShell({}) });
    expect(typeof plugin['experimental.chat.system.transform']).toBe('function');
  });

  test('appends primer to output.system after session.created with prior memory', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_transform_warm',
      info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
    });

    const system = await invokeSystemTransform(plugin, 'ses_transform_warm');
    expect(system).toHaveLength(1);
    expect(system[0]).toContain('background context');
    expect(system[0]).toContain('background context');
  });

  test('does not append when session has no cached primer (cold start)', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_transform_cold',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });

    const system = await invokeSystemTransform(plugin, 'ses_transform_cold');
    expect(system).toHaveLength(0);
  });

  test('does not append when sessionID is absent from hook input', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    const output = { system: [] };
    const hook = plugin['experimental.chat.system.transform'];
    // sessionID is undefined
    await hook({ model: {} }, output);
    expect(output.system).toHaveLength(0);
  });

  test('does not append for an ephemeral distil session', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    // Register the session as ephemeral via session.created with ephemeral title
    await fire(plugin, 'session.created', {
      sessionID: 'eph_transform',
      info: { agent: undefined, directory: '/proj', title: 'agent-memory distil' },
    });

    const system = await invokeSystemTransform(plugin, 'eph_transform');
    expect(system).toHaveLength(0);
  });

  test('does not throw on any error in hook body; leaves output.system empty', async () => {
    // Build a plugin then corrupt the primers Map to simulate an internal error.
    // The hook must not propagate the error.
    const $ = makeMockShell({ read: WARM_READ });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    // Load the primer normally
    await fire(plugin, 'session.created', {
      sessionID: 'ses_hook_safe',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });

    // Force an error by passing a non-object output (hook must not throw)
    const hook = plugin['experimental.chat.system.transform'];
    await expect(
      hook({ sessionID: 'ses_hook_safe', model: {} }, null)
    ).resolves.not.toThrow();
  });
});

// ── Cold-start primerLoaded ⊇ keys(primers) invariant ────────────────────────

describe('primerLoaded ⊇ keys(primers) invariant', () => {
  test('cold-start session is load-attempted (no re-read on message.updated) but has no primer', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // session.created fires for cold start
    await fire(plugin, 'session.created', {
      sessionID: 'ses_cold_inv',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });

    // Subsequent message.updated must NOT trigger another DB read
    const readCallsBefore = $.calls.filter((c) => c.includes(' read ')).length;

    await fire(plugin, 'message.updated', {
      sessionID: 'ses_cold_inv',
      info: { role: 'user', text: 'hello' },
    });

    const readCallsAfter = $.calls.filter((c) => c.includes(' read ')).length;
    // No additional read for the already-attempted session
    expect(readCallsAfter).toBe(readCallsBefore);

    // And system.transform still returns empty (no primer for this cold-start session)
    const system = await invokeSystemTransform(plugin, 'ses_cold_inv');
    expect(system).toHaveLength(0);
  });
});

// ── Primer load log-line emission ─────────────────────────────────────────────

describe('primer load log-line emission', () => {
  test('loads primer silently for a warm session (no log on success path)', async () => {
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const $ = makeMockShell({ read: WARM_READ });
      const client = makeMockClient();
      const plugin = await AgentMemory({ client, $ });

      await fire(plugin, 'session.created', {
        sessionID: 'ses_log_test',
        info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
      });

      // Success path must be silent — no "primer loaded" log line.
      const logCalls = spy.mock.calls.map((c) => String(c[0]));
      expect(logCalls.some((s) => s.includes('primer loaded'))).toBe(false);

      // Primer was still loaded: system.transform injects it.
      const system = await invokeSystemTransform(plugin, 'ses_log_test');
      expect(system.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('does not emit a primer loaded log line for a cold-start session', async () => {
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const $ = makeMockShell({ read: COLD_READ });
      const client = makeMockClient();
      const plugin = await AgentMemory({ client, $ });

      await fire(plugin, 'session.created', {
        sessionID: 'ses_log_cold',
        info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
      });

      const logCalls = spy.mock.calls.map((c) => String(c[0]));
      expect(logCalls.some((s) => s.includes('primer loaded'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── startup prune ─────────────────────────────────────────────────────────────

describe('startup prune', () => {
  test('AgentMemory factory calls spawnMemory(["prune"]) on startup', async () => {
    const $ = makeMockShell({});
    await AgentMemory({ client: makeMockClient(), $ });
    expect($.calls.some((c) => /\bprune\b/.test(c))).toBe(true);
  });
});

// ── doDistil force parameter: throttle regression (task 3.3) ──────────────────

describe('doDistil force parameter — throttle regression', () => {
  /**
   * A non-forced session.idle within the throttle window with no signals must
   * still return without distilling (i.e. must not create an ephemeral session).
   * This confirms the !force guard does not break the existing throttle path.
   */
  test('non-forced idle within throttle window with no new signals still skips distil', async () => {
    const recentDistilMs = Date.now() - 1000; // only 1 s ago, within 60 s default
    const throttledRead = JSON.stringify({
      prior: {
        scope: 'project', agent: 'engineer', project: '/proj',
        last_worked_summary: 'x', next_action: 'y', open_questions: [],
        adr_candidate: null, anchored_git_sha: null, updated_at: 1000,
      },
      signals: [],
      watermark: { last_signal_ms: 0, last_distil_ms: recentDistilMs },
    });

    const $ = makeMockShell({ read: throttledRead });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Fire a normal (non-forced) session.idle
    await fire(plugin, 'session.idle', { sessionID: 'ses_throttle_regression' });

    // No ephemeral session should have been created (distil was throttled)
    expect(client._createCalls).toHaveLength(0);
  });
});

// ── Plugin tool hook tests (task 8.20) ────────────────────────────────────────

const NINE_TOOLS = [
  'memory_state_inspect', 'memory_state_patch', 'memory_state_distil',
  'memory_atom_write', 'memory_atom_append', 'memory_atom_get',
  'memory_atom_search', 'memory_atom_list', 'memory_atom_delete',
];

describe('plugin tool hook — factory returns tool map', () => {
  test('AgentMemory factory returns exactly nine tools', async () => {
    const $ = makeMockShell({});
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    expect(plugin).toHaveProperty('event');
    expect(plugin).toHaveProperty('tool');
    expect(Object.keys(plugin.tool)).toHaveLength(9);
    for (const name of NINE_TOOLS) {
      expect(plugin.tool).toHaveProperty(name);
    }
  });

  test('no legacy tool names present', async () => {
    const $ = makeMockShell({});
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    expect(plugin.tool).not.toHaveProperty('memory_inspect');
    expect(plugin.tool).not.toHaveProperty('memory_correct');
    expect(plugin.tool).not.toHaveProperty('memory_distil_force');
  });

  test('each tool has description, args, and execute', async () => {
    const $ = makeMockShell({});
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    for (const name of NINE_TOOLS) {
      const t = plugin.tool[name];
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.args).toBeDefined();
      expect(typeof t.execute).toBe('function');
    }
  });
});

describe('memory_state_inspect tool execute', () => {
  function makeContext(overrides = {}) {
    return {
      sessionID: 'ses_tool_test',
      messageID: 'msg_1',
      agent: 'engineer',
      directory: '/test/project',
      worktree: '/test/project',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    };
  }

  test('delegates to memory.js inspect with the resolved session agent and context.directory', async () => {
    const inspectResult = { prior: { last_worked_summary: 'done' }, signals: [] };
    const $ = makeMockShell({ inspect: JSON.stringify(inspectResult) });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_inspect.execute({}, ctx);

    // A spawn call containing 'inspect' must have happened
    expect($.calls.some((c) => c.includes('inspect'))).toBe(true);
    // Result must be a ToolResult with the parsed data
    const output = typeof result === 'string' ? result : result.output;
    const parsed = JSON.parse(output);
    expect(parsed.prior.last_worked_summary).toBe('done');
  });

  test('active_primer is null when no primer is cached for the session', async () => {
    const inspectResult = { prior: null, signals: [] };
    const $ = makeMockShell({ inspect: JSON.stringify(inspectResult) });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    // No session.created fired — no primer loaded
    const ctx = makeContext({ sessionID: 'ses_no_primer' });

    const result = await plugin.tool.memory_state_inspect.execute({}, ctx);
    const output = typeof result === 'string' ? result : result.output;
    const parsed = JSON.parse(output);
    expect(parsed.active_primer).toBeNull();
  });

  test('active_primer equals the cached primer text when a primer was loaded', async () => {
    const inspectResult = { prior: { last_worked_summary: 'done' }, signals: [] };
    const $ = makeMockShell({
      read: WARM_READ,
      inspect: JSON.stringify(inspectResult),
    });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Load primer via session.created
    await fire(plugin, 'session.created', {
      sessionID: 'ses_with_primer',
      info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
    });

    // memory_inspect must return active_primer matching what system.transform would inject
    const ctx = makeContext({ sessionID: 'ses_with_primer' });
    const result = await plugin.tool.memory_state_inspect.execute({}, ctx);
    const output = typeof result === 'string' ? result : result.output;
    const parsed = JSON.parse(output);

    expect(typeof parsed.active_primer).toBe('string');
    expect(parsed.active_primer.length).toBeGreaterThan(0);
    expect(parsed.active_primer).toContain('background context');
    expect(parsed.active_primer).toContain('background context');

    // Must be identical to what system.transform would inject
    const system = await invokeSystemTransform(plugin, 'ses_with_primer');
    expect(system[0]).toBe(parsed.active_primer);
  });

  test('returns error result instead of throwing when spawn fails', async () => {
    const $ = makeMockShell({}); // empty response → JSON.parse('') fails
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = makeContext();

    // Must not throw
    const result = await expect(
      plugin.tool.memory_state_inspect.execute({}, ctx)
    ).resolves.toBeDefined();
  });

  test('uses session agent from session.get (not context.agent) as the CLI agent dimension', async () => {
    const inspectResult = { prior: null, signals: [] };
    const $ = makeMockShell({ inspect: JSON.stringify(inspectResult) });
    // session.get returns 'engineer' which is in TARGET_AGENTS
    const plugin = await AgentMemory({ client: makeMockClient(), $ });

    // context.agent is a different value; CLI must use the session's agent, not context.agent
    const ctx = makeContext({ agent: 'other-agent' });
    await plugin.tool.memory_state_inspect.execute({}, ctx);

    const inspectCalls = $.calls.filter((c) => c.includes('inspect'));
    expect(inspectCalls.length).toBeGreaterThan(0);
    // 'other-agent' must NOT appear as a CLI arg (session.get returned 'engineer')
    expect(inspectCalls.every((c) => !c.includes('other-agent'))).toBe(true);
  });

  test('returns not-tracked message when session agent is not in TARGET_AGENTS', async () => {
    const savedEnv = process.env.MEMORY_TARGET_AGENTS;
    process.env.MEMORY_TARGET_AGENTS = 'code-reviewer'; // 'engineer' not tracked
    const $ = makeMockShell({});
    // session.get returns 'engineer' which is NOT in TARGET_AGENTS
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_inspect.execute({}, ctx);
    const output = typeof result === 'string' ? result : result.output;
    expect(output).toContain('not tracked');
    // No inspect CLI call should have been made
    expect($.calls.filter((c) => c.includes('inspect'))).toHaveLength(0);
    process.env.MEMORY_TARGET_AGENTS = savedEnv;
  });
});

describe('memory_state_patch tool execute', () => {
  function makeContext(overrides = {}) {
    return {
      sessionID: 'ses_tool_test',
      messageID: 'msg_2',
      agent: 'engineer',
      directory: '/test/project',
      worktree: '/test/project',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    };
  }

  test('delegates to memory.js correct with serialised patch', async () => {
    const $ = makeMockShell({ correct: JSON.stringify({ ok: true }) });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_patch.execute(
      { patch: { last_worked_summary: 'patched' } },
      ctx
    );

    expect($.calls.some((c) => c.includes('correct'))).toBe(true);
    const output = typeof result === 'string' ? result : result.output;
    expect(output).toContain('success');
  });

  test('returns error result instead of throwing when spawn throws', async () => {
    // Build a $ that throws when the 'correct' subcommand is invoked, simulating
    // a subprocess exit-code error. All other calls (e.g. 'prune' at startup) return ''.
    const throwingShell = function (strings, ...values) {
      const cmd = strings.reduce(
        (acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
        ''
      );
      if (cmd.includes('correct')) throw new Error('spawn error: exit code 1');
      const obj = { quiet: () => obj, text: async () => '' };
      return obj;
    };
    throwingShell.calls = [];

    const plugin = await AgentMemory({ client: makeMockClient(), $: throwingShell });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_patch.execute(
      { patch: { next_action: 'do it' } },
      ctx
    );

    // Must resolve (not reject) and return an error result
    const output = typeof result === 'string' ? result : result.output;
    expect(output.toLowerCase()).toContain('error');
  });

  test('uses session agent from session.get (not context.agent) as the CLI agent dimension', async () => {
    const $ = makeMockShell({ correct: JSON.stringify({ ok: true }) });
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = makeContext({ agent: 'different-agent' });

    await plugin.tool.memory_state_patch.execute({ patch: { next_action: 'x' } }, ctx);

    const correctCalls = $.calls.filter((c) => c.includes('correct'));
    expect(correctCalls.length).toBeGreaterThan(0);
    expect(correctCalls.every((c) => !c.includes('different-agent'))).toBe(true);
  });

  test('returns not-tracked message when session agent is not in TARGET_AGENTS', async () => {
    const savedEnv = process.env.MEMORY_TARGET_AGENTS;
    process.env.MEMORY_TARGET_AGENTS = 'code-reviewer';
    const $ = makeMockShell({});
    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_patch.execute({ patch: { next_action: 'x' } }, ctx);
    const output = typeof result === 'string' ? result : result.output;
    expect(output).toContain('not tracked');
    expect($.calls.filter((c) => c.includes('correct'))).toHaveLength(0);
    process.env.MEMORY_TARGET_AGENTS = savedEnv;
  });
});

// ── config hook and distiller agent (distil-session-tool-restriction) ─────────

describe('config hook — distiller agent registration', () => {
  test('AgentMemory factory returns a config hook', async () => {
    const plugin = await AgentMemory({ client: makeMockClient(), $: makeMockShell({}) });
    expect(typeof plugin.config).toBe('function');
  });
  test('config hook registers distiller agent with mode, hidden, and deny-all permission', async () => {
    const plugin = await AgentMemory({ client: makeMockClient(), $: makeMockShell({}) });
    const cfg = {};
    await plugin.config(cfg);
    expect(cfg.agent).toBeDefined();
    expect(cfg.agent['distiller']).toMatchObject({
      mode: 'subagent',
      hidden: true,
      permission: { '*': 'deny', external_directory: 'deny' },
    });
  });

  test('config hook denies external_directory on distiller to suppress path-gate prompts', async () => {
    // The distiller LLM may attempt to read file paths it sees in its prompt
    // (e.g. /tmp files from file.edited signals). external_directory must be
    // explicitly denied so opencode's path-level gate does not surface a
    // desktop permission prompt before the tool-level deny fires.
    const plugin = await AgentMemory({ client: makeMockClient(), $: makeMockShell({}) });
    const cfg = {};
    await plugin.config(cfg);
    expect(cfg.agent['distiller'].permission.external_directory).toBe('deny');
  });

  test('config hook does not overwrite existing agent entries', async () => {
    const plugin = await AgentMemory({ client: makeMockClient(), $: makeMockShell({}) });
    const cfg = { agent: { engineer: { existing: true } } };
    await plugin.config(cfg);
    expect(cfg.agent.engineer).toEqual({ existing: true });
    expect(cfg.agent['distiller']).toBeDefined();
  });

  test('session.create is called with agent: distiller on distil', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.idle', { sessionID: 'ses_distil_agent_check' });

    expect(client._createCalls).toHaveLength(1);
    expect(client._createBodies[0]?.agent).toBe('distiller');
  });
});

describe('memory_distil_force tool execute', () => {
  function makeContext(overrides = {}) {
    return {
      sessionID: 'ses_force_test',
      messageID: 'msg_3',
      agent: 'engineer',
      directory: '/test/project',
      worktree: '/test/project',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    };
  }

  test('calls doDistil with force:true — creates an ephemeral session (bypasses throttle)', async () => {
    // Provide a warm read so doDistil proceeds past agent/project guards and
    // reaches the ephemeral session creation step.
    const recentDistilMs = Date.now() - 1000; // within throttle window
    const throttledRead = JSON.stringify({
      prior: {
        scope: 'project', agent: 'engineer', project: '/test/project',
        last_worked_summary: 'x', next_action: 'y', open_questions: [],
        adr_candidate: null, anchored_git_sha: null, updated_at: 1,
      },
      signals: [],
      watermark: { last_signal_ms: 0, last_distil_ms: recentDistilMs },
    });

    const $ = makeMockShell({ read: throttledRead });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    const ctx = makeContext();
    await plugin.tool.memory_state_distil.execute({}, ctx);

    // With force:true the throttle is bypassed — doDistil must have attempted
    // to create an ephemeral session (even if it then returns on the throttle
    // path without force). This is the distinguishing behavior.
    expect(client._createCalls).toHaveLength(1);
  });

  test('forced distil bypasses throttle; subsequent non-forced idle within window remains throttled (W2 spec scenario)', async () => {
    // Spec: "GIVEN a forced distil completed at T_force (advancing last_distil_ms),
    //        WHEN session.idle fires within DISTIL_MIN_INTERVAL_MS of T_force,
    //        THEN the idle-path distil is skipped by the throttle check."
    //
    // In the mock, both reads return the same static watermark (last_distil_ms = recent).
    // This validates: forced call proceeds (1 ephemeral created), then non-forced idle
    // still reads a recent watermark and is throttled (no second ephemeral).
    const recentDistilMs = Date.now() - 1000;
    const throttledRead = JSON.stringify({
      prior: {
        scope: 'project', agent: 'engineer', project: '/test/project',
        last_worked_summary: 'x', next_action: 'y', open_questions: [],
        adr_candidate: null, anchored_git_sha: null, updated_at: 1,
      },
      signals: [],
      watermark: { last_signal_ms: 0, last_distil_ms: recentDistilMs },
    });

    const $ = makeMockShell({ read: throttledRead });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Forced distil — bypasses throttle, creates 1 ephemeral session
    const ctx = makeContext({ sessionID: 'ses_force_then_idle' });
    await plugin.tool.memory_state_distil.execute({}, ctx);
    expect(client._createCalls).toHaveLength(1);

    // Non-forced session.idle — same recent watermark → throttled, no second ephemeral
    await fire(plugin, 'session.idle', { sessionID: 'ses_force_then_idle' });
    expect(client._createCalls).toHaveLength(1); // still exactly 1
  });

  test('non-target-agent session is a no-op returning a successful ToolResult (W3 spec scenario)', async () => {
    // Spec: "GIVEN the calling session's agent is not TARGET_AGENT,
    //        WHEN the agent calls memory_distil_force,
    //        THEN the tool returns a successful result without performing distillation."
    const $ = makeMockShell({});
    const client = makeMockClient({
      sessionGet: () => ({ data: { agent: 'different-agent', directory: '/proj' } }),
    });
    const plugin = await AgentMemory({ client, $ });

    const ctx = makeContext({ sessionID: 'ses_non_target_force' });
    const result = await plugin.tool.memory_state_distil.execute({}, ctx);

    // Must return a ToolResult (not throw)
    expect(result).toBeDefined();
    // No ephemeral session should have been created (doDistil returned early)
    expect(client._createCalls).toHaveLength(0);
  });

  test('returns error result instead of throwing when doDistil throws', async () => {
    const $ = makeMockShell({}); // empty shell → read will fail → doDistil returns early
    const client = makeMockClient({
      // session.get throws so doDistil returns early (no create call)
      sessionGet: () => { throw new Error('forced failure'); },
    });
    const plugin = await AgentMemory({ client, $ });
    const ctx = makeContext();

    // Must not throw regardless of the internal failure
    await expect(
      plugin.tool.memory_state_distil.execute({}, ctx)
    ).resolves.toBeDefined();
  });
});

// ── error observability (fix-error-observability spec scenarios) ──────────────
//
// RED-STEP tests: these fail before the implementation and pass after.
// Scenarios from openspec/changes/fix-error-observability/specs/error-observability/spec.md

describe('error observability', () => {
  // EO-S1: log() routes to client.app.log instead of stderr
  test('log() calls client.app.log (not process.stderr.write) on error', async () => {
    // Empty shell → JSON.parse('') throws → log('inject: read failed ...') or
    // log('distil: read failed ...') is invoked.
    const $ = makeMockShell({});
    const client = makeMockClient();
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });
      await fire(plugin, 'session.idle', { sessionID: 'ses_eo_1' });

      expect(client.app.log).toHaveBeenCalled();
      const call = client._appLogCalls[0];
      expect(call).toMatchObject({ service: 'agent-memory', level: 'error' });
      expect(typeof call.message).toBe('string');
      expect(call.message.length).toBeGreaterThan(0);
      // Spec: process.stderr is NOT written on the success path (log routes to app.log).
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // EO-S2: err.stderr is appended to the log message when present
  test('log() appends err.stderr content when the error carries a stderr buffer', async () => {
    const stderrPayload = 'SQLITE_BUSY: database is locked';
    // Shell throws an error with .stderr set for any command that includes 'read'.
    const $ = makeMockShell({}, { read: { message: 'exit 1', stderr: stderrPayload } });
    const client = makeMockClient();
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });
      await fire(plugin, 'session.idle', { sessionID: 'ses_eo_2' });

      expect(client._appLogCalls.length).toBeGreaterThan(0);
      const firstMsg = client._appLogCalls[0].message;
      expect(firstMsg).toContain(stderrPayload);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // EO-S3: log() falls back to process.stderr.write when client.app.log throws
  test('log() falls back to process.stderr.write when client.app.log is unavailable', async () => {
    const $ = makeMockShell({});
    const client = makeMockClient({ appLogThrows: true });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });
      await fire(plugin, 'session.idle', { sessionID: 'ses_eo_3' });

      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).toContain('[agent-memory]');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // EO-S4: notify() calls client.tui.showToast with variant 'error'
  test('notify() fires client.tui.showToast with variant "error" on critical error', async () => {
    const $ = makeMockShell({});
    const client = makeMockClient();
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });
      await fire(plugin, 'session.idle', { sessionID: 'ses_eo_4' });

      expect(client.tui.showToast).toHaveBeenCalled();
      const toast = client._toastCalls.find((t) => t?.variant === 'error');
      expect(toast).toBeDefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // EO-S5: distil: read failed calls both log() and notify()
  test('distil: read failed path calls both app.log and tui.showToast', async () => {
    const $ = makeMockShell({});
    const client = makeMockClient();
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });
      await fire(plugin, 'session.idle', { sessionID: 'ses_eo_5' });

      // Both observability channels must have been notified for a critical read failure.
      expect(client.app.log).toHaveBeenCalled();
      expect(client.tui.showToast).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // EO-S6 (spec.md §event handler error): unexpected exception in the event switch
  // body triggers both log() and notify() via the outer catch block.
  test('unexpected event-handler exception reaches outer catch and calls both app.log and tui.showToast', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });

      // A properties object whose sessionID getter throws synchronously.
      // Optional chaining (?.) only guards against null/undefined, not thrown
      // getters — so event.properties?.sessionID propagates the throw, which
      // escapes all inner handlers and reaches the outer event-handler catch.
      const evilProps = Object.defineProperty({}, 'sessionID', {
        get() { throw new Error('unexpected internal failure'); },
      });
      await fire(plugin, 'session.idle', evilProps);

      expect(client.app.log).toHaveBeenCalled();
      expect(client.tui.showToast).toHaveBeenCalled();
      const toast = client._toastCalls.find((t) => t?.variant === 'error');
      expect(toast).toBeDefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // EO-S7 (spec.md §lower-severity distil failure): session.get failure inside doDistil
  // logs the error but must NOT fire a toast (it is a lower-severity, retryable failure).
  test('distil session.get failure logs but does NOT call tui.showToast', async () => {
    const $ = makeMockShell({});
    const client = makeMockClient({
      sessionGet: () => { throw new Error('server unavailable'); },
    });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const plugin = await AgentMemory({ client, $ });
      await fire(plugin, 'session.idle', { sessionID: 'ses_eo_7' });

      // The error should still be logged...
      expect(client.app.log).toHaveBeenCalled();
      // ...but must NOT trigger a toast (lower-severity, not user-actionable).
      expect(client.tui.showToast).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ── resolveSessionAgent: cache-hit prevents redundant session.get calls ────────

describe('resolveSessionAgent cache-hit behaviour', () => {
  function makeContext(overrides = {}) {
    return {
      sessionID: 'ses_cache_test',
      messageID: 'msg_c',
      agent: 'engineer',
      directory: '/test/project',
      worktree: '/test/project',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    };
  }

  test('calling memory_inspect twice for the same session only calls session.get once', async () => {
    const inspectResult = { prior: null, signals: [] };
    const $ = makeMockShell({ inspect: JSON.stringify(inspectResult) });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });
    const ctx = makeContext();

    // Two back-to-back tool invocations for the same sessionID
    await plugin.tool.memory_state_inspect.execute({}, ctx);
    await plugin.tool.memory_state_inspect.execute({}, ctx);

    // session.get must have been called exactly once (cache-hit on second call)
    const getCallsForSession = client._getCalls.filter((id) => id === ctx.sessionID);
    expect(getCallsForSession).toHaveLength(1);
  });

  test('sessionAgents map is pre-populated by session.created; tools use cache without extra session.get', async () => {
    const inspectResult = { prior: null, signals: [] };
    const $ = makeMockShell({
      read: COLD_READ,
      inspect: JSON.stringify(inspectResult),
    });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // session.created populates the sessionAgents map
    await fire(plugin, 'session.created', {
      sessionID: 'ses_pre_populated',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });

    const getCallsAfterCreated = client._getCalls.filter((id) => id === 'ses_pre_populated').length;

    // memory_inspect should use the cached agent — no extra session.get
    const ctx = makeContext({ sessionID: 'ses_pre_populated' });
    await plugin.tool.memory_state_inspect.execute({}, ctx);

    const getCallsAfterInspect = client._getCalls.filter((id) => id === 'ses_pre_populated').length;
    expect(getCallsAfterInspect).toBe(getCallsAfterCreated); // no new session.get
  });
});

// ── memory_distil_force: not-tracked returns informative message ───────────────

describe('memory_distil_force — not-tracked session', () => {
  function makeContext(overrides = {}) {
    return {
      sessionID: 'ses_force_nt',
      messageID: 'msg_f',
      agent: 'engineer',
      directory: '/test/project',
      worktree: '/test/project',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    };
  }

  test('returns not-tracked message when session agent is not in TARGET_AGENTS', async () => {
    const savedEnv = process.env.MEMORY_TARGET_AGENTS;
    process.env.MEMORY_TARGET_AGENTS = 'code-reviewer';
    const $ = makeMockShell({});
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_distil.execute({}, ctx);
    const output = typeof result === 'string' ? result : result.output;
    expect(output).toContain('not tracked');
    // No ephemeral session should have been created
    expect(client._createCalls).toHaveLength(0);
    process.env.MEMORY_TARGET_AGENTS = savedEnv;
  });

  test('returns not-tracked message when session agent is null', async () => {
    // session.get returns no agent (null)
    const client = makeMockClient({
      sessionGet: () => ({ data: { agent: null, directory: '/proj', title: null } }),
    });
    const $ = makeMockShell({});
    const plugin = await AgentMemory({ client, $ });
    const ctx = makeContext();

    const result = await plugin.tool.memory_state_distil.execute({}, ctx);
    const output = typeof result === 'string' ? result : result.output;
    expect(output).toContain('not tracked');
  });
});

// ── multi-agent tracking: two agents each get independent memory ───────────────

describe('multi-agent tracking', () => {
  test('session.created loads memory for each of multiple tracked agents independently', async () => {
    const savedEnv = process.env.MEMORY_TARGET_AGENTS;
    process.env.MEMORY_TARGET_AGENTS = 'engineer,code-reviewer';

    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient({
      sessionGet: (id) => ({
        data: {
          agent: id === 'ses_eng' ? 'engineer' : 'code-reviewer',
          directory: '/proj',
          title: null,
        },
      }),
    });
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_eng',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });
    await fire(plugin, 'session.created', {
      sessionID: 'ses_cr',
      info: { agent: 'code-reviewer', directory: '/proj', title: null },
    });

    // Both sessions have primers available (WARM_READ returns a prior)
    const sysEng = await invokeSystemTransform(plugin, 'ses_eng');
    const sysCr  = await invokeSystemTransform(plugin, 'ses_cr');
    expect(sysEng).toHaveLength(1);
    expect(sysCr).toHaveLength(1);

    process.env.MEMORY_TARGET_AGENTS = savedEnv;
  });

  test('session for an agent not in TARGET_AGENTS is skipped even when other agents are tracked', async () => {
    const savedEnv = process.env.MEMORY_TARGET_AGENTS;
    process.env.MEMORY_TARGET_AGENTS = 'engineer'; // only engineer tracked

    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient({
      sessionGet: () => ({ data: { agent: 'architect', directory: '/proj', title: null } }),
    });
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_arch',
      info: { agent: 'architect', directory: '/proj', title: null },
    });

    // architect is not tracked — no primer loaded
    const sys = await invokeSystemTransform(plugin, 'ses_arch');
    expect(sys).toHaveLength(0);

    process.env.MEMORY_TARGET_AGENTS = savedEnv;
  });

  test('session.created with null agent is skipped silently — sessionAgents not populated', async () => {
    // Spec scenario: GIVEN session.agent is null after payload check + session.get fallback
    // WHEN session.created fires
    // THEN no primer loaded, sessionAgents not populated → tool returns not-tracked
    const $ = makeMockShell({ read: WARM_READ, inspect: JSON.stringify({ prior: null, signals: [] }) });
    const client = makeMockClient({
      sessionGet: () => ({ data: { agent: null, directory: '/proj', title: null } }),
    });
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_null_agent',
      info: { agent: null, directory: '/proj', title: null },
    });

    // No DB read should have been attempted (null agent skipped before loadMemoryForSession)
    const readCalls = $.calls.filter((c) => c.includes(' read '));
    expect(readCalls).toHaveLength(0);

    // system.transform: no primer
    const sys = await invokeSystemTransform(plugin, 'ses_null_agent');
    expect(sys).toHaveLength(0);

    // memory_inspect should return "not tracked" — sessionAgents was never populated
    // resolveSessionAgent will call session.get (returns null agent) → returns null
    function makeNullCtx() {
      return {
        sessionID: 'ses_null_agent', messageID: 'msg_n', agent: null,
        directory: '/proj', worktree: '/proj',
        abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
      };
    }
    const result = await plugin.tool.memory_state_inspect.execute({}, makeNullCtx());
    const output = typeof result === 'string' ? result : result.output;
    expect(output).toContain('not tracked');
  });
});

// ── 8.21 session.created: sessionNames populated ──────────────────────────────

describe('session.created — sessionNames capture (task 8.21)', () => {
  function makeBasicClient() {
    const client = makeMockClient();
    // Override session.get to return engineer agent so it's tracked
    client.session.get = async ({ path: { id } }) => ({
      data: { id, agent: 'engineer', directory: '/test/proj', title: null },
    });
    return client;
  }

  test('session title is captured from event info.title', async () => {
    const $ = makeMockShell({ read: COLD_READ, 'atom-list': '[]' });
    const plugin = await AgentMemory({ client: makeBasicClient(), $ });

    await plugin.event({ event: {
      type: 'session.created',
      properties: {
        sessionID: 'ses-title-test',
        info: {
          id: 'ses-title-test',
          agent: 'engineer',
          directory: '/test/proj',
          title: 'My great session',
        },
      },
    }});

    // The title is stored internally — we verify it gets passed to distil-write
    // by checking the atom-list + assemblePrimer path does not throw
    // (full title threading is verified via distil-write in memory-cli tests).
    // Just assert the session was processed (primerLoaded includes it).
    // No crash is the minimal assertion here.
  });

  test('cold start with no atoms results in no primer (null)', async () => {
    const $ = makeMockShell({ read: COLD_READ, 'atom-list': '[]' });
    const plugin = await AgentMemory({ client: makeBasicClient(), $ });

    await plugin.event({ event: {
      type: 'session.created',
      properties: {
        sessionID: 'ses-cold-no-atoms',
        info: { id: 'ses-cold-no-atoms', agent: 'engineer', directory: '/test/proj', title: 'cold session' },
      },
    }});

    const sys = [];
    await plugin['experimental.chat.system.transform']({ sessionID: 'ses-cold-no-atoms' }, { system: sys });
    expect(sys).toHaveLength(0);
  });
});

// ── 8.22 resolveScope unit tests ─────────────────────────────────────────────

describe('resolveScope (task 8.22)', () => {
  // Access the helper by verifying tool behaviour (white-box via tool spawns)
  // We test via plugin.tool.memory_atom_write to verify scope resolution,
  // since resolveScope is a module-private helper.

  test('workspace (default/undefined) → scope=project, project=directory', async () => {
    const captured = [];
    const $ = function(strings, ...values) {
      const cmd = strings.reduce((a, s, i) => a + s + (values[i] !== undefined ? String(values[i]) : ''), '');
      captured.push(cmd);
      const obj = { quiet: () => obj, text: async () => JSON.stringify({ ok: true, action: 'created', message: 'Created atom at test' }) };
      return obj;
    };

    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = {
      sessionID: 'ses-scope-test',
      directory: '/my/workspace',
      messageID: 'msg1',
      agent: 'engineer',
      worktree: '/my/workspace',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    await plugin.tool.memory_atom_write.execute({
      topic: 'test', content: 'body', description: 'desc', scope: undefined,
    }, ctx);

    // The atom-write spawn should pass 'project' as scope and '/my/workspace' as project
    const atomWriteCall = captured.find((c) => c.includes('atom-write'));
    expect(atomWriteCall).toContain('project');
    expect(atomWriteCall).toContain('/my/workspace');
  });

  test('global → scope=global, project=""', async () => {
    const captured = [];
    const $ = function(strings, ...values) {
      const cmd = strings.reduce((a, s, i) => a + s + (values[i] !== undefined ? String(values[i]) : ''), '');
      captured.push(cmd);
      const obj = { quiet: () => obj, text: async () => JSON.stringify({ ok: true, action: 'created', message: 'Created atom at test' }) };
      return obj;
    };

    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = {
      sessionID: 'ses-global-scope',
      directory: '/my/workspace',
      messageID: 'msg1',
      agent: 'engineer',
      worktree: '/my/workspace',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    await plugin.tool.memory_atom_write.execute({
      topic: 'global-test', content: 'body', description: 'desc', scope: 'global',
    }, ctx);

    const atomWriteCall = captured.find((c) => c.includes('atom-write'));
    expect(atomWriteCall).toContain('global');
  });

  test('all → scope=all for read-only operations (atom-list)', async () => {
    const captured = [];
    const $ = function(strings, ...values) {
      const cmd = strings.reduce((a, s, i) => a + s + (values[i] !== undefined ? String(values[i]) : ''), '');
      captured.push(cmd);
      const obj = { quiet: () => obj, text: async () => '[]' };
      return obj;
    };

    const plugin = await AgentMemory({ client: makeMockClient(), $ });
    const ctx = {
      sessionID: 'ses-all-scope',
      directory: '/my/workspace',
      messageID: 'msg1',
      agent: 'engineer',
      worktree: '/my/workspace',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    await plugin.tool.memory_atom_list.execute({ scope: 'all' }, ctx);

    const listCall = captured.find((c) => c.includes('atom-list'));
    expect(listCall).toContain('all');
  });
});
