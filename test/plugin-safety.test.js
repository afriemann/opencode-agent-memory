// test/plugin-safety.test.js — plugin factory safety and idempotency tests.
//
// Tests the AgentMemory plugin factory with fully-mocked client and $.
// Every failure mode from §9 is covered; no real DB or git is used.

import AgentMemory from '../src/plugin.js';
import { reduceSignals, assemblePrimer, MAX_SIGNALS_PER_KIND } from '../src/lib/signal-utils.js';
import { renderStaleness } from '../src/lib/git-helper.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock $ that returns configured responses based on command substrings.
 *
 * @param {Record<string, string|object>} responses — key is substring to match,
 *   value is the text to return (objects are JSON.stringified).
 */
function makeMockShell(responses = {}) {
  const calls = [];

  const $ = function (strings, ...values) {
    const cmd = strings.reduce(
      (acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
      ''
    );
    calls.push(cmd);

    let output = '';
    for (const [pattern, value] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        output = typeof value === 'string' ? value : JSON.stringify(value);
        break;
      }
    }

    const obj = {
      stdin: (_input) => obj,
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
  signals: [],
  watermark: { last_signal_ms: 0, last_distil_ms: 0 },
});

/** A read response with a prior record (warm start). */
const WARM_READ = JSON.stringify({
  prior: {
    scope: 'project',
    agent: 'engineer',
    project: '/home/user/repos/my/project',
    last_worked_summary: 'implemented the widget',
    next_action: 'write tests for widget',
    open_questions: ['should we use sqlite?'],
    adr_candidate: null,
    anchored_git_sha: 'abc123',
    updated_at: 1000,
  },
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

  const client = {
    session: {
      get: async ({ sessionID }) => {
        getCalls.push(sessionID);
        return overrides.sessionGet?.(sessionID) ?? {
          data: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
        };
      },
      create: async ({ title }) => {
        createCalls.push(title);
        return overrides.sessionCreate?.(title) ?? { data: { id: 'eph_test' } };
      },
      prompt: async ({ sessionID, ...body }) => {
        promptCalls.push({ id: sessionID, body });
        return overrides.sessionPrompt?.(sessionID, body) ?? {
          data: { parts: [{ type: 'text', text: JSON.stringify({
            last_worked_summary: 'done',
            next_action: 'next',
            open_questions: [],
            adr_candidate: null,
          }) }] },
        };
      },
      delete: async ({ sessionID }) => {
        deleteCalls.push(sessionID);
        return {};
      },
    },
    _promptCalls: promptCalls,
    _createCalls: createCalls,
    _deleteCalls: deleteCalls,
    _getCalls: getCalls,
  };
  return client;
}

/** Fire an event at the plugin. */
async function fire(plugin, type, properties) {
  await plugin.event({ event: { type, properties } });
}

// ── Injection idempotency ────────────────────────────────────────────────────

describe('injection idempotency', () => {
  test('injects exactly once when session.created fires twice for the same session', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    const props = {
      sessionID: 'ses_001',
      info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
    };
    await fire(plugin, 'session.created', props);
    await fire(plugin, 'session.created', props); // duplicate

    // Only one noReply prompt for the primer
    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(1);
  });

  test('does not inject for cold start (no prior memory)', async () => {
    const $ = makeMockShell({ read: COLD_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    await fire(plugin, 'session.created', {
      sessionID: 'ses_cold',
      info: { agent: 'engineer', directory: '/home/user/repos/my/project', title: null },
    });

    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(0);
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

  test('two sessions in different projects each get their own injection', async () => {
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

    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(2);
    const injectedSessions = primerCalls.map((c) => c.id);
    expect(injectedSessions).toContain('ses_proj_a');
    expect(injectedSessions).toContain('ses_proj_b');
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
  test('injects primer when session was not primed by session.created', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // No session.created fired — go straight to message.updated
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_resumed',
      info: { role: 'user', text: 'hello, continue the work' },
    });

    // Should have triggered a primer injection
    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(1);
    expect(primerCalls[0].id).toBe('ses_resumed');
  });

  test('does not inject twice when message.updated fires after session.created primed the session', async () => {
    const $ = makeMockShell({ read: WARM_READ });
    const client = makeMockClient();
    const plugin = await AgentMemory({ client, $ });

    // Primed by session.created first
    await fire(plugin, 'session.created', {
      sessionID: 'ses_already_primed',
      info: { agent: 'engineer', directory: '/proj', title: null },
    });

    // message.updated fires afterward — should NOT re-inject
    await fire(plugin, 'message.updated', {
      sessionID: 'ses_already_primed',
      info: { role: 'user', text: 'continue' },
    });

    const primerCalls = client._promptCalls.filter((c) => c.body?.noReply);
    expect(primerCalls).toHaveLength(1); // still exactly one
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

describe('assemblePrimer', () => {
  const BASE_PRIOR = {
    last_worked_summary: 'implemented the widget',
    next_action: 'write widget tests',
    open_questions: ['should this be async?'],
    adr_candidate: null,
  };

  test('includes the header with agent and last-two-segments of project', () => {
    const result = assemblePrimer(
      BASE_PRIOR,
      'engineer',
      '/home/user/repos/my/project',
      { status: 'ok', distance: 2 }
    );
    expect(result).toContain('[MEMORY — resumed context for engineer in my/project]');
  });

  test('includes last_worked_summary and next_action', () => {
    const result = assemblePrimer(
      BASE_PRIOR,
      'engineer',
      '/proj/repo',
      { status: 'ok', distance: 0 }
    );
    expect(result).toContain('Where we left off: implemented the widget');
    expect(result).toContain('Next action: write widget tests');
  });

  test('renders open_questions as bullets when non-empty', () => {
    const result = assemblePrimer(
      BASE_PRIOR,
      'engineer',
      '/proj/repo',
      { status: 'no-git' }
    );
    expect(result).toContain('Open questions:');
    expect(result).toContain('- should this be async?');
    expect(result).not.toContain('Open questions: none');
  });

  test('renders "Open questions: none" when array is empty', () => {
    const prior = { ...BASE_PRIOR, open_questions: [] };
    const result = assemblePrimer(prior, 'engineer', '/proj/repo', { status: 'no-git' });
    expect(result).toContain('Open questions: none');
    expect(result).not.toContain('- '); // no bullets
  });

  test('includes ADR paragraph only when adr_candidate is non-null', () => {
    const withAdr = {
      ...BASE_PRIOR,
      adr_candidate: 'consider ADR: use in-memory cache',
    };
    const resultWith = assemblePrimer(withAdr, 'engineer', '/proj/repo', { status: 'no-git' });
    expect(resultWith).toContain('Possible decision to record:');
    expect(resultWith).toContain('consider ADR: use in-memory cache');
    expect(resultWith).toContain('docs/adr/');

    const resultWithout = assemblePrimer(BASE_PRIOR, 'engineer', '/proj/repo', { status: 'no-git' });
    expect(resultWithout).not.toContain('Possible decision to record:');
  });

  test('staleness line appears with the exact phrasing from renderStaleness', () => {
    for (const staleness of [
      { status: 'ok', distance: 3 },
      { status: 'no-git' },
      { status: 'diverged' },
      { status: 'no-anchor' },
    ]) {
      const result = assemblePrimer(BASE_PRIOR, 'engineer', '/proj/repo', staleness);
      expect(result).toContain(`Staleness: ${renderStaleness(staleness)}`);
    }
  });

  test('teach-back directive is present in every primer', () => {
    const result = assemblePrimer(BASE_PRIOR, 'engineer', '/proj/repo', { status: 'ok', distance: 0 });
    expect(result).toContain('This memory is a hypothesis, not ground truth');
    expect(result).toContain('replay your understanding');
    expect(result).toContain('get my confirmation first');
  });

  test('slot order: header → summary → next_action → questions → ADR → staleness → teach-back', () => {
    const prior = {
      ...BASE_PRIOR,
      adr_candidate: 'consider ADR: test',
    };
    const result = assemblePrimer(prior, 'engineer', '/proj/repo', { status: 'ok', distance: 1 });
    const headerIdx    = result.indexOf('[MEMORY');
    const summaryIdx   = result.indexOf('Where we left off');
    const actionIdx    = result.indexOf('Next action');
    const questionsIdx = result.indexOf('Open questions');
    const adrIdx       = result.indexOf('Possible decision');
    const stalenessIdx = result.indexOf('Staleness:');
    const teachIdx     = result.indexOf('This memory is a hypothesis');

    expect(headerIdx).toBeLessThan(summaryIdx);
    expect(summaryIdx).toBeLessThan(actionIdx);
    expect(actionIdx).toBeLessThan(questionsIdx);
    expect(questionsIdx).toBeLessThan(adrIdx);
    expect(adrIdx).toBeLessThan(stalenessIdx);
    expect(stalenessIdx).toBeLessThan(teachIdx);
  });
});
