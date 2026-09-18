// src/tui/screens/MainMenu.js — Main Menu screen.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Main Menu navigation

import React from 'react';
import {Box, Text, useInput} from 'ink';
import {useAppState} from '../state/AppStateContext.js';

const ITEMS = [
  {key: '1', label: 'Inspect Agent Primer'},
  {key: '2', label: 'Browse Project Atoms'},
  {key: '3', label: 'Browse Global/Shared Atoms'},
  {key: 'q', label: 'Quit'},
];

export function MainMenu() {
  const [, dispatch] = useAppState();

  useInput((input) => {
    if (input === '1') {
      dispatch({type: 'PUSH_SCREEN', screen: 'primer'});
    } else if (input === '2') {
      dispatch({type: 'SET_SCOPE', scope: 'project'});
      dispatch({type: 'PUSH_SCREEN', screen: 'browser', params: {scope: 'project'}});
    } else if (input === '3') {
      dispatch({type: 'SET_SCOPE', scope: 'global'});
      dispatch({type: 'PUSH_SCREEN', screen: 'browser', params: {scope: 'global'}});
    } else if (input === 'q') {
      process.exit(0);
    }
  });

  return React.createElement(
    Box,
    {flexDirection: 'column'},
    React.createElement(Text, {bold: true}, 'Main Menu'),
    ...ITEMS.map((item) =>
      React.createElement(Text, {key: item.key}, `[${item.key}] ${item.label}`)
    )
  );
}
