# opencode-orchestrator-plugin

A TypeScript plugin that adds deterministic, role-enforced task orchestration tools to OpenCode. It enables structured task plan submission with `dependsOn` relationships, progress monitoring, and completion tracking. The plugin validates every submission for unique IDs, acyclic dependencies, and assignment to a valid agent. Work is dispatched via OpenCode's standard `task` tool, not through custom session spawning.

Each `submit_tasks` call includes an `agents` array listing the valid agent slugs for that session and an optional `orchestrator` slug. When `orchestrator` is set, that agent cannot be assigned implementation work to themselves — they must route it to another agent. Omit `orchestrator` or pass an empty `agents` array to disable role enforcement entirely.

Example configuration:

```jsonc
{
  "agents": ["alpha", "beta", "gamma"],
  "orchestrator": "alpha",
  "tasks": [
    {
      "id": "t1",
      "prompt": "Research options for X",
      "assignedAgent": "beta",
      "acceptance": ["summary written"]
    }
  ]
}
```

## Install

Add one of the following entries to the `plugin` array in `~/.config/opencode/opencode.jsonc`:

**npm registry**
```jsonc
{
  "plugin": ["@mfouesneau/opencode-orchestrator-plugin"]
}
```

**local path**
```jsonc
{
  "plugin": ["file:///absolute/path/to/opencode-orchestrator-plugin"]
}
```
Local plugins must have a built `dist/` directory.

**GitHub source**
```jsonc
{
  "plugin": ["github:mfouesneau/opencode-orchestrator-plugin"]
}
```

## Tools

Three tools are registered:

- `submit_tasks(tasks[], agents[], orchestrator?)` Validates the batch against the agent roster, enforces acyclicity, then writes the plan to markdown.
- `task_status(taskId?)` Returns the current state of the plan or a single task.
- `complete_task(taskId, result)` Marks a task done and records its output.

**Parameter notes:**
- `submit_tasks` requires `agents: string[]` (the roster of valid agent slugs) and accepts an optional `orchestrator?: string`. Pass an empty `agents` array to disable role enforcement.
- Each task object includes `assignedAgent` (agent slug), `id`, `prompt`, and optional `acceptance` array.

## State

Orchestration state is stored as human-readable markdown in `.agents-workspace/task-plan.md` at the workspace root. Plugin diagnostics write to `.agents-workspace/plugin.log`. Nothing writes to the TUI or sidebar.

## Development

Build with `tsc`. Tests run with `npm test`. This package targets `@opencode-ai/plugin@1.17.4` exactly and requires Node >= 20. The `dist/` output is gitignored; rebuild from `src/` before packing. `npm pack --dry-run` produces a 12-file tarball of roughly 13.9 kB.

MIT license.
