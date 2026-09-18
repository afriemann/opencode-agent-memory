// test/tui/screens/AtomDetail.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Atom Detail & Actions display
//
// memoryClient is mocked at the module boundary (design.md Decision 6) — no
// test spawns a real memory.js process. Only display is covered here;
// lifecycle actions are wired in task 9, edit in task 10, delete in task 11.

import {jest} from '@jest/globals';
import React, {useEffect} from 'react';
import {AppStateProvider, useAppState} from '../../../src/tui/state/AppStateContext.js';
import {renderInk, flush, type} from '../inkTestHelpers.js';

const mockSpawnMemory = jest.fn();
const mockEditAtomContent = jest.fn();

jest.unstable_mockModule('../../../src/tui/spawn/memoryClient.js', () => ({
  spawnMemory: mockSpawnMemory,
}));

jest.unstable_mockModule('../../../src/tui/editFlow.js', () => ({
  editAtomContent: mockEditAtomContent,
}));

const {AtomDetail} = await import('../../../src/tui/screens/AtomDetail.js');
const {App} = await import('../../../src/tui/App.js');

const LIST_ROW = {
  scope: 'project',
  project: '/home/user/proj',
  topic: 'arch/foo',
  description: 'Foo description',
  summary: 'Foo summary',
  preview: 'Foo prev',
  pinned: 1,
  always_include: 0,
  status: 'active',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
};

const ATOM_GET_MATCH = {
  scope: 'project',
  project: '/home/user/proj',
  topic: 'arch/foo',
  description: 'Foo description',
  content: 'Full atom content body.',
  tags: JSON.stringify(['infra', 'design']),
  status: 'active',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
};

function Seed({atom, children}) {
  const [, dispatch] = useAppState();
  useEffect(() => {
    dispatch({type: 'SET_SELECTED_ATOM', atom});
  }, []);
  return children;
}

function renderScreen(atom = LIST_ROW) {
  return renderInk(
    React.createElement(
      AppStateProvider,
      null,
      React.createElement(Seed, {atom}, React.createElement(AtomDetail))
    )
  );
}

beforeEach(() => {
  mockSpawnMemory.mockReset();
  mockSpawnMemory.mockImplementation(async (cmd) => {
    if (cmd === 'atom-get') {
      return {ok: true, data: {match: ATOM_GET_MATCH, alsoIn: []}};
    }
    if (cmd === 'atom-patch') {
      return {ok: true, data: {patched: ['pinned']}};
    }
    if (cmd === 'atom-delete') {
      return {ok: true, data: {deleted: true}};
    }
    throw new Error(`unexpected cmd ${cmd}`);
  });
  mockEditAtomContent.mockReset();
  mockEditAtomContent.mockResolvedValue({changed: false});
});

describe('AtomDetail display', () => {
  it('Metadata is shown', async () => {
    const {lastFrame} = renderScreen();
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('active');
    expect(frame).toContain('Pinned: yes');
    expect(frame).toContain('Always Include: no');
    expect(frame).toContain('infra');
    expect(frame).toContain('design');
    expect(frame).toContain('Full atom content body.');
  });

  it('Action bar reflects available actions', async () => {
    const {lastFrame} = renderScreen();
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('[e] Edit');
    expect(frame).toContain('Pin');
    expect(frame).toContain('Always Include');
    expect(frame).toContain('Status');
    expect(frame).toContain('[d] Delete');
    expect(frame).toContain('Back');
  });
});

describe('AtomDetail lifecycle actions', () => {
  it('Toggling pinned on', async () => {
    const {lastFrame, stdin} = renderScreen({...LIST_ROW, pinned: 0});
    await flush();

    await type(stdin, 'p');

    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-patch', [
      LIST_ROW.project,
      JSON.stringify({workspace: '.', topic: LIST_ROW.topic, pinned: true}),
    ]);
    expect(lastFrame()).toContain('Pinned: yes');
  });

  it('Toggling pinned off', async () => {
    const {lastFrame, stdin} = renderScreen({...LIST_ROW, pinned: 1});
    await flush();

    await type(stdin, 'p');

    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-patch', [
      LIST_ROW.project,
      JSON.stringify({workspace: '.', topic: LIST_ROW.topic, pinned: false}),
    ]);
    expect(lastFrame()).toContain('Pinned: no');
  });

  it('Toggling always_include on', async () => {
    const {lastFrame, stdin} = renderScreen({...LIST_ROW, always_include: 0});
    await flush();

    await type(stdin, 'a');

    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-patch', [
      LIST_ROW.project,
      JSON.stringify({
        workspace: '.',
        topic: LIST_ROW.topic,
        always_include: true,
      }),
    ]);
    expect(lastFrame()).toContain('Always Include: yes');
  });

  it('Toggling always_include off', async () => {
    const {lastFrame, stdin} = renderScreen({...LIST_ROW, always_include: 1});
    await flush();

    await type(stdin, 'a');

    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-patch', [
      LIST_ROW.project,
      JSON.stringify({
        workspace: '.',
        topic: LIST_ROW.topic,
        always_include: false,
      }),
    ]);
    expect(lastFrame()).toContain('Always Include: no');
  });

  it('Cycling status', async () => {
    const {lastFrame, stdin} = renderScreen({...LIST_ROW, status: 'active'});
    await flush();

    await type(stdin, 's');
    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-patch', [
      LIST_ROW.project,
      JSON.stringify({workspace: '.', topic: LIST_ROW.topic, status: 'resolved'}),
    ]);
    expect(lastFrame()).toContain('Status: resolved');

    await type(stdin, 's');
    expect(lastFrame()).toContain('Status: deprecated');

    await type(stdin, 's');
    expect(lastFrame()).toContain('Status: active');
  });

  it('Uses a global-scope patch when the atom is global', async () => {
    const {stdin} = renderScreen({...LIST_ROW, scope: 'global', project: '', pinned: 0});
    await flush();

    await type(stdin, 'p');

    const [, args] = mockSpawnMemory.mock.calls.find(([cmd]) => cmd === 'atom-patch');
    const [, payloadJson] = args;
    expect(JSON.parse(payloadJson).workspace).toBeNull();
  });

  it('Edit action invokes the edit flow with the fetched content and existing metadata', async () => {
    mockEditAtomContent.mockResolvedValue({changed: false});
    const {stdin} = renderScreen();
    await flush();

    await type(stdin, 'e');

    expect(mockEditAtomContent).toHaveBeenCalledWith({
      atom: {
        scope: LIST_ROW.scope,
        project: LIST_ROW.project,
        topic: LIST_ROW.topic,
        description: LIST_ROW.description,
        summary: LIST_ROW.summary,
        tags: ATOM_GET_MATCH.tags,
      },
      content: ATOM_GET_MATCH.content,
      suspendTerminal: expect.any(Function),
    });
  });

  it('Re-fetches the atom fresh after a successful edit', async () => {
    mockEditAtomContent.mockResolvedValue({changed: true, content: 'Edited content.'});
    const {lastFrame, stdin} = renderScreen();
    await flush();

    const atomGetCallsBefore = mockSpawnMemory.mock.calls.filter(
      ([cmd]) => cmd === 'atom-get'
    ).length;

    await type(stdin, 'e');
    await flush();

    const atomGetCallsAfter = mockSpawnMemory.mock.calls.filter(
      ([cmd]) => cmd === 'atom-get'
    ).length;

    expect(atomGetCallsAfter).toBe(atomGetCallsBefore + 1);
    expect(lastFrame()).toContain(ATOM_GET_MATCH.content);
  });

  it('Does not re-fetch when the edit made no change', async () => {
    mockEditAtomContent.mockResolvedValue({changed: false});
    const {stdin} = renderScreen();
    await flush();

    const atomGetCallsBefore = mockSpawnMemory.mock.calls.filter(
      ([cmd]) => cmd === 'atom-get'
    ).length;

    await type(stdin, 'e');
    await flush();

    const atomGetCallsAfter = mockSpawnMemory.mock.calls.filter(
      ([cmd]) => cmd === 'atom-get'
    ).length;

    expect(atomGetCallsAfter).toBe(atomGetCallsBefore);
  });

  it('Surfaces an error instead of crashing when the edit flow rejects', async () => {
    mockEditAtomContent.mockRejectedValue(new Error('spawn ENOENT'));
    const {lastFrame, stdin} = renderScreen();
    await flush();

    await type(stdin, 'e');
    await flush();

    expect(lastFrame()).toContain('spawn ENOENT');
  });
});

describe('AtomDetail delete confirmation', () => {
  it('Requesting delete opens a confirmation and issues no delete yet', async () => {
    const {lastFrame, stdin} = renderScreen();
    await flush();

    await type(stdin, 'd');

    expect(lastFrame()).toContain('Confirm');
    expect(mockSpawnMemory).not.toHaveBeenCalledWith(
      'atom-delete',
      expect.anything()
    );
  });

  it('Confirming delete issues atom-delete for exactly the selected atom', async () => {
    const {stdin} = renderScreen();
    await flush();

    await type(stdin, 'd');
    await type(stdin, 'y');

    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-delete', [
      LIST_ROW.project,
      JSON.stringify({workspace: '.', topic: LIST_ROW.topic}),
    ]);
  });

  it('Confirming delete with Enter also works and returns to the browser', async () => {
    const {stdin} = renderScreen();
    await flush();

    await type(stdin, 'd');
    await type(stdin, '\r');

    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-delete', [
      LIST_ROW.project,
      JSON.stringify({workspace: '.', topic: LIST_ROW.topic}),
    ]);
  });

  it('Confirming delete actually returns to the Atom Browser screen (full-app integration)', async () => {
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'atom-list') {
        return {ok: true, data: [LIST_ROW]};
      }
      if (cmd === 'atom-get') {
        return {ok: true, data: {match: ATOM_GET_MATCH, alsoIn: []}};
      }
      if (cmd === 'atom-delete') {
        return {ok: true, data: {deleted: true}};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame, stdin} = renderInk(React.createElement(App));

    await type(stdin, '2'); // Main Menu → Browse Project Atoms
    await flush();
    await type(stdin, '\r'); // open the (only) atom
    await flush();
    expect(lastFrame()).toContain('arch/foo');

    await type(stdin, 'd');
    await type(stdin, 'y');
    await flush();

    expect(lastFrame()).toContain('Atom Browser — Project');
    expect(lastFrame()).not.toContain('[e] Edit');
  });

  it('Cancelling delete with n issues zero deletes and leaves the atom unmodified', async () => {
    const {lastFrame, stdin} = renderScreen();
    await flush();

    await type(stdin, 'd');
    await type(stdin, 'n');

    expect(mockSpawnMemory).not.toHaveBeenCalledWith(
      'atom-delete',
      expect.anything()
    );
    expect(lastFrame()).toContain(LIST_ROW.topic);
    expect(lastFrame()).not.toContain('Confirm');
  });

  it('Cancelling delete with Escape issues zero deletes and leaves the atom unmodified', async () => {
    const {lastFrame, stdin} = renderScreen();
    await flush();

    await type(stdin, 'd');
    await type(stdin, '\u001B');

    expect(mockSpawnMemory).not.toHaveBeenCalledWith(
      'atom-delete',
      expect.anything()
    );
    expect(lastFrame()).toContain(LIST_ROW.topic);
    expect(lastFrame()).not.toContain('Confirm');
  });

  it('Ignores other lifecycle actions while the confirmation is open', async () => {
    const {stdin} = renderScreen({...LIST_ROW, pinned: 0});
    await flush();

    await type(stdin, 'd');
    await type(stdin, 'p');

    expect(mockSpawnMemory).not.toHaveBeenCalledWith(
      'atom-patch',
      expect.anything()
    );
  });

  it('Uses a global-scope atom-delete when the atom is global', async () => {
    const {stdin} = renderScreen({...LIST_ROW, scope: 'global', project: ''});
    await flush();

    await type(stdin, 'd');
    await type(stdin, 'y');

    const [, args] = mockSpawnMemory.mock.calls.find(([cmd]) => cmd === 'atom-delete');
    const [, payloadJson] = args;
    expect(JSON.parse(payloadJson).workspace).toBeNull();
  });
});

describe('AtomDetail error state', () => {
  it('Surfaces an error when atom-get fails', async () => {
    mockSpawnMemory.mockReset();
    mockSpawnMemory.mockImplementation(async (cmd) => {
      if (cmd === 'atom-get') {
        return {ok: false, message: 'malformed response from memory.js'};
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const {lastFrame} = renderScreen();
    await flush();

    expect(lastFrame()).toContain('malformed response from memory.js');
  });
});
