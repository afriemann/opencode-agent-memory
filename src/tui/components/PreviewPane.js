// src/tui/components/PreviewPane.js — shared right-hand preview pane.

import React from 'react';
import {Box, Text} from 'ink';

export function PreviewPane({content}) {
  return React.createElement(
    Box,
    {flexDirection: 'column'},
    React.createElement(Text, null, content ?? '')
  );
}
