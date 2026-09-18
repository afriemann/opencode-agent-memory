// test/tui/editFlow.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Edit content via $EDITOR
//
// Pure-ish helper decoupled from Ink rendering (design.md Decision 6):
// suspendTerminal is injected as a parameter (it only comes from the
// useApp() hook at render time), while node:fs/promises, node:child_process,
// and spawnMemory are mocked at the module boundary.

import {jest} from '@jest/globals';

const mockMkdtemp = jest.fn();
const mockRm = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockSpawn = jest.fn();
const mockSpawnMemory = jest.fn();

jest.unstable_mockModule('node:fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  rm: mockRm,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

jest.unstable_mockModule('../../src/tui/spawn/memoryClient.js', () => ({
  spawnMemory: mockSpawnMemory,
}));

const {editAtomContent} = await import('../../src/tui/editFlow.js');

const ATOM = {
  scope: 'project',
  project: '/home/user/proj',
  topic: 'arch/foo',
  description: 'Foo description',
  summary: 'Foo summary',
  tags: JSON.stringify(['infra']),
};

class FakeChild {
  constructor() {
    this._listeners = {};
  }

  on(event, handler) {
    this._listeners[event] = handler;
    return this;
  }

  emitExit(code) {
    this._listeners.exit?.(code);
  }
}

function makeSuspendTerminal() {
  const fn = jest.fn(async (callback) => {
    await callback();
  });
  return fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdtemp.mockResolvedValue('/tmp/agent-memory-tui-abc123');
  mockRm.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockSpawnMemory.mockResolvedValue({ok: true, data: {}});
});

describe('editAtomContent', () => {
  it('Editing and saving a change', async () => {
    const child = new FakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emitExit(0));
      return child;
    });
    mockReadFile.mockResolvedValue('New content.');
    const suspendTerminal = makeSuspendTerminal();

    const outcome = await editAtomContent({
      atom: ATOM,
      content: 'Old content.',
      suspendTerminal,
    });

    expect(suspendTerminal).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({changed: true, content: 'New content.'});
    expect(mockSpawnMemory).toHaveBeenCalledWith('atom-write', [
      ATOM.project,
      JSON.stringify({
        workspace: '.',
        topic: ATOM.topic,
        content: 'New content.',
        description: ATOM.description,
        summary: ATOM.summary,
        tags: ATOM.tags,
      }),
    ]);
    expect(mockRm).toHaveBeenCalledWith('/tmp/agent-memory-tui-abc123', {
      recursive: true,
      force: true,
    });
  });

  it('Exiting the editor without changes', async () => {
    const child = new FakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emitExit(0));
      return child;
    });
    mockReadFile.mockResolvedValue('Old content.');
    const suspendTerminal = makeSuspendTerminal();

    const outcome = await editAtomContent({
      atom: ATOM,
      content: 'Old content.',
      suspendTerminal,
    });

    expect(outcome).toEqual({changed: false});
    expect(mockSpawnMemory).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalled();
  });

  it('Editor exits with a non-zero code', async () => {
    const child = new FakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emitExit(1));
      return child;
    });
    mockReadFile.mockResolvedValue('New content.');
    const suspendTerminal = makeSuspendTerminal();

    const outcome = await editAtomContent({
      atom: ATOM,
      content: 'Old content.',
      suspendTerminal,
    });

    expect(outcome).toEqual({changed: false});
    expect(mockSpawnMemory).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalled();
  });

  it('$EDITOR is unset falls back to a default editor', async () => {
    const previous = process.env.EDITOR;
    delete process.env.EDITOR;
    try {
      const child = new FakeChild();
      mockSpawn.mockImplementation(() => {
        queueMicrotask(() => child.emitExit(0));
        return child;
      });
      mockReadFile.mockResolvedValue('Old content.');
      const suspendTerminal = makeSuspendTerminal();

      await editAtomContent({atom: ATOM, content: 'Old content.', suspendTerminal});

      const [command] = mockSpawn.mock.calls[0];
      expect(command).toMatch(/^vi /);
    } finally {
      if (previous === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = previous;
      }
    }
  });

  it('Terminal is suspended and resumed around the edit', async () => {
    const child = new FakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emitExit(0));
      return child;
    });
    mockReadFile.mockResolvedValue('Old content.');
    const suspendTerminal = makeSuspendTerminal();

    await editAtomContent({atom: ATOM, content: 'Old content.', suspendTerminal});

    expect(suspendTerminal).toHaveBeenCalledTimes(1);
    expect(suspendTerminal.mock.calls[0][0]).toBeInstanceOf(Function);
  });

  it('Uses a global-scope atom-write when the atom is global', async () => {
    const child = new FakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emitExit(0));
      return child;
    });
    mockReadFile.mockResolvedValue('New content.');
    const suspendTerminal = makeSuspendTerminal();
    const globalAtom = {...ATOM, scope: 'global', project: ''};

    await editAtomContent({atom: globalAtom, content: 'Old content.', suspendTerminal});

    const [, args] = mockSpawnMemory.mock.calls[0];
    expect(JSON.parse(args[1]).workspace).toBeNull();
  });

  it('Cleans up the temp directory even if the write fails', async () => {
    const child = new FakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emitExit(0));
      return child;
    });
    mockReadFile.mockRejectedValue(new Error('disk error'));
    const suspendTerminal = makeSuspendTerminal();

    await expect(
      editAtomContent({atom: ATOM, content: 'Old content.', suspendTerminal})
    ).rejects.toThrow('disk error');

    expect(mockRm).toHaveBeenCalled();
  });
});
