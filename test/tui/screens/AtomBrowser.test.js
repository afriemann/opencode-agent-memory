// test/tui/screens/AtomBrowser.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Atom Browser
//
// memoryClient is mocked at the module boundary (design.md Decision 6) — no
// test spawns a real memory.js process.

import {jest} from '@jest/globals';
import React from 'react';
import {AppStateProvider} from '../../../src/tui/state/AppStateContext.js';
import {type, renderInk, flush} from '../inkTestHelpers.js';

const mockSpawnMemory = jest.fn();

jest.unstable_mockModule('../../../src/tui/spawn/memoryClient.js', () => ({
  spawnMemory: mockSpawnMemory,
}));

const {AtomBrowser} = await import('../../../src/tui/screens/AtomBrowser.js');
const {App} = await import('../../../src/tui/App.js');

function renderScreen() {
  return renderInk(
    React.createElement(AppStateProvider, null, React.createElement(AtomBrowser))
  );
}

const PROJECT_ATOM = {
  scope: 'project',
  project: process.cwd(),
  topic: 'arch/foo',
  description: 'Foo description',
  summary: 'Foo summary',
  preview: 'Foo preview',
  pinned: 1,
  always_include: 0,
  status: 'active',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
};

const GLOBAL_ATOM = {
  scope: 'global',
  project: '',
  topic: 'shared/bar',
  description: 'Bar description',
  summary: 'Bar summary',
  preview: 'Bar preview',
  pinned: 0,
  always_include: 1,
  status: 'active',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
};

beforeEach(() => {
  mockSpawnMemory.mockReset();
});

describe('AtomBrowser', () => {
  it('Shows a loading state while the atom list fetch is in flight', () => {
    mockSpawnMemory.mockImplementation(() => new Promise(() => {})); // never resolves

    const {lastFrame} = renderScreen();

    expect(lastFrame()).toContain('Loading…');
  });

  it('Listing atoms in project scope', async () => {
    mockSpawnMemory.mockImplementation(async (cmd, args) => {
      if (cmd === 'atom-list') {
        expect(args[0]).toBe('project');
        return {ok: true, data: [PROJECT_ATOM]};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('arch/foo');
    expect(lastFrame()).toContain('active');
  });

  it('Listing atoms in global scope', async () => {
    mockSpawnMemory.mockImplementation(async (cmd, args) => {
      if (cmd === 'atom-list') {
        if (args[0] === 'global') {
          return {ok: true, data: [GLOBAL_ATOM]};
        }
        return {ok: true, data: [PROJECT_ATOM]};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame, stdin} = renderScreen();
    await flush();
    expect(lastFrame()).toContain('arch/foo');

    await type(stdin, '\t'); // Tab toggles scope
    await flush();

    expect(lastFrame()).toContain('shared/bar');
  });

  it('Toggling scope re-fetches and clears the previous selection', async () => {
    mockSpawnMemory.mockImplementation(async (cmd, args) => {
      if (cmd === 'atom-list') {
        if (args[0] === 'global') {
          return {ok: true, data: [GLOBAL_ATOM]};
        }
        return {
          ok: true,
          data: [PROJECT_ATOM, {...PROJECT_ATOM, topic: 'arch/second'}],
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame, stdin} = renderScreen();
    await flush();

    // Move selection to the second row before toggling.
    await type(stdin, '\u001B[B'); // down arrow
    await flush();

    await type(stdin, '\t');
    await flush();

    // After toggling, the preview reflects the first (only) global row —
    // proving selection was reset to index 0, not carried over.
    expect(lastFrame()).toContain('Bar description');
  });

  it('Selecting an atom shows a preview', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'atom-list') {
        return {ok: true, data: [PROJECT_ATOM]};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('Foo description');
    expect(lastFrame()).toContain('Foo summary');
  });

  it('Empty scope', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'atom-list') {
        return {ok: true, data: []};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('No atoms found in this scope');
  });

  it('Opening an atom', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'atom-list') {
        return {ok: true, data: [PROJECT_ATOM]};
      }
      if (cmd === 'atom-get') {
        return {
          ok: true,
          data: {match: {...PROJECT_ATOM, content: 'full content', tags: '[]'}, alsoIn: []},
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame, stdin} = renderInk(React.createElement(App));
    await type(stdin, '2'); // Main Menu → Browse Project Atoms
    await flush();

    await type(stdin, '\r'); // Enter opens the selected (only) atom
    await flush();

    expect(lastFrame()).toContain('arch/foo');
    expect(lastFrame()).toContain('full content');
  });

  it('Surfaces an error when atom-list fails', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'atom-list') {
        return {ok: false, message: 'malformed response from memory.js'};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('malformed response from memory.js');
  });
});
