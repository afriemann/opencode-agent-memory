// test/setup-react-act-environment.js
//
// React 19 gates `act()`-wrapped renders behind this flag; without it, every
// state update triggered inside an act() block (e.g. via Ink's useInput
// handlers in tests) logs a spurious "not configured to support act" warning.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
