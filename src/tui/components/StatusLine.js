// src/tui/components/StatusLine.js — shared loading/error/empty status banner.
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   (state table referenced across every screen requirement)

import React from 'react';
import {Text} from 'ink';

export function StatusLine({status}) {
  if (!status || status.kind === 'idle') {
    return null;
  }

  if (status.kind === 'loading') {
    return React.createElement(Text, {color: 'yellow'}, 'Loading…');
  }

  if (status.kind === 'error') {
    return React.createElement(Text, {color: 'red'}, status.message);
  }

  // empty
  return React.createElement(Text, {dimColor: true}, status.message);
}
