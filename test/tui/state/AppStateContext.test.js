// test/tui/state/AppStateContext.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Main Menu navigation (Escape always returns toward the Main Menu)
//
// Tests the reducer directly (design.md Decision 1) — no Ink rendering
// needed for pure state-transition logic.

import {reducer, initialState} from '../../../src/tui/state/AppStateContext.js';

describe('AppStateContext reducer', () => {
  it('PUSH_SCREEN appends to the navigation stack', () => {
    const state = reducer(initialState, {
      type: 'PUSH_SCREEN',
      screen: 'browser',
      params: {scope: 'project'},
    });

    expect(state.nav).toEqual([
      {screen: 'menu'},
      {screen: 'browser', params: {scope: 'project'}},
    ]);
  });

  it('POP_SCREEN removes the top of a multi-entry stack', () => {
    const pushed = reducer(initialState, {type: 'PUSH_SCREEN', screen: 'primer'});
    const popped = reducer(pushed, {type: 'POP_SCREEN'});

    expect(popped.nav).toEqual([{screen: 'menu'}]);
  });

  it('POP_SCREEN is a no-op at the root of the stack', () => {
    const popped = reducer(initialState, {type: 'POP_SCREEN'});

    expect(popped.nav).toEqual([{screen: 'menu'}]);
  });

  it('SET_PRIMER_TARGET sets the agent+project pair', () => {
    const state = reducer(initialState, {
      type: 'SET_PRIMER_TARGET',
      agent: 'claude',
      project: '/home/user/project',
    });

    expect(state.primer).toEqual({agent: 'claude', project: '/home/user/project'});
  });

  it('SET_SCOPE sets the atom-browser scope', () => {
    const state = reducer(initialState, {type: 'SET_SCOPE', scope: 'global'});

    expect(state.browser).toEqual({scope: 'global'});
  });

  it('SET_SELECTED_ATOM sets the selected atom', () => {
    const atom = {workspace: '/repo', topic: 'foo/bar'};
    const state = reducer(initialState, {type: 'SET_SELECTED_ATOM', atom});

    expect(state.selectedAtom).toEqual(atom);
  });

  it('SET_STATUS sets the status slice', () => {
    const state = reducer(initialState, {
      type: 'SET_STATUS',
      status: {kind: 'error', message: 'boom'},
    });

    expect(state.status).toEqual({kind: 'error', message: 'boom'});
  });

  it('SET_CONFIRM_OPEN sets the confirmOpen flag', () => {
    const opened = reducer(initialState, {type: 'SET_CONFIRM_OPEN', value: true});
    expect(opened.confirmOpen).toBe(true);

    const closed = reducer(opened, {type: 'SET_CONFIRM_OPEN', value: false});
    expect(closed.confirmOpen).toBe(false);
  });

  it('unrelated actions leave other state slices untouched', () => {
    const withScope = reducer(initialState, {type: 'SET_SCOPE', scope: 'global'});
    const withPush = reducer(withScope, {type: 'PUSH_SCREEN', screen: 'detail'});

    expect(withPush.browser).toEqual({scope: 'global'});
  });
});
