#!/usr/bin/env node
// src/tui.js — TUI entry point.
//
// Renders the Ink application. Reads AGENT_MEMORY_DB from the environment (if
// set) so both the TUI process and every memory.js subcommand it spawns
// operate on the same database file (spec: Database path is passed through).
// This module never opens the SQLite database itself — see memoryClient.js.

import { render } from 'ink';
import React from 'react';
import { App } from './tui/App.js';

render(React.createElement(App));
