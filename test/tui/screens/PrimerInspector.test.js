// test/tui/screens/PrimerInspector.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Primer Inspector fidelity
//
// memoryClient is mocked at the module boundary (design.md Decision 6) — no
// test spawns a real memory.js process.

import {jest} from '@jest/globals';
import React from 'react';
import {AppStateProvider} from '../../../src/tui/state/AppStateContext.js';
import {type, renderInk, flush, unmountInk} from '../inkTestHelpers.js';

const mockSpawnMemory = jest.fn();

jest.unstable_mockModule('../../../src/tui/spawn/memoryClient.js', () => ({
  spawnMemory: mockSpawnMemory,
}));

const {PrimerInspector} = await import(
  '../../../src/tui/screens/PrimerInspector.js'
);

function renderScreen() {
  return renderInk(
    React.createElement(AppStateProvider, null, React.createElement(PrimerInspector))
  );
}

beforeEach(() => {
  mockSpawnMemory.mockReset();
});

describe('PrimerInspector', () => {
  it('Agent+project picker is populated', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'hot-state-list-pairs') {
        return {
          ok: true,
          data: {
            pairs: [
              {
                agent: 'claude',
                project: '/home/user/proj-a',
                sessionCount: 3,
                lastUpdatedAt: '2026-09-18T00:00:00.000Z',
              },
              {
                agent: 'claude',
                project: '/home/user/proj-b',
                sessionCount: 1,
                lastUpdatedAt: '2026-09-01T00:00:00.000Z',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('proj-a');
    expect(lastFrame()).toContain('proj-b');
  });

  it('Selecting a pair shows the assembled primer', async () => {
    const primerText = '# Session Primer\n\nExact assembled text.';
    mockSpawnMemory.mockImplementation(async (cmd, args) => {
      if (cmd === 'hot-state-list-pairs') {
        return {
          ok: true,
          data: {
            pairs: [
              {
                agent: 'claude',
                project: '/home/user/proj-a',
                sessionCount: 3,
                lastUpdatedAt: '2026-09-18T00:00:00.000Z',
              },
            ],
          },
        };
      }
      if (cmd === 'primer-preview') {
        expect(args).toEqual(['claude', '/home/user/proj-a']);
        return {ok: true, data: {primerText}};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame, stdin} = renderScreen();
    await flush();

    await type(stdin, '\r'); // Enter selects the first (only) row

    expect(lastFrame()).toContain(primerText);
  });

  it('No sessions recorded', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'hot-state-list-pairs') {
        return {ok: true, data: {pairs: []}};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('No sessions recorded yet');
  });

  it('Read-only, no cross-visit caching', async () => {
    let hotStateCalls = 0;
    let primerCalls = 0;
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'hot-state-list-pairs') {
        hotStateCalls += 1;
        return {
          ok: true,
          data: {
            pairs: [
              {
                agent: 'claude',
                project: '/home/user/proj-a',
                sessionCount: 1,
                lastUpdatedAt: '2026-09-18T00:00:00.000Z',
              },
            ],
          },
        };
      }
      if (cmd === 'primer-preview') {
        primerCalls += 1;
        return {ok: true, data: {primerText: `primer #${primerCalls}`}};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const first = renderScreen();
    await flush();
    await type(first.stdin, '\r');
    expect(first.lastFrame()).toContain('primer #1');
    unmountInk(first);

    const second = renderScreen();
    await flush();
    await type(second.stdin, '\r');
    expect(second.lastFrame()).toContain('primer #2');

    expect(hotStateCalls).toBe(2);
    expect(primerCalls).toBe(2);

    const mutationCalls = mockSpawnMemory.mock.calls.filter(([cmd]) =>
      ['atom-write', 'atom-patch', 'atom-delete', 'atom-append'].includes(cmd)
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it('Surfaces an error when hot-state-list-pairs fails', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'hot-state-list-pairs') {
        return {ok: false, message: 'memory.js timed out (>8s) — the database may be locked'};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('memory.js timed out');
  });

  it('Surfaces an error when primer-preview fails', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'hot-state-list-pairs') {
        return {
          ok: true,
          data: {
            pairs: [
              {
                agent: 'claude',
                project: '/home/user/proj-a',
                sessionCount: 1,
                lastUpdatedAt: '2026-09-18T00:00:00.000Z',
              },
            ],
          },
        };
      }
      if (cmd === 'primer-preview') {
        return {ok: false, message: '[memory.js] primer-preview failed: boom'};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame, stdin} = renderScreen();
    await flush();

    await type(stdin, '\r');

    expect(lastFrame()).toContain('boom');
  });
});
