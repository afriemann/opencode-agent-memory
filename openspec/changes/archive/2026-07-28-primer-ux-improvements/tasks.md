## 1. Fix session label fallback ("unknown" → relative time)

- [x] 1.1 Update label derivation in `assemblePrimer` / `signal-utils.js` to use `formatRelativeTime(row.updated_at)` when both `session_name` and `session_id` are absent or empty, instead of `'unknown'`
- [x] 1.2 Add failing test: session label falls back to relative time when both name and id are absent
- [x] 1.3 Verify existing session-thread tests still pass

## 2. Fix staleness description

- [x] 2.1 Update `renderStaleness` in `git-helper.js`: return `"not yet anchored to a commit"` for `no-anchor` status
- [x] 2.2 Update `renderStaleness`: return a sentinel (e.g. `null`) for `no-git` status
- [x] 2.3 Update `assemblePrimer` in `signal-utils.js` to omit the `Staleness:` line when `renderStaleness` returns `null` (no-git case)
- [x] 2.4 Add failing test: staleness line omitted for no-git status
- [x] 2.5 Add failing test: staleness line uses "not yet anchored to a commit" for no-anchor status
- [x] 2.6 Verify existing staleness tests still pass

## 3. Cross-project activity section

- [x] 3.1 Add a `readTodayOtherProjects(agent, project, db)` helper (or equivalent) in `memory.js` that queries `hot_state` for rows where `project != currentProject` and `updated_at >= now - 24h`, returning `{ project, agent, updated_at }`
- [x] 3.2 Plumb the result into `assemblePrimer` via the options object (add `otherProjects` field)
- [x] 3.3 Implement `renderActiveProjectsToday(otherProjects, home)` in `signal-utils.js` that formats the `### Active projects today` section (relative path from `$HOME`, agent, relative time), returning `null` when the list is empty
- [x] 3.4 Insert the section into the primer output immediately after `### Recent sessions` (or before the atoms directory when sessions are absent)
- [x] 3.5 Pass `otherProjects` data from the `read` operation in `plugin.js` through to `assemblePrimer`
- [x] 3.6 Add failing test: active projects today section appears when other projects were recently worked on
- [x] 3.7 Add failing test: section is omitted when no other projects were active today
- [x] 3.8 Add failing test: section is omitted when other projects were active more than 24 hours ago

## 4. Verify and clean up

- [x] 4.1 Run full test suite (`npm test`) — all tests green
- [x] 4.2 Fix any lint errors
