## Purpose

Provides a terminal UI for a human operator to inspect an agent's session primer, browse project and shared memory atoms, and change an atom's lifecycle state (content, pin, always_include, status, deletion) without hand-constructing `memory.js` CLI invocations.

## ADDED Requirements

### Requirement: TUI invocation
The system SHALL provide a `bin` entry point and a directly-runnable script that both launch the same terminal UI application.

#### Scenario: Launched via bin entry
- **WHEN** the installed `agent-memory-tui` command is run
- **THEN** the terminal UI application starts and renders the Main Menu screen

#### Scenario: Launched directly via node
- **WHEN** `node src/tui.js` is run
- **THEN** the terminal UI application starts and renders the Main Menu screen, identically to the `bin` entry

### Requirement: Sole-writer boundary
The TUI process SHALL NOT open a direct connection to the SQLite database and SHALL perform every read and write by spawning `memory.js` as a child process.

#### Scenario: No direct database import
- **WHEN** the TUI's source is inspected
- **THEN** no TUI module imports `src/lib/db.js` or `src/lib/schema.js`

#### Scenario: Mutation goes through memory.js
- **WHEN** the TUI performs any atom mutation (content edit, pin toggle, always_include toggle, status change, delete)
- **THEN** the mutation is issued by spawning `src/memory.js` with the corresponding subcommand, and no other process or code path writes to the database

### Requirement: Spawn/IO error and timeout surfacing
The TUI's spawn layer SHALL report every `memory.js` invocation as either a success with parsed data or a failure with a message, and SHALL time out a hung invocation rather than block indefinitely.

#### Scenario: Successful invocation
- **WHEN** a spawned `memory.js` subcommand exits 0 with valid JSON on stdout
- **THEN** the spawn layer resolves with the parsed data and no error is shown

#### Scenario: Non-zero exit surfaces the raw message
- **WHEN** a spawned `memory.js` subcommand exits non-zero
- **THEN** the spawn layer resolves with a failure result carrying the process's stderr (or its own error message if stderr is empty), and the calling screen displays it as an error state

#### Scenario: Malformed stdout is treated as failure
- **WHEN** a spawned `memory.js` subcommand exits 0 but its stdout is not valid JSON
- **THEN** the spawn layer resolves with a failure result rather than throwing

#### Scenario: Hung invocation times out
- **WHEN** a spawned `memory.js` subcommand does not exit within the spawn layer's timeout
- **THEN** the spawn layer terminates the process and resolves with a failure result indicating a timeout

#### Scenario: Database path is passed through
- **WHEN** the TUI process has `AGENT_MEMORY_DB` set in its environment
- **THEN** every spawned `memory.js` invocation receives the same `AGENT_MEMORY_DB` value, so both processes operate on the same database file

### Requirement: Main Menu navigation
The Main Menu screen SHALL let the user reach the Primer Inspector, Atom Browser (project scope), and Atom Browser (global scope), and SHALL let the user quit the application.

#### Scenario: Navigate to Primer Inspector
- **WHEN** the user selects "Inspect Agent Primer" from the Main Menu
- **THEN** the Primer Inspector screen is shown

#### Scenario: Navigate to project-scoped Atom Browser
- **WHEN** the user selects "Browse Project Atoms" from the Main Menu
- **THEN** the Atom Browser screen is shown with scope set to "project"

#### Scenario: Navigate to global-scoped Atom Browser
- **WHEN** the user selects "Browse Global/Shared Atoms" from the Main Menu
- **THEN** the Atom Browser screen is shown with scope set to "global"

#### Scenario: Quit
- **WHEN** the user selects "Quit" from the Main Menu
- **THEN** the TUI process exits

#### Scenario: Escape always returns toward the Main Menu
- **WHEN** the user presses Esc on any screen
- **THEN** the previous screen in the navigation stack is shown, and pressing Esc repeatedly from any screen eventually returns to the Main Menu

### Requirement: Primer Inspector fidelity
The Primer Inspector screen SHALL let the user pick an agent+project pair and SHALL display the exact primer text a real session for that pair would receive, freshly read every time the screen is opened.

#### Scenario: Agent+project picker is populated
- **WHEN** the Primer Inspector screen is opened
- **THEN** it lists every agent+project pair that has at least one `hot_state` row, ordered by most recently updated first

#### Scenario: Selecting a pair shows the assembled primer
- **WHEN** the user selects an agent+project pair
- **THEN** the screen displays the primer text returned by the `primer-preview` subcommand for that exact pair, unmodified

#### Scenario: No sessions recorded
- **WHEN** the Primer Inspector screen is opened and no agent+project pair has any `hot_state` row
- **THEN** the picker shows an explicit "no sessions recorded yet" message instead of a blank pane

#### Scenario: Read-only, no cross-visit caching
- **WHEN** the user leaves the Primer Inspector screen and returns to it
- **THEN** the previously displayed primer text is not reused; a fresh `primer-preview` call is made if a pair is re-selected, and no mutation to any atom or hot_state row occurs as a result of viewing this screen

### Requirement: Atom Browser
The Atom Browser screen SHALL list atoms in the selected scope (project or global) with a live preview pane, and SHALL let the user toggle between project and global scope.

#### Scenario: Listing atoms in project scope
- **WHEN** the Atom Browser screen is opened with scope "project"
- **THEN** it lists the current project's atoms, each showing its topic, status, and pinned indicator

#### Scenario: Listing atoms in global scope
- **WHEN** the Atom Browser screen is opened with scope "global"
- **THEN** it lists the shared/global atoms, each showing its topic, status, and pinned indicator

#### Scenario: Toggling scope
- **WHEN** the user toggles scope while the Atom Browser screen is open
- **THEN** the atom list is re-fetched for the newly selected scope and the previously selected row selection is cleared

#### Scenario: Selecting an atom shows a preview
- **WHEN** the user moves the selection to an atom row
- **THEN** the preview pane shows that atom's description, summary, status, and last-updated timestamp, sourced from the already-fetched list data with no additional spawn per selection change

#### Scenario: Empty scope
- **WHEN** the selected scope has no atoms
- **THEN** the screen shows an explicit "no atoms found in this scope" message instead of a blank list

#### Scenario: Opening an atom
- **WHEN** the user presses Enter on a selected atom row
- **THEN** the Atom Detail & Actions screen is shown for that atom

### Requirement: Atom Detail & Actions display
The Atom Detail & Actions screen SHALL display an atom's full content and metadata, and SHALL expose lifecycle actions for pin, always_include, status, edit, and delete.

#### Scenario: Metadata is shown
- **WHEN** the Atom Detail & Actions screen is opened for an atom
- **THEN** it displays the atom's status, pinned state, always_include state, tags, and full content

#### Scenario: Action bar reflects available actions
- **WHEN** the Atom Detail & Actions screen is shown
- **THEN** the action bar shows the edit, toggle-pin, toggle-always_include, cycle-status, delete, and back actions

### Requirement: Pinned toggle
The user SHALL be able to toggle an atom's pinned state from the Atom Detail & Actions screen.

#### Scenario: Toggling pinned on
- **WHEN** the user triggers the toggle-pin action on an atom that is not pinned
- **THEN** `memory.js` is invoked to set `pinned` true for that atom, and the screen reflects the new pinned state after the call succeeds

#### Scenario: Toggling pinned off
- **WHEN** the user triggers the toggle-pin action on an atom that is pinned
- **THEN** `memory.js` is invoked to set `pinned` false for that atom, and the screen reflects the new pinned state after the call succeeds

### Requirement: Always-include toggle
The user SHALL be able to toggle an atom's always_include state from the Atom Detail & Actions screen.

#### Scenario: Toggling always_include on
- **WHEN** the user triggers the toggle-always_include action on an atom for which it is off
- **THEN** `memory.js` is invoked to set `always_include` true for that atom, and the screen reflects the new state after the call succeeds

#### Scenario: Toggling always_include off
- **WHEN** the user triggers the toggle-always_include action on an atom for which it is on
- **THEN** `memory.js` is invoked to set `always_include` false for that atom, and the screen reflects the new state after the call succeeds

### Requirement: Status cycle
The user SHALL be able to cycle an atom's status through active, resolved, and deprecated from the Atom Detail & Actions screen.

#### Scenario: Cycling status
- **WHEN** the user triggers the cycle-status action
- **THEN** `memory.js` is invoked to set the atom's status to the next value in the sequence active → resolved → deprecated → active, and the screen reflects the new status after the call succeeds

### Requirement: Edit content via $EDITOR
The user SHALL be able to edit an atom's content in their configured external editor, with the change persisted only if the content actually changed and the editor exited successfully.

#### Scenario: Editing and saving a change
- **WHEN** the user triggers the edit action, changes the content in the external editor, and exits the editor successfully
- **THEN** the TUI persists the new content by invoking `memory.js` with the atom's existing description, summary, and tags unchanged alongside the new content, and the detail screen reflects the freshly persisted content afterward

#### Scenario: Exiting the editor without changes
- **WHEN** the user triggers the edit action and exits the editor without changing the content
- **THEN** no write is issued to `memory.js`

#### Scenario: Editor exits with a non-zero code
- **WHEN** the user triggers the edit action and the external editor process exits with a non-zero code
- **THEN** the edit is discarded and no write is issued to `memory.js`

#### Scenario: $EDITOR is unset
- **WHEN** the user triggers the edit action and the `$EDITOR` environment variable is not set
- **THEN** the TUI falls back to a default editor rather than failing

#### Scenario: Terminal is suspended and resumed around the edit
- **WHEN** the edit action is triggered
- **THEN** the TUI's own rendering is suspended for the duration of the external editor process and resumes with a full repaint once the editor exits

### Requirement: Delete confirmation
The user SHALL NOT be able to delete an atom without an explicit confirmation step.

#### Scenario: Requesting delete opens a confirmation
- **WHEN** the user triggers the delete action on an atom
- **THEN** a confirmation prompt is shown and no delete is issued to `memory.js` yet

#### Scenario: Confirming delete
- **WHEN** the user confirms the delete prompt
- **THEN** `memory.js` is invoked to delete exactly the atom that was selected when the delete action was triggered, and the user is returned to the Atom Browser screen afterward

#### Scenario: Cancelling delete
- **WHEN** the user cancels the delete prompt
- **THEN** no delete is issued to `memory.js` and the Atom Detail & Actions screen remains showing the unmodified atom

### Requirement: Primer preview subcommand
`memory.js` SHALL provide a `primer-preview <agent> <project>` subcommand that returns the exact primer text a real session for that agent and project would receive.

#### Scenario: Returns assembled primer text
- **WHEN** `primer-preview` is invoked with an agent and a project that has recorded memory
- **THEN** it prints JSON containing the primer text produced by the same assembly logic used to build a real session's primer for that agent and project

#### Scenario: Non-git project is accepted
- **WHEN** `primer-preview` is invoked with an empty-string project
- **THEN** it succeeds and returns primer text reflecting the non-project ("shared memory") case, rather than rejecting the input

#### Scenario: Unknown agent+project pair
- **WHEN** `primer-preview` is invoked with an agent+project pair that has no recorded memory
- **THEN** it succeeds and returns primer text reflecting the empty state, rather than erroring

### Requirement: Hot-state pair enumeration subcommand
`memory.js` SHALL provide a subcommand that lists every distinct agent+project pair with at least one `hot_state` row.

#### Scenario: Listing pairs
- **WHEN** the hot-state pair enumeration subcommand is invoked
- **THEN** it prints JSON listing every distinct agent+project pair that has at least one `hot_state` row, each with its session count and most recent update time, ordered by most recently updated first

#### Scenario: No pairs recorded
- **WHEN** the hot-state pair enumeration subcommand is invoked and no `hot_state` rows exist
- **THEN** it succeeds and returns an empty list rather than erroring
