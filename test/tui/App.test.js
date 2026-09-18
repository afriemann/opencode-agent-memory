// test/tui/App.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Main Menu navigation
//
// memoryClient is mocked at the module boundary (design.md Decision 6) — no
// test spawns a real memory.js process. This matters here specifically:
// navigating to Primer Inspector or Atom Browser mounts screens whose
// effects call spawnMemory immediately, and without this mock those calls
// would hit the real memory.js CLI (and, absent AGENT_MEMORY_DB, this
// machine's live agent-memory.db) instead of a stub.

import {jest} from '@jest/globals';
import React from 'react';
import {type, renderInk} from './inkTestHelpers.js';

const mockSpawnMemory = jest.fn();

jest.unstable_mockModule('../../src/tui/spawn/memoryClient.js', () => ({
  spawnMemory: mockSpawnMemory,
}));

const {App} = await import('../../src/tui/App.js');

beforeEach(() => {
  mockSpawnMemory.mockReset();
  // Every screen this suite navigates into fetches on mount; resolve with
  // an empty result so each renders its "empty" state rather than hanging
  // in "loading" or erroring on an unmocked command.
  mockSpawnMemory.mockImplementation(async (cmd) => {
    if (cmd === 'hot-state-list-pairs') {
      return {ok: true, data: {pairs: []}};
    }
    if (cmd === 'atom-list') {
      return {ok: true, data: []};
    }
    throw new Error(`unexpected cmd ${cmd}`);
  });
});

describe('App + MainMenu navigation', () => {
  it('Navigate to Primer Inspector', async () => {
    const {lastFrame, stdin} = renderInk(React.createElement(App));

    expect(lastFrame()).toContain('Main Menu');
    await type(stdin, '1');

    expect(lastFrame()).toContain('Primer Inspector');
  });

  it('Navigate to project-scoped Atom Browser', async () => {
    const {lastFrame, stdin} = renderInk(React.createElement(App));

    await type(stdin, '2');

    expect(lastFrame()).toContain('Atom Browser — Project');
  });

  it('Navigate to global-scoped Atom Browser', async () => {
    const {lastFrame, stdin} = renderInk(React.createElement(App));

    await type(stdin, '3');

    expect(lastFrame()).toContain('Atom Browser — Global/Shared');
  });

  it('Quit', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const {stdin} = renderInk(React.createElement(App));

      await type(stdin, 'q');

      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('Escape always returns toward the Main Menu', async () => {
    const {lastFrame, stdin} = renderInk(React.createElement(App));

    await type(stdin, '1');
    expect(lastFrame()).toContain('Primer Inspector');

    await type(stdin, '\u001B'); // Esc
    expect(lastFrame()).toContain('Main Menu');

    // Pressing Esc again at the root is a no-op — still Main Menu.
    await type(stdin, '\u001B');
    expect(lastFrame()).toContain('Main Menu');
  });
});
