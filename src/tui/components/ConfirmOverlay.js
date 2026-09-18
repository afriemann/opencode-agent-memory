// src/tui/components/ConfirmOverlay.js — delete confirmation overlay.
//
// Pure display; the parent screen owns the y/n/Enter/Esc handling in its
// own useInput (see AtomDetail.js) so a single input source of truth
// decides whether to act on a keypress — avoiding a race between this
// overlay's own hook and App.js's global Escape handler.

import React from 'react';
import {Box, Text} from 'ink';

export function ConfirmOverlay({message}) {
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'red',
      paddingX: 1,
    },
    React.createElement(Text, null, message),
    React.createElement(Text, {dimColor: true}, '[y/Enter] Confirm  [n/Esc] Cancel')
  );
}
