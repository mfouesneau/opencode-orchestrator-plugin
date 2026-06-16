/**
 * Tests for the task plan module and plugin tools.
 *
 * Covers:
 *   T1 – Validation: well-formed task accepted
 *   T2 – Validation: duplicate IDs rejected
 *   T3 – Validation: unknown agent rejected (case-insensitive)
 *   T4 – Validation: unknown dep rejected
 *   T5 – Validation: circular deps rejected (self + transitive)
 *   T6 – Validation: grace submitting implementation task rejected
 *   T7 – File round-trip: read <-> write
 *   T8 – Markdown parser round-trips through renderer
 *
 * Runner: npx tsx --test
 * Assertions: node:assert/strict
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readTaskPlan,
  writeTaskPlan,
  validateTasks,
  parseTaskPlanMarkdown,
  renderTaskPlanMarkdown,
  TASK_PLAN_RELATIVE_PATH,
  KNOWN_AGENTS,
  type TaskRecord,
} from '../../src/task-plan.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: `Prompt for task ${id}`,
    assignedAgent: 'jarvis',
    createdAt: 1_000_000,
    ...overrides,
  };
}

function freshWorktree(): string {
  return mkdtempSync(join(tmpdir(), 'task-plan-test-'));
}

function cleanup(worktree: string): void {
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// T1–T6: validateTasks
// ---------------------------------------------------------------------------

describe('validateTasks', () => {
  test('T1: well-formed task is accepted', () => {
    const result = validateTasks([makeTask('a')], []);
    assert.deepEqual(result, { ok: true }, 'a valid task must yield ok:true');
  });

  test('T1b: multiple well-formed tasks with deps against existing plan are accepted', () => {
    const existing = [makeTask('a'), makeTask('b', { dependsOn: ['a'] })];
    const result = validateTasks(
      [makeTask('c', { dependsOn: ['b'] }), makeTask('d')],
      existing,
    );
    assert.deepEqual(result, { ok: true });
  });

  test('T2: duplicate IDs within the new batch are rejected', () => {
    const result = validateTasks(
      [makeTask('dup'), makeTask('dup', { assignedAgent: 'oracle' })],
      [],
    );
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.includes('dup') && e.includes('duplicate')),
        `errors must mention duplicate id; got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  test('T2b: ID colliding with existing plan is rejected', () => {
    const existing = [makeTask('existing-id')];
    const result = validateTasks([makeTask('existing-id')], existing);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes('existing-id')));
    }
  });

  test('T3: unknown assignedAgent is rejected', () => {
    const result = validateTasks([makeTask('a', { assignedAgent: 'nobody' })], []);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.includes('nobody') && e.includes('agent')),
        `errors must mention unknown agent; got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  test('T3b: agent validation is case-insensitive', () => {
    const result = validateTasks([makeTask('a', { assignedAgent: 'JARVIS' })], []);
    assert.deepEqual(result, { ok: true }, 'JARVIS must be normalized to jarvis');
  });

  test('T3c: empty assignedAgent is rejected', () => {
    const result = validateTasks([makeTask('a', { assignedAgent: '' })], []);
    assert.strictEqual(result.ok, false);
  });

  test('T4: dependsOn referencing an unknown ID (not in batch nor in existing plan) is rejected', () => {
    const result = validateTasks([makeTask('a', { dependsOn: ['ghost'] })], []);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes('ghost')));
    }
  });

  test('T4b: dependsOn referencing an existing-plan task is accepted', () => {
    const existing = [makeTask('parent')];
    const result = validateTasks([makeTask('child', { dependsOn: ['parent'] })], existing);
    assert.deepEqual(result, { ok: true });
  });

  test('T5a: self-dependency is detected as a cycle', () => {
    const result = validateTasks([makeTask('a', { dependsOn: ['a'] })], []);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.toLowerCase().includes('cycle')),
        `errors must mention cycle; got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  test('T5b: transitive cycle (a -> b -> c -> a within single batch) is detected', () => {
    const result = validateTasks(
      [
        makeTask('a', { dependsOn: ['c'] }),
        makeTask('b', { dependsOn: ['a'] }),
        makeTask('c', { dependsOn: ['b'] }),
      ],
      [],
    );
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.toLowerCase().includes('cycle')));
    }
  });

  test('T5c: merging a new batch does not introduce cycles if none exist within the batch', () => {
    // Existing tasks are immutable w.r.t. their deps, so a *new* batch can only
    // form a cycle via edges within itself. As long as the new batch is acyclic,
    // merging with any existing plan is also acyclic.
    const existing = [makeTask('p'), makeTask('q', { dependsOn: ['p'] })];
    const result = validateTasks(
      [makeTask('r', { dependsOn: ['q'] }), makeTask('s', { dependsOn: ['q', 'r'] })],
      existing,
    );
    assert.deepEqual(result, { ok: true });
  });

  test('T6a: grace submitting an "implement X" task assigned to grace is rejected', () => {
    const result = validateTasks(
      [makeTask('a', { assignedAgent: 'grace', prompt: 'Implement the auth module' })],
      [],
      'grace',
    );
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.toLowerCase().includes('orchestrator')),
        `errors must reference orchestrator role; got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  test('T6b: grace submitting a non-implementation prompt assigned to grace is allowed', () => {
    const result = validateTasks(
      [makeTask('a', { assignedAgent: 'grace', prompt: 'Plan the rollout sequence' })],
      [],
      'grace',
    );
    assert.deepEqual(result, { ok: true }, 'grace is allowed to plan/dispatch when not implementing');
  });

  test('T6c: grace submitting implementation prompt targeted at jarvis is allowed', () => {
    const result = validateTasks(
      [makeTask('a', { assignedAgent: 'jarvis', prompt: 'Implement the auth module' })],
      [],
      'grace',
    );
    assert.deepEqual(result, { ok: true }, 'grace may route implementation work to other agents');
  });

  test('T6d: non-grace submitter is not subject to orchestrator-role check', () => {
    const result = validateTasks(
      [makeTask('a', { assignedAgent: 'grace', prompt: 'Implement the auth module' })],
      [],
      'jarvis',
    );
    // The orchestrator-role check only fires when submittingAgent === 'grace'.
    // Grace-as-target is always legal; we only forbid grace-as-implementer.
    assert.deepEqual(result, { ok: true });
  });

  test('KNOWN_AGENTS contains all expected agents', () => {
    for (const expected of ['grace', 'jarvis', 'leonardo', 'oracle', 'hypatia', 'maestro', 'robert', 'generalist']) {
      assert.ok(KNOWN_AGENTS.includes(expected as typeof KNOWN_AGENTS[number]));
    }
  });
});

// ---------------------------------------------------------------------------
// T7: round-trip read <-> write
// ---------------------------------------------------------------------------

describe('readTaskPlan / writeTaskPlan', () => {
  test('T7a: write empty task list, read back yields empty list', () => {
    const worktree = freshWorktree();
    try {
      writeTaskPlan(worktree, []);
      assert.ok(existsSync(join(worktree, TASK_PLAN_RELATIVE_PATH)));
      const read = readTaskPlan(worktree);
      assert.deepEqual(read, []);
    } finally {
      cleanup(worktree);
    }
  });

  test('T7b: write tasks, read back yields identical tasks', () => {
    const worktree = freshWorktree();
    try {
      const tasks: TaskRecord[] = [
        makeTask('a'),
        makeTask('b', { dependsOn: ['a'], prompt: 'follow up', assignedAgent: 'oracle' }),
        makeTask('c', { assignedAgent: 'hypatia', acceptance: ['criterion 1', 'criterion 2'] }),
      ];
      writeTaskPlan(worktree, tasks);
      const read = readTaskPlan(worktree);
      assert.deepEqual(read, tasks);
    } finally {
      cleanup(worktree);
    }
  });

  test('T7c: readTaskPlan on a missing file returns []', () => {
    const worktree = freshWorktree();
    try {
      const read = readTaskPlan(worktree);
      assert.deepEqual(read, []);
    } finally {
      cleanup(worktree);
    }
  });

  test('T7d: write creates the directory if missing', () => {
    const worktree = freshWorktree();
    try {
      // .agents-workspace doesn't exist yet
      assert.ok(!existsSync(join(worktree, '.agents-workspace')));
      writeTaskPlan(worktree, [makeTask('a')]);
      assert.ok(existsSync(join(worktree, TASK_PLAN_RELATIVE_PATH)));
    } finally {
      cleanup(worktree);
    }
  });
});

// ---------------------------------------------------------------------------
// T8: markdown round-trip
// ---------------------------------------------------------------------------

describe('parseTaskPlanMarkdown / renderTaskPlanMarkdown', () => {
  test('T8a: render an empty list', () => {
    const md = renderTaskPlanMarkdown([]);
    assert.strictEqual(md.trim(), '');
  });

  test('T8b: render then parse round-trips through the markdown format', () => {
    const tasks: TaskRecord[] = [
      makeTask('alpha', { assignedAgent: 'jarvis', prompt: 'do alpha', acceptance: ['done'] }),
      makeTask('beta', {
        assignedAgent: 'oracle',
        prompt: 'do beta',
        dependsOn: ['alpha'],
        status: 'pending',
      }),
      makeTask('gamma', {
        assignedAgent: 'leonardo',
        prompt: 'do gamma',
        status: 'done',
        result: 'all good',
      }),
    ];
    const md = renderTaskPlanMarkdown(tasks);
    // The markdown file must contain the task IDs and agent names
    assert.ok(md.includes('alpha'));
    assert.ok(md.includes('beta'));
    assert.ok(md.includes('gamma'));
    assert.ok(md.includes('jarvis'));
    assert.ok(md.includes('oracle'));
    assert.ok(md.includes('leonardo'));
    assert.ok(md.includes('do gamma'));

    const parsed = parseTaskPlanMarkdown(md);
    assert.deepEqual(parsed, tasks, 'parse(render(t)) must equal t');
  });

  test('T8c: parse handles a minimal manually-written entry', () => {
    const md = [
      '# Task Plan',
      '',
      '## Task: solo',
      '',
      '- Agent: jarvis',
      '- Status: pending',
      '- Created: 1700000000000',
      '',
      '### Prompt',
      '',
      '> Just do it.',
      '',
      '---',
      '',
    ].join('\n');
    const parsed = parseTaskPlanMarkdown(md);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'solo');
    assert.strictEqual(parsed[0].assignedAgent, 'jarvis');
    assert.strictEqual(parsed[0].status, 'pending');
    assert.strictEqual(parsed[0].createdAt, 1700000000000);
    assert.strictEqual(parsed[0].prompt, 'Just do it.');
  });

  test('T8d: parse preserves dependsOn arrays', () => {
    const md = [
      '## Task: child',
      '',
      '- Agent: jarvis',
      '- Status: pending',
      '- Created: 1700000000000',
      '- DependsOn: parent, grandparent',
      '',
      '### Prompt',
      '',
      '> follow-up',
      '',
      '---',
      '',
    ].join('\n');
    const parsed = parseTaskPlanMarkdown(md);
    assert.strictEqual(parsed.length, 1);
    assert.deepEqual(parsed[0].dependsOn, ['parent', 'grandparent']);
  });

  test('T8e: parse tolerates a corrupt-but-non-empty file by returning []', () => {
    const parsed = parseTaskPlanMarkdown('# not a task plan\nrandom content\n');
    assert.deepEqual(parsed, []);
  });
});

// Integration: end-to-end file round-trip through markdown
describe('end-to-end: writeTaskPlan persists markdown that parseTaskPlanMarkdown can read back', () => {
  test('writes a markdown file that another consumer can parse', () => {
    const worktree = freshWorktree();
    try {
      const tasks: TaskRecord[] = [
        makeTask('first', { status: 'done', result: 'complete' }),
        makeTask('second', { dependsOn: ['first'], status: 'running' }),
      ];
      writeTaskPlan(worktree, tasks);
      const raw = readFileSync(join(worktree, TASK_PLAN_RELATIVE_PATH), 'utf-8');
      const parsed = parseTaskPlanMarkdown(raw);
      assert.deepEqual(parsed, tasks);
    } finally {
      cleanup(worktree);
    }
  });
});

// Plugin-level smoke: submit_tasks rejects when invalid
describe('plugin submit_tasks rejects invalid input', () => {
  // We import the plugin module-side handler directly so we don't have to spin up
  // the full OpenCode hook harness. The plugin exports a small handler API for tests.
  test('returns errors when t-batch contains unknown agent', async () => {
    const { __testing__ } = await import('../../src/plugin.js');
    const worktree = freshWorktree();
    try {
      const result = await __testing__.submitTasks(worktree, [
        makeTask('a', { assignedAgent: 'no-such-agent' }),
      ]);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.errors.length > 0);
      }
    } finally {
      cleanup(worktree);
    }
  });

  test('returns ok and persists tasks when valid', async () => {
    const { __testing__ } = await import('../../src/plugin.js');
    const worktree = freshWorktree();
    try {
      const result = await __testing__.submitTasks(worktree, [makeTask('a')]);
      assert.strictEqual(result.ok, true);
      const persisted = readTaskPlan(worktree);
      // submit_tasks normalizes default fields (status: 'pending', lowercase agent)
      assert.strictEqual(persisted.length, 1);
      assert.strictEqual(persisted[0].id, 'a');
      assert.strictEqual(persisted[0].status, 'pending');
      assert.strictEqual(persisted[0].assignedAgent, 'jarvis');
    } finally {
      cleanup(worktree);
    }
  });

  test('completeTask marks a task done and persists the result', async () => {
    const { __testing__ } = await import('../../src/plugin.js');
    const worktree = freshWorktree();
    try {
      await __testing__.submitTasks(worktree, [makeTask('a')]);
      const result = await __testing__.completeTask(worktree, 'a', 'all done');
      assert.strictEqual(result.ok, true);
      const persisted = readTaskPlan(worktree);
      assert.strictEqual(persisted[0].status, 'done');
      assert.strictEqual(persisted[0].result, 'all done');
    } finally {
      cleanup(worktree);
    }
  });

  test('taskStatus returns a markdown table', async () => {
    const { __testing__ } = await import('../../src/plugin.js');
    const worktree = freshWorktree();
    try {
      await __testing__.submitTasks(worktree, [makeTask('a'), makeTask('b')]);
      const md = await __testing__.taskStatus(worktree);
      assert.ok(typeof md === 'string');
      assert.ok(md.includes('|'));
      assert.ok(md.includes('a'));
      assert.ok(md.includes('b'));
      assert.ok(md.includes('jarvis'));
    } finally {
      cleanup(worktree);
    }
  });
});

// Tool description contract: the host's `todowrite` mirror instruction must be
// present on submit_tasks and complete_task so the orchestrator agent surfaces
// dispatched work in the TUI immediately.
describe('plugin tool descriptions drive host todowrite mirror', () => {
  async function buildHooks(worktree: string) {
    const { plugin } = await import('../../src/plugin.js');
    // Minimal PluginInput stub — buildTools only needs `worktree`/`directory`.
    const hooks = await (plugin as unknown as (input: {
      worktree: string;
      directory: string;
      project: unknown;
      client: unknown;
      $?: unknown;
      experimental_workspace?: unknown;
      serverUrl?: URL;
    }) => Promise<{ tool: Record<string, { description: string }> }>)({
      worktree,
      directory: worktree,
      project: {},
      client: {},
      $: {} as never,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost'),
    });
    return hooks;
  }

  test('submit_tasks description instructs the agent to mirror via host todowrite', async () => {
    const worktree = freshWorktree();
    try {
      const hooks = await buildHooks(worktree);
      const desc = hooks.tool.submit_tasks.description;
      assert.ok(typeof desc === 'string' && desc.length > 0, 'submit_tasks must carry a description');
      assert.ok(/todowrite/i.test(desc), 'description must reference the host todowrite tool');
      assert.ok(/TUI/i.test(desc) || /board/i.test(desc), 'description must explain why (TUI / board visibility)');
      assert.ok(/ok:\s*true/.test(desc), 'description must condition the mirror on submit_tasks returning ok:true');
    } finally {
      cleanup(worktree);
    }
  });

  test('complete_task description instructs the agent to update host todowrite status', async () => {
    const worktree = freshWorktree();
    try {
      const hooks = await buildHooks(worktree);
      const desc = hooks.tool.complete_task.description;
      assert.ok(typeof desc === 'string' && desc.length > 0, 'complete_task must carry a description');
      assert.ok(/todowrite/i.test(desc), 'description must reference the host todowrite tool');
      assert.ok(/completed/i.test(desc), 'description must mention the "completed" status mapping');
    } finally {
      cleanup(worktree);
    }
  });

  test('task_status description is unaffected by the mirror change', async () => {
    const worktree = freshWorktree();
    try {
      const hooks = await buildHooks(worktree);
      // task_status is read-only by design — it should not push to todowrite.
      assert.ok(typeof hooks.tool.task_status.description === 'string');
      assert.ok(!/todowrite/i.test(hooks.tool.task_status.description));
    } finally {
      cleanup(worktree);
    }
  });
});
