// src/tui/screens/PrimerInspector.js — Primer Inspector screen.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Primer Inspector fidelity

import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {spawnMemory} from '../spawn/memoryClient.js';
import {useAppState} from '../state/AppStateContext.js';
import {StatusLine} from '../components/StatusLine.js';
import {ListPane} from '../components/ListPane.js';
import {PreviewPane} from '../components/PreviewPane.js';

export function PrimerInspector() {
  const [state, dispatch] = useAppState();
  const {agent: selectedAgent, project: selectedProject} = state.primer;

  const [pairs, setPairs] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [primerText, setPrimerText] = useState(null);
  const [status, setStatus] = useState({kind: 'loading'});

  // Fresh read on every mount — no caching across screen visits, per
  // "Read-only, no cross-visit caching".
  useEffect(() => {
    let cancelled = false;
    setStatus({kind: 'loading'});
    spawnMemory('hot-state-list-pairs', []).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setStatus({kind: 'error', message: result.message});
        return;
      }
      const list = result.data.pairs ?? [];
      setPairs(list);
      setStatus(
        list.length === 0
          ? {kind: 'empty', message: 'No sessions recorded yet.'}
          : {kind: 'idle'}
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedAgent === null) {
      return undefined;
    }
    let cancelled = false;
    setStatus({kind: 'loading'});
    setPrimerText(null);
    spawnMemory('primer-preview', [selectedAgent, selectedProject]).then(
      (result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setStatus({kind: 'error', message: result.message});
          return;
        }
        setPrimerText(result.data.primerText);
        setStatus({kind: 'idle'});
      }
    );
    return () => {
      cancelled = true;
    };
  }, [selectedAgent, selectedProject]);

  useInput((_input, key) => {
    if (pairs.length === 0) {
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(c + 1, pairs.length - 1));
    } else if (key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
    } else if (key.return) {
      const pair = pairs[cursor];
      dispatch({
        type: 'SET_PRIMER_TARGET',
        agent: pair.agent,
        project: pair.project,
      });
    }
  });

  return React.createElement(
    Box,
    {flexDirection: 'column'},
    React.createElement(Text, {bold: true}, 'Primer Inspector'),
    React.createElement(StatusLine, {status}),
    React.createElement(ListPane, {
      items: pairs,
      selectedIndex: cursor,
      renderItem: (pair) => `${pair.agent} / ${pair.project || '(shared)'}`,
    }),
    React.createElement(PreviewPane, {content: primerText})
  );
}
