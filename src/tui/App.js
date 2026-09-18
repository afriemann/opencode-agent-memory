// src/tui/App.js — app shell: screen router + global key handling.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Main Menu navigation

import React from 'react';
import {useInput} from 'ink';
import {AppStateProvider, useAppState} from './state/AppStateContext.js';
import {MainMenu} from './screens/MainMenu.js';
import {PrimerInspector} from './screens/PrimerInspector.js';
import {AtomBrowser} from './screens/AtomBrowser.js';
import {AtomDetail} from './screens/AtomDetail.js';

function AppShell() {
  const [state, dispatch] = useAppState();

  useInput((_input, key) => {
    if (key.escape && !state.confirmOpen) {
      dispatch({type: 'POP_SCREEN'});
    }
  });

  const current = state.nav[state.nav.length - 1];

  switch (current.screen) {
    case 'primer':
      return React.createElement(PrimerInspector);
    case 'browser':
      return React.createElement(AtomBrowser);
    case 'detail':
      return React.createElement(AtomDetail);
    case 'menu':
    default:
      return React.createElement(MainMenu);
  }
}

export function App() {
  return React.createElement(AppStateProvider, null, React.createElement(AppShell));
}
