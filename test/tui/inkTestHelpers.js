// test/tui/inkTestHelpers.js — shared ink-testing-library helpers.
//
// Ink's useInput hook registers its listener inside a useEffect, which React
// schedules asynchronously (even in Ink's "legacy" sync-render mode).
// stdin.write() must therefore be wrapped in act(async () => ...) with a
// microtask flush so the listener is attached and the resulting dispatch's
// re-render has committed before lastFrame() is read.
//
// A lone Escape byte is additionally buffered by Ink's input parser for
// pendingInputFlushDelayMilliseconds (20ms, see ink/build/components/App.js)
// to disambiguate it from the start of an arrow-key escape sequence, so a
// real (not just microtask) delay is needed after writing it. The same delay
// is applied to every keystroke for consistency.

import React from 'react';
import {act} from 'react';
import {render} from 'ink-testing-library';

export async function type(stdin, input) {
  await act(async () => {
    stdin.write(input);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

// Flushes pending async state updates (e.g. an in-flight spawnMemory
// promise resolving) that aren't triggered by a stdin write, so the
// resulting re-render is act()-wrapped and doesn't warn.
export async function flush(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function renderInk(element) {
  let instance;
  act(() => {
    instance = render(element);
  });
  return instance;
}

export function unmountInk(instance) {
  act(() => {
    instance.unmount();
  });
}

export {React};
