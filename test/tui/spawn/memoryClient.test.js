// test/tui/spawn/memoryClient.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Spawn/IO error and timeout surfacing
//
// node:child_process is mocked at the module boundary so no test spawns a
// real memory.js process (design.md Decision 6).

import {jest} from '@jest/globals';

const mockExecFile = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  execFile: mockExecFile,
}));

const {spawnMemory} = await import('../../../src/tui/spawn/memoryClient.js');

beforeEach(() => {
  mockExecFile.mockReset();
});

function lastCallArgs() {
  return mockExecFile.mock.calls.at(-1);
}

describe('spawnMemory', () => {
  it('Successful invocation', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({hello: 'world'}), '');
    });

    const result = await spawnMemory('inspect', ['claude', 'my-project']);

    expect(result).toEqual({ok: true, data: {hello: 'world'}});

    const [file, args] = lastCallArgs();
    expect(file).toBe(process.execPath);
    expect(args).toEqual(
      expect.arrayContaining(['inspect', 'claude', 'my-project'])
    );
  });

  it('Non-zero exit surfaces the raw message', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const error = new Error('Command failed');
      error.code = 1;
      callback(error, '', '[memory.js] inspect failed: boom\n');
    });

    const result = await spawnMemory('inspect', ['claude', 'my-project']);

    expect(result).toEqual({
      ok: false,
      message: '[memory.js] inspect failed: boom',
    });
  });

  it('Non-zero exit with empty stderr falls back to the error message', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const error = new Error('spawn ENOENT');
      callback(error, '', '');
    });

    const result = await spawnMemory('inspect', ['claude', 'my-project']);

    expect(result).toEqual({ok: false, message: 'spawn ENOENT'});
  });

  it('Malformed stdout is treated as failure', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'not json {{{', '');
    });

    const result = await spawnMemory('inspect', ['claude', 'my-project']);

    expect(result).toEqual({
      ok: false,
      message: 'malformed response from memory.js',
    });
  });

  it('Hung invocation times out', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const error = new Error('Command timed out');
      error.killed = true;
      error.signal = 'SIGTERM';
      callback(error, '', '');
    });

    const result = await spawnMemory('inspect', ['claude', 'my-project']);

    expect(result).toEqual({
      ok: false,
      message: 'memory.js timed out (>8s) — the database may be locked',
    });
  });

  it('Database path is passed through', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({}), '');
    });

    const previous = process.env.AGENT_MEMORY_DB;
    process.env.AGENT_MEMORY_DB = '/tmp/some-test.db';
    try {
      await spawnMemory('inspect', ['claude', 'my-project']);
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_MEMORY_DB;
      } else {
        process.env.AGENT_MEMORY_DB = previous;
      }
    }

    const [, , options] = lastCallArgs();
    expect(options.env.AGENT_MEMORY_DB).toBe('/tmp/some-test.db');
  });

  it('Passes the 8s timeout and 10 MB maxBuffer options', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({}), '');
    });

    await spawnMemory('inspect', ['claude', 'my-project']);

    const [, , options] = lastCallArgs();
    expect(options.timeout).toBe(8000);
    expect(options.maxBuffer).toBe(10 * 1024 * 1024);
  });
});
