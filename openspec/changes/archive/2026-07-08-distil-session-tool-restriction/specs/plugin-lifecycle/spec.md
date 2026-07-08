## ADDED Requirements

### Requirement: Plugin factory returns a config hook that registers a hidden distiller agent

The `AgentMemory` factory SHALL return an object that includes a `config` hook in addition to the existing `event` and `tool` keys. When invoked, the `config` hook SHALL add a key `distiller` to `cfg.agent` (creating the map if absent) with `mode: 'subagent'`, `hidden: true`, and `permission: 'deny'` (the scalar deny-all form). The hook SHALL use a non-destructive assignment (`??=`) so a user-defined `distiller` agent in their config is not overwritten.

#### Scenario: config hook is present on the returned hooks object
- **WHEN** the `AgentMemory` factory resolves
- **THEN** the returned object has a `config` property that is a function

#### Scenario: config hook registers the distiller agent
- **WHEN** `plugin.config({})` is called with an empty config object
- **THEN** `cfg.agent.distiller` is defined with `mode: 'subagent'`, `hidden: true`, and `permission === 'deny'`

#### Scenario: config hook does not overwrite existing agent entries
- **WHEN** `plugin.config({ agent: { engineer: { existing: true } } })` is called
- **THEN** `cfg.agent.engineer` is still `{ existing: true }` and `cfg.agent.distiller` is also present

### Requirement: Ephemeral distil session is created with the distiller agent

When the plugin creates an ephemeral distil sub-session, the `session.create` call SHALL include `agent: 'distiller'` in the request body alongside the existing `title` field.

#### Scenario: session.create body contains agent: 'distiller'
- **WHEN** a distil run is triggered (e.g. via `session.idle` or `memory_distil_force`)
- **THEN** `client.session.create` is called with a body containing `agent: 'distiller'`
