/**
 * OpenCode plugin that exposes three orchestration tools backed by a
 * human-readable task plan markdown file.
 *
 * The plugin is read-only with respect to dispatch: it never creates sessions
 * itself. Instead, the orchestrator agent reads the validated plan and calls
 * the standard OpenCode `task` tool to spawn subagents.
 *
 * Scope: this module is server-only. It registers server-side hooks and
 * tools; it never touches TUI slots, keymaps, dialogs, or any client-side
 * surface. Host-visible status for the user flows through the `todowrite`
 * mirror described in the tool descriptions below.
 */
import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  TASK_PLAN_RELATIVE_PATH,
  readTaskPlan,
  validateTasks,
  writeTaskPlan,
  type TaskRecord,
  type ValidationResult,
} from './task-plan.js';

export const PLUGIN_LOG_RELATIVE_PATH = '.agents-workspace/plugin.log';

export const TASK_PLAN_ABS_PATH = (worktree: string) =>
  path.join(worktree, TASK_PLAN_RELATIVE_PATH);

function appendPluginLog(worktree: string, line: string): void {
  try {
    mkdirSync(path.join(worktree, '.agents-workspace'), { recursive: true });
    appendFileSync(
      path.join(worktree, PLUGIN_LOG_RELATIVE_PATH),
      line + '\n',
      'utf-8',
    );
  } catch {
    // Diagnostics never break the host.
  }
}

function resolveWorktree(pluginInput: { worktree?: string; directory?: string }): string {
  const wt = pluginInput.worktree;
  if (typeof wt === 'string' && wt && wt !== '/') return wt;
  const dir = pluginInput.directory;
  if (typeof dir === 'string' && dir && dir !== '/') return dir;
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Tool handlers — exported under `__testing__` to allow direct invocation
// in unit tests without spinning up the full OpenCode hook harness.
// ---------------------------------------------------------------------------

export const __testing__ = {
  submitTasks,
  completeTask,
  taskStatus,
};

async function submitTasks(
  worktree: string,
  rawTasks: TaskRecord[],
  submittingAgent: string = '',
): Promise<ValidationResult & { plan?: TaskRecord[] }> {
  // Normalize legacy/optional fields.
  const tasks: TaskRecord[] = rawTasks.map((t) => ({
    id: t.id,
    prompt: t.prompt ?? '',
    assignedAgent: (t.assignedAgent ?? '').toLowerCase(),
    dependsOn: t.dependsOn ?? [],
    acceptance: t.acceptance ?? [],
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    status: t.status ?? 'pending',
  }));

  const existing = readTaskPlan(worktree);
  const validation = validateTasks(tasks, existing, submittingAgent);
  if (!validation.ok) {
    return { ...validation };
  }

  const merged: TaskRecord[] = [...existing, ...tasks];
  writeTaskPlan(worktree, merged);
  return { ok: true, plan: merged };
}

async function completeTask(
  worktree: string,
  taskId: string,
  result: string,
): Promise<ValidationResult & { task?: TaskRecord }> {
  const tasks = readTaskPlan(worktree);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return { ok: false, errors: [`task "${taskId}" not found in plan`] };
  }
  tasks[idx] = { ...tasks[idx], status: 'done', result };
  writeTaskPlan(worktree, tasks);
  return { ok: true, task: tasks[idx] };
}

async function taskStatus(worktree: string): Promise<string> {
  const tasks = readTaskPlan(worktree);
  if (tasks.length === 0) {
    return '| id | agent | status | dependsOn |\n|----|-------|--------|-----------|\n| _(no tasks)_ | | | |\n';
  }
  const header = '| id | agent | status | dependsOn |';
  const sep = '|----|-------|--------|-----------|';
  const rows = tasks.map(
    (t) =>
      `| ${t.id} | ${t.assignedAgent} | ${t.status ?? 'pending'} | ${(t.dependsOn ?? []).join(', ')} |`,
  );
  return [header, sep, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const plugin: Plugin = async (pluginInput) => {
  const worktree = resolveWorktree(pluginInput);

  // Startup banner — server-side diagnostic record. Writes only to
  // .agents-workspace/plugin.log (never to stdout) so the host's TUI is not
  // polluted. Status for the user is provided through the host todowrite
  // mirror documented on submit_tasks / complete_task below.
  appendPluginLog(
    worktree,
    `[plugin.ts] orchestrator plugin loading: ts=${new Date().toISOString()} worktree=${worktree} state_path=${TASK_PLAN_RELATIVE_PATH} tools=[submit_tasks,task_status,complete_task]`,
  );

  return {
    tool: {
      submit_tasks: tool({
        description:
          'Submit one or more tasks to the orchestrator plan. Validates tasks (unique ids, known agents, acyclic deps), merges them into .agents-workspace/task-plan.md, and returns the updated plan. Grace cannot submit implementation work targeted at herself — route that to a specialist agent. UI MIRROR REQUIRED: after this call returns ok:true, Grace MUST also call the host `todowrite` tool with one entry per submitted task so the user sees them populate in the TUI immediately. Map each task to {content: task.prompt, priority: "high", status: "pending"} (content should be a short summary of the task, not the full prompt — the user is reading a board, not a transcript). Then continue to dispatch ready tasks. Never call todowrite before submit_tasks returns ok:true (validation may reject the batch).',
        args: {
          tasks: tool.schema
            .array(
              tool.schema.object({
                id: tool.schema.string().describe('Unique task ID'),
                prompt: tool.schema.string().describe('What the agent should do'),
                assignedAgent: tool.schema.string().describe('Agent slug (grace, jarvis, leonardo, oracle, hypatia, maestro, robert, generalist)'),
                dependsOn: tool.schema.array(tool.schema.string()).optional().describe('IDs of tasks that must complete first'),
                acceptance: tool.schema.array(tool.schema.string()).optional().describe('Done criteria'),
              }),
            )
            .describe('List of tasks to add to the plan'),
          submittingAgent: tool.schema.string().optional().describe('The slug of the agent submitting these tasks (used to enforce orchestrator-only role for grace). Defaults to empty string.'),
        },
        async execute(args, _ctx) {
          const result = await submitTasks(worktree, args.tasks as TaskRecord[], args.submittingAgent ?? '');
          if (!result.ok) {
            return `submit_tasks rejected:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`;
          }
          return `submit_tasks accepted ${args.tasks.length} task(s). Plan written to ${path.join(worktree, TASK_PLAN_RELATIVE_PATH)}.`;
        },
      }),
      task_status: tool({
        description:
          'Render the current task plan as a markdown table. Returns id, agent, status, dependsOn columns for every task.',
        args: {
          taskId: tool.schema.string().optional().describe('Optional task id to inspect in detail; if omitted, lists all tasks.'),
        },
        async execute(_args, _ctx) {
          return await taskStatus(worktree);
        },
      }),
      complete_task: tool({
        description:
          'Mark a task in the plan as done and persist its result. Returns an error if the task id is not in the plan. UI MIRROR REQUIRED: after this call returns ok:true, Grace MUST also call the host `todowrite` tool to update the corresponding entry — set its status to "completed" (or "in_progress" while the subagent is still wrapping up). Keeping the TUI in sync with plan state is the user\'s only signal that work is actually moving.',
        args: {
          taskId: tool.schema.string().describe('ID of the task to mark complete'),
          result: tool.schema.string().describe('Result text to persist with the task'),
        },
        async execute(args, _ctx) {
          const completion = await completeTask(worktree, args.taskId, args.result);
          if (!completion.ok) {
            return `complete_task failed:\n${completion.errors.map((e) => `  - ${e}`).join('\n')}`;
          }
          return `Task "${args.taskId}" marked done.`;
        },
      }),
    },
    "chat.message": async () => {
      // Read-only hook: no orchestrator state lives here anymore.
    },
    "tool.execute.before": async () => {
      // Read-only hook; no console output, no state mutation. Logs to .agents-workspace/plugin.log on demand only.
    },
    "tool.execute.after": async () => {
      // Read-only.
    },
    "shell.env": async () => {
      // Reserved for environment contract validation.
    },
    "tool.definition": async () => {
      // Reserved for dynamic tool definition injection.
    },
    dispose: async () => {
      // Plan file is durable; nothing to clean up.
    },
  } satisfies Hooks;
};

export default plugin;
