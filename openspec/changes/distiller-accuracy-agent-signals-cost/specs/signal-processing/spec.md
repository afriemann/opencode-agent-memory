## ADDED Requirements

### Requirement: agent message capture gates on finish flag
The system SHALL capture `message.updated` events for assistant-role messages only when `msgInfo.finish` is truthy (indicating the message is complete). The system SHALL NOT capture partial or in-progress assistant messages. The captured text SHALL be formed by joining the `text` fields of all `text`-type parts in the message (or `msgInfo.text` if parts are unavailable), then truncating to 400 characters from the start. The system SHALL only capture messages whose body is at least 50 characters after joining.

#### Scenario: Completed assistant message is captured
- **GIVEN** a `message.updated` event arrives for an assistant-role message with `finish` set to a non-empty string and body length >= 50 chars
- **WHEN** the event is processed
- **THEN** the truncated text is pushed to `buf.agentMessages` for that session

#### Scenario: In-progress assistant message is not captured
- **GIVEN** a `message.updated` event arrives for an assistant-role message with `finish` undefined or null
- **WHEN** the event is processed
- **THEN** no entry is added to `buf.agentMessages`

#### Scenario: Short assistant message is not captured
- **GIVEN** a `message.updated` event arrives for an assistant-role message with `finish` set but body length < 50 chars
- **WHEN** the event is processed
- **THEN** no entry is added to `buf.agentMessages`

#### Scenario: Agent message body truncated to 400 chars
- **GIVEN** a completed assistant message whose body exceeds 400 characters
- **WHEN** the event is processed
- **THEN** the stored text is exactly 400 characters, truncated from the start

### Requirement: bufferIsEmpty and makeBuffer include agentMessages
The `makeBuffer()` function SHALL initialise an `agentMessages` field (empty array) alongside `files`, `todos`, and `messages`. The `bufferIsEmpty()` function SHALL return `false` when `agentMessages` is non-empty, even if all other fields are empty. The buffer flush payload SHALL include `agentMessages` in the delta sent to `cmdAccrue`.

#### Scenario: Buffer with only agent messages is not considered empty
- **GIVEN** a buffer where `files`, `todos`, and `messages` are all empty but `agentMessages` has one entry
- **WHEN** `bufferIsEmpty` is called
- **THEN** it returns `false`

#### Scenario: Flush includes agentMessages in delta
- **GIVEN** a buffer with one agent message and no other signals
- **WHEN** the buffer is flushed
- **THEN** the delta sent to `cmdAccrue` contains the `agentMessages` array with that entry

### Requirement: reduceSignals caps agent kind independently with MAX_AGENT_SIGNALS
The `reduceSignals` function SHALL handle signals of `kind='agent'` with an independent cap of `MAX_AGENT_SIGNALS = 10`, selecting the most recent by `created_at`. The `agent` cap SHALL be applied independently of `MAX_SIGNALS_PER_KIND`. Agent signals not handled by an explicit branch SHALL NOT be silently dropped.

#### Scenario: Agent signals capped at MAX_AGENT_SIGNALS
- **GIVEN** more than 10 signals of `kind='agent'` exist
- **WHEN** `reduceSignals` is called
- **THEN** only the 10 most recent agent signals are returned

#### Scenario: Agent cap is independent of other kinds
- **GIVEN** 10 agent signals (at the cap) and 20 message signals (at the cap)
- **WHEN** `reduceSignals` is called
- **THEN** all 10 agent signals and 20 message signals are present in the output (caps applied independently)

#### Scenario: Agent signals appear as [agent] in the distiller prompt
- **GIVEN** a reduced signal set that includes one agent signal with content "I decided to use SSDT"
- **WHEN** `buildDistilPrompt` formats the signals
- **THEN** the formatted prompt contains "[agent] I decided to use SSDT"
