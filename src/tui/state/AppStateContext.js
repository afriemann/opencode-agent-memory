// src/tui/state/AppStateContext.js — cross-screen state: navigation stack,
// primer target, atom-browser scope, selected atom, per-screen status.
//
// A plain useReducer-driven state machine (not a router library) — see
// design.md Decision 1.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Main Menu navigation

import React, {useContext, useReducer} from 'react';

export const AppStateContext = React.createContext(null);

export const initialState = {
  nav: [{screen: 'menu'}],
  primer: {agent: null, project: null},
  browser: {scope: 'project'},
  selectedAtom: null,
  status: {kind: 'idle', message: undefined},
  confirmOpen: false,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'PUSH_SCREEN': {
      const entry =
        action.params !== undefined
          ? {screen: action.screen, params: action.params}
          : {screen: action.screen};
      return {...state, nav: [...state.nav, entry]};
    }
    case 'POP_SCREEN': {
      if (state.nav.length <= 1) {
        return state;
      }
      return {...state, nav: state.nav.slice(0, -1)};
    }
    case 'SET_PRIMER_TARGET':
      return {
        ...state,
        primer: {agent: action.agent, project: action.project},
      };
    case 'SET_SCOPE':
      return {...state, browser: {scope: action.scope}};
    case 'SET_SELECTED_ATOM':
      return {...state, selectedAtom: action.atom};
    case 'SET_STATUS':
      return {...state, status: action.status};
    // Set while a screen-local confirmation (e.g. delete) has input focus,
    // so the global Escape handler in App.js can defer to it instead of
    // popping the navigation stack out from under an open confirmation.
    case 'SET_CONFIRM_OPEN':
      return {...state, confirmOpen: action.value};
    default:
      return state;
  }
}

export function AppStateProvider({children}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = React.useMemo(() => [state, dispatch], [state]);
  return React.createElement(AppStateContext.Provider, {value}, children);
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (value === null) {
    throw new Error('useAppState must be used within an AppStateProvider');
  }
  return value;
}
