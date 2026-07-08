## 1. Tests (red step)

- [x] 1.1 Add `_createBodies` capture to `makeMockClient` in `test/plugin-safety.test.js`
- [x] 1.2 Write failing test: `AgentMemory` factory returns a `config` hook
- [x] 1.3 Write failing test: `config` hook registers `distiller` agent with `mode`, `hidden`, and `permission`
- [x] 1.4 Write failing test: `config` hook does not clobber existing agent entries
- [x] 1.5 Write failing test: `session.create` body contains `agent: 'distiller'` on distil

## 2. Implementation

- [x] 2.1 Add `config` hook to `src/plugin.js` returned hooks object (registers `distiller` agent with `mode: 'subagent'`, `hidden: true`, `permission: { '*': 'deny' }`)
- [x] 2.2 Add `agent: 'distiller'` to the `session.create` body at line 288 of `src/plugin.js`

## 3. Verification

- [x] 3.1 Run `npm test` — all tests pass
