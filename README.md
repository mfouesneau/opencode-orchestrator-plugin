# opencode-orchestrator-plugin

## Goal
TypeScript OpenCode plugin that adds a deterministic orchestration layer (hybrid DAG + stall monitor) using server-side `@opencode-ai/plugin` hooks.

## Stack
- Language: TypeScript (ES2022, NodeNext modules)
- Runtime: Node.js + OpenCode plugin host (`@opencode-ai/plugin` 1.17.4)
- Dependencies: `zod` (validation), `@opencode-ai/plugin`, `@opencode-ai/sdk`
- Build: `tsc` with strict mode

## Current State / Progress
- **2026-06-14** — Plugin entry rewritten to satisfy the real `Hooks` interface from `@opencode-ai/plugin`: exports `"chat.message"`, `"tool.execute.before"`, `"tool.execute.after"`, `"shell.env"`, and `"tool.definition"` handlers directly (no synthetic `onHook` layer).
- State types now expose Zod schemas (`DispatchRequestSchema`, `PersistedStateSchema`) for request + persisted state validation.
- Orchestrator includes cycle detection on `ingestRequest` (DFS over parent edges), `DispatchRequest` validation inside `ingestRequest` (`invalid_payload` on ZodError), and atomic persistence helpers (`loadState`, `saveState`) that read JSON/Zod-validate and write via `.tmp` then rename.
- Stall/heartbeat path keeps wall-clock semantics via `Date.now()` diffs.
- `verifyDeps` now treats tasks marked invalid/dirty as unresolved and grants priority to upstream tasks via assignment ordering.

## Success Criteria
- [x] Define core responsibilities and agent roster
- [x] Draft routing logic and delegation protocol
- [x] Update `plugin.ts` export to match `Hooks` from `@opencode-ai/plugin`
- [x] Add Zod schemas for `PersistedState` and `DispatchRequest`
- [x] Add atomic persistence to orchestrator + `loadState`/`saveState`
- [x] Add `DispatchRequest` Zod validation in `ingestRequest`
- [x] Add cycle detection on ingest
- [x] Update README with current concrete state
- [ ] Implement a simple multi-agent coordination example
- [ ] Integration test against OpenCode host
