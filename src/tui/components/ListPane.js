// src/tui/components/ListPane.js — shared scrollable list with focus ring.

import React from 'react';
import {Box, Text} from 'ink';

export function ListPane({items, selectedIndex, renderItem}) {
  return React.createElement(
    Box,
    {flexDirection: 'column'},
    ...items.map((item, index) =>
      React.createElement(
        Text,
        {key: index, inverse: index === selectedIndex},
        renderItem(item, index)
      )
    )
  );
}
