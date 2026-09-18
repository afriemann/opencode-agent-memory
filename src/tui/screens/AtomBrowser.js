// src/tui/screens/AtomBrowser.js — Atom Browser screen.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Atom Browser

import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {spawnMemory} from '../spawn/memoryClient.js';
import {useAppState} from '../state/AppStateContext.js';
import {findGitRootOrNull} from '../../lib/workspace.js';
import {StatusLine} from '../components/StatusLine.js';
import {ListPane} from '../components/ListPane.js';
import {PreviewPane} from '../components/PreviewPane.js';

function currentProject() {
  return findGitRootOrNull(process.cwd()) ?? '';
}

function formatAtomLine(atom) {
  const pin = atom.pinned ? '📌 ' : '';
  return `${pin}${atom.topic} [${atom.status}]`;
}

function formatPreview(atom) {
  if (!atom) {
    return null;
  }
  return [
    atom.description,
    '',
    atom.summary,
    '',
    `updated: ${atom.updated_at}`,
  ].join('\n');
}

export function AtomBrowser() {
  const [state, dispatch] = useAppState();
  const {scope} = state.browser;

  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState({kind: 'loading'});

  // Re-fetch whenever scope changes; selection resets to 0 by construction
  // (a fresh fetch always starts the cursor at the top row).
  useEffect(() => {
    let cancelled = false;
    setStatus({kind: 'loading'});
    setCursor(0);
    const project = scope === 'global' ? '' : currentProject();
    spawnMemory('atom-list', [scope, project]).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setStatus({kind: 'error', message: result.message});
        return;
      }
      // atom-list mixes in global atoms for scope='project' composition
      // callers; the browser wants a pure per-scope listing since the two
      // scopes are separate menu options.
      const list = (result.data ?? []).filter((atom) => atom.scope === scope);
      setItems(list);
      setStatus(
        list.length === 0
          ? {kind: 'empty', message: 'No atoms found in this scope.'}
          : {kind: 'idle'}
      );
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useInput((input, key) => {
    if (key.tab) {
      dispatch({type: 'SET_SCOPE', scope: scope === 'project' ? 'global' : 'project'});
      return;
    }
    if (items.length === 0) {
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
    } else if (key.return) {
      dispatch({type: 'SET_SELECTED_ATOM', atom: items[cursor]});
      dispatch({type: 'PUSH_SCREEN', screen: 'detail'});
    }
  });

  const title = scope === 'project' ? 'Atom Browser — Project' : 'Atom Browser — Global/Shared';

  return React.createElement(
    Box,
    {flexDirection: 'column'},
    React.createElement(Text, {bold: true}, title),
    React.createElement(StatusLine, {status}),
    React.createElement(ListPane, {
      items,
      selectedIndex: cursor,
      renderItem: formatAtomLine,
    }),
    React.createElement(PreviewPane, {content: formatPreview(items[cursor])})
  );
}
