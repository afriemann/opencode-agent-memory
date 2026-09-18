// src/tui/screens/AtomDetail.js — Atom Detail & Actions screen.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Atom Detail & Actions display
//
// Display only in this task — pin/always_include/status toggles are wired
// in task 9, the $EDITOR flow in task 10, delete confirmation in task 11.
//
// The atom-list row (already fetched by AtomBrowser and passed via
// SET_SELECTED_ATOM) carries pinned/always_include/summary; atom-get is
// fetched once per screen-load — not per-keystroke — for the fields it
// alone provides: full content and tags. The two are merged locally rather
// than adding pinned/always_include/summary to atom-get's SELECT, since
// design.md's Non-Goals excludes changing schema.js's existing exports'
// behavior.

import React, {useEffect, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {spawnMemory} from '../spawn/memoryClient.js';
import {useAppState} from '../state/AppStateContext.js';
import {StatusLine} from '../components/StatusLine.js';
import {ConfirmOverlay} from '../components/ConfirmOverlay.js';
import {editAtomContent} from '../editFlow.js';

const STATUS_CYCLE = ['active', 'resolved', 'deprecated'];

function nextStatus(current) {
  const index = STATUS_CYCLE.indexOf(current);
  return STATUS_CYCLE[(index + 1) % STATUS_CYCLE.length];
}

function parseTags(tagsJson) {
  if (!tagsJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function AtomDetail() {
  const [state, dispatch] = useAppState();
  const {suspendTerminal} = useApp();
  const listRow = state.selectedAtom;
  const confirmOpen = state.confirmOpen;

  const [content, setContent] = useState(null);
  const [tags, setTags] = useState([]);
  const [tagsJson, setTagsJson] = useState(null);
  const [status, setStatus] = useState({kind: 'idle'});
  const [pinned, setPinned] = useState(false);
  const [alwaysInclude, setAlwaysInclude] = useState(false);
  const [atomStatus, setAtomStatus] = useState('active');
  const [reloadToken, setReloadToken] = useState(0);

  // listRow only changes reference when a different atom is selected (or,
  // in tests, when it transitions from null to the seeded value after
  // mount) — re-sync the locally-editable lifecycle fields from it each
  // time, mirroring the content/tags fetch effect below.
  useEffect(() => {
    if (!listRow) {
      return;
    }
    setPinned(Boolean(listRow.pinned));
    setAlwaysInclude(Boolean(listRow.always_include));
    setAtomStatus(listRow.status ?? 'active');
  }, [listRow]);

  // Fetched once per screen-load, and again after a successful $EDITOR edit
  // (reloadToken bump) — never per-keystroke — so the on-screen content
  // always reflects exactly what was persisted, not a locally-held copy.
  useEffect(() => {
    if (!listRow) {
      return undefined;
    }
    let cancelled = false;
    setStatus({kind: 'loading'});
    spawnMemory('atom-get', [listRow.scope, listRow.project, listRow.topic]).then(
      (result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setStatus({kind: 'error', message: result.message});
          return;
        }
        const match = result.data.match;
        setContent(match ? match.content : '');
        setTagsJson(match ? match.tags : null);
        setTags(match ? parseTags(match.tags) : []);
        setStatus({kind: 'idle'});
      }
    );
    return () => {
      cancelled = true;
    };
  }, [listRow, reloadToken]);

  async function patchAtom(fields) {
    if (!listRow) {
      return {ok: false, message: 'No atom selected.'};
    }
    const contextDirectory = listRow.scope === 'global' ? process.cwd() : listRow.project;
    const workspace = listRow.scope === 'global' ? null : '.';
    return spawnMemory('atom-patch', [
      contextDirectory,
      JSON.stringify({workspace, topic: listRow.topic, ...fields}),
    ]);
  }

  async function deleteAtom() {
    if (!listRow) {
      return {ok: false, message: 'No atom selected.'};
    }
    const contextDirectory = listRow.scope === 'global' ? process.cwd() : listRow.project;
    const workspace = listRow.scope === 'global' ? null : '.';
    return spawnMemory('atom-delete', [
      contextDirectory,
      JSON.stringify({workspace, topic: listRow.topic}),
    ]);
  }

  useInput((input, key) => {
    if (!listRow) {
      return;
    }
    // While the delete confirmation has focus, every other action is
    // disabled — only y/Enter (confirm) and n/Esc (cancel) are handled,
    // and App.js's global Escape handler defers to this via confirmOpen.
    if (confirmOpen) {
      if (input === 'y' || key.return) {
        deleteAtom().then((result) => {
          dispatch({type: 'SET_CONFIRM_OPEN', value: false});
          if (result.ok) {
            dispatch({type: 'POP_SCREEN'});
          } else {
            setStatus({kind: 'error', message: result.message});
          }
        });
      } else if (input === 'n' || key.escape) {
        dispatch({type: 'SET_CONFIRM_OPEN', value: false});
      }
      return;
    }
    if (input === 'p') {
      const next = !pinned;
      patchAtom({pinned: next}).then((result) => {
        if (result.ok) {
          setPinned(next);
        } else {
          setStatus({kind: 'error', message: result.message});
        }
      });
    } else if (input === 'a') {
      const next = !alwaysInclude;
      patchAtom({always_include: next}).then((result) => {
        if (result.ok) {
          setAlwaysInclude(next);
        } else {
          setStatus({kind: 'error', message: result.message});
        }
      });
    } else if (input === 's') {
      const next = nextStatus(atomStatus);
      patchAtom({status: next}).then((result) => {
        if (result.ok) {
          setAtomStatus(next);
        } else {
          setStatus({kind: 'error', message: result.message});
        }
      });
    } else if (input === 'e') {
      editAtomContent({
        atom: {
          scope: listRow.scope,
          project: listRow.project,
          topic: listRow.topic,
          description: listRow.description,
          summary: listRow.summary,
          tags: tagsJson,
        },
        content,
        suspendTerminal,
      })
        .then((outcome) => {
          if (outcome.changed) {
            setReloadToken((token) => token + 1);
          }
        })
        .catch((err) => {
          // editAtomContent only guarantees temp-dir cleanup (try/finally);
          // it does not swallow errors from the editor process or the
          // filesystem (e.g. $EDITOR/vi missing from PATH). Surface as an
          // error state instead of an unhandled rejection crashing the TUI.
          setStatus({kind: 'error', message: err.message});
        });
    } else if (input === 'd') {
      dispatch({type: 'SET_CONFIRM_OPEN', value: true});
    }
  });

  if (!listRow) {
    return React.createElement(Text, null, 'No atom selected.');
  }

  return React.createElement(
    Box,
    {flexDirection: 'column'},
    React.createElement(Text, {bold: true}, listRow.topic),
    React.createElement(StatusLine, {status}),
    React.createElement(Text, null, `Status: ${atomStatus}`),
    React.createElement(Text, null, `Pinned: ${pinned ? 'yes' : 'no'}`),
    React.createElement(
      Text,
      null,
      `Always Include: ${alwaysInclude ? 'yes' : 'no'}`
    ),
    React.createElement(
      Text,
      null,
      `Tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`
    ),
    React.createElement(Text, null, ''),
    React.createElement(Text, null, content ?? ''),
    React.createElement(Text, null, ''),
    React.createElement(
      Text,
      {dimColor: true},
      '[e] Edit  [p] Pin  [a] Always Include  [s] Status  [d] Delete  [Esc] Back'
    ),
    confirmOpen
      ? React.createElement(ConfirmOverlay, {
          message: `Delete "${listRow.topic}"? This cannot be undone.`,
        })
      : null
  );
}
