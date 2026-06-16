/**
 * Task plan: a markdown-backed DAG of work items stored at
 * `.agents-workspace/task-plan.md`. The file is human-readable, conflict-free
 * for single-writer use, and serves as the single source of truth — no JSON
 * state machine, no in-memory cache.
 *
 * The plugin validates incoming tasks and appends/updates them in the plan.
 * Dispatching, execution, and lifecycle events happen via the standard OpenCode
 * `task` subagent tool, not in this module.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskRecord {
  id: string;
  prompt: string;
  assignedAgent: string;
  dependsOn?: string[];
  acceptance?: string[];
  createdAt: number;
  status?: 'pending' | 'dispatched' | 'running' | 'done' | 'failed';
  result?: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export const KNOWN_AGENTS = [
  'grace',
  'jarvis',
  'leonardo',
  'oracle',
  'hypatia',
  'maestro',
  'robert',
  'generalist',
] as const;

export const TASK_PLAN_RELATIVE_PATH = join('.agents-workspace', 'task-plan.md');

/**
 * Read the task plan from `<worktree>/<TASK_PLAN_RELATIVE_PATH>`.
 * Returns an empty array if the file is missing or unparseable.
 */
export function readTaskPlan(worktree: string): TaskRecord[] {
  const path = join(worktree, TASK_PLAN_RELATIVE_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return parseTaskPlanMarkdown(raw);
}

/**
 * Render the task plan as markdown and write it to disk.
 * Creates `.agents-workspace/` if it does not exist.
 */
export function writeTaskPlan(worktree: string, tasks: TaskRecord[]): void {
  const path = join(worktree, TASK_PLAN_RELATIVE_PATH);
  mkdirSync(join(worktree, '.agents-workspace'), { recursive: true });
  writeFileSync(path, renderTaskPlanMarkdown(tasks), 'utf-8');
}

/**
 * Validate a batch of new tasks against the existing plan.
 *
 * Checks:
 *  - All IDs unique within the batch and not already in the existing plan.
 *  - All `assignedAgent` values are known (case-insensitive).
 *  - All `dependsOn` IDs resolve to either the batch or the existing plan.
 *  - No cycles in the dependency graph (DFS over the merged set).
 *  - Grace (the orchestrator) cannot submit implementation work targeted at
 *    herself — she routes implementation to a specialist agent instead.
 */
export function validateTasks(
  tasks: TaskRecord[],
  existing: TaskRecord[],
  submittingAgent: string = '',
): ValidationResult {
  const errors: string[] = [];

  if (tasks.length === 0) {
    return { ok: true };
  }

  // Normalize agent name to lowercase for comparison; store the original for error msgs.
  const knownLower = new Set(KNOWN_AGENTS.map((a) => a.toLowerCase()));

  // Index existing by id for O(1) lookup
  const existingById = new Map<string, TaskRecord>();
  for (const t of existing) {
    existingById.set(t.id, t);
  }

  // 1. Duplicate IDs within batch
  const seenIds = new Set<string>();
  for (const t of tasks) {
    if (!t.id || typeof t.id !== 'string') {
      errors.push(`task has missing or invalid id: ${JSON.stringify(t)}`);
      continue;
    }
    if (seenIds.has(t.id)) {
      errors.push(`task id "${t.id}" appears more than once in batch (duplicate ids)`);
    }
    if (existingById.has(t.id)) {
      errors.push(`task id "${t.id}" already exists in the task plan`);
    }
    seenIds.add(t.id);
  }

  // 2. Agent valid + grace orchestrator constraint
  for (const t of tasks) {
    const agent = (t.assignedAgent ?? '').toLowerCase();
    if (!agent) {
      errors.push(`task "${t.id}" has empty assignedAgent`);
      continue;
    }
    if (!knownLower.has(agent)) {
      errors.push(
        `task "${t.id}" has unknown agent "${t.assignedAgent}" (must be one of: ${KNOWN_AGENTS.join(', ')})`,
      );
    }
    if (
      submittingAgent.toLowerCase() === 'grace' &&
      agent === 'grace' &&
      looksLikeImplementation(t.prompt)
    ) {
      errors.push(
        `task "${t.id}" cannot be submitted: Grace is an orchestrator and must not do implementation work. ` +
          `Route this prompt to a specialist agent (e.g. jarvis, oracle, hypatia) and re-submit.`,
      );
    }
  }

  // 3. dependsOn references resolve
  const batchIds = new Set(tasks.map((t) => t.id).filter(Boolean));
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!batchIds.has(dep) && !existingById.has(dep)) {
        errors.push(
          `task "${t.id}" depends on unknown id "${dep}" (must be in batch or in existing plan)`,
        );
      }
    }
  }

  // 4. Cycle detection on the merged effective graph
  if (errors.length === 0) {
    const merged: TaskRecord[] = [...existing, ...tasks.filter((t) => t.id)];
    if (hasCycle(merged)) {
      errors.push('dependency cycle detected in tasks (a task transitively depends on itself)');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

/**
 * Detect a cycle in the dependency graph by DFS with white/gray/black coloring.
 */
function hasCycle(tasks: TaskRecord[]): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  const deps = new Map<string, string[]>();
  for (const t of tasks) deps.set(t.id, t.dependsOn ?? []);

  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    for (const dep of deps.get(id) ?? []) {
      if (!color.has(dep)) continue; // unknown deps caught elsewhere
      const c = color.get(dep);
      if (c === GRAY) return true; // back-edge → cycle
      if (c === WHITE && visit(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const t of tasks) {
    if (color.get(t.id) === WHITE && visit(t.id)) return true;
  }
  return false;
}

/**
 * Heuristic: does this prompt look like implementation work (code to be written)?
 * Anchored at the start of the prompt to avoid false positives like "code review".
 */
const IMPLEMENTATION_REGEX = /^\s*(implement|write\s+(?:the\s+)?code|code\s+(?:this|it|up|the)|develop|build\s+(?:a|the|this))\b/i;

function looksLikeImplementation(prompt: string): boolean {
  if (typeof prompt !== 'string') return false;
  return IMPLEMENTATION_REGEX.test(prompt);
}

// ---------------------------------------------------------------------------
// Markdown rendering and parsing
// ---------------------------------------------------------------------------

/**
 * Render the task plan as a structured markdown document.
 *
 * Format (simple, parseable, human-readable):
 *   # Task Plan
 *
 *   ## Task: <id>
 *   Agent: <agent>
 *   Status: <status>
 *   Created: <epoch ms>
 *   DependsOn: <id1>, <id2>
 *   Acceptance:
 *     - <criterion 1>
 *     - <criterion 2>
 *   Result: <result string, if any>
 *
 *   <prompt, multi-line preserved as a blockquote-style indented block>
 */
export function renderTaskPlanMarkdown(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return '';
  }

  const lines: string[] = ['# Task Plan', ''];
  for (const t of tasks) {
    lines.push(`## Task: ${t.id}`);
    lines.push('');
    lines.push(`- Agent: ${t.assignedAgent}`);
    if (t.status !== undefined) {
      lines.push(`- Status: ${t.status}`);
    }
    lines.push(`- Created: ${t.createdAt}`);
    if (t.dependsOn && t.dependsOn.length > 0) {
      lines.push(`- DependsOn: ${t.dependsOn.join(', ')}`);
    }
    if (t.acceptance && t.acceptance.length > 0) {
      lines.push('- Acceptance:');
      for (const a of t.acceptance) {
        lines.push(`    - ${a}`);
      }
    }
    if (t.result !== undefined) {
      lines.push(`- Result: ${t.result}`);
    }
    lines.push('');
    lines.push('### Prompt');
    lines.push('');
    // Indent prompt body so it stands out and survives parser as a single block.
    for (const line of (t.prompt ?? '').split('\n')) {
      lines.push('> ' + line);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Parse a markdown task plan document back into TaskRecord[].
 * Tolerant of missing fields; missing id = skip the entry.
 */
export function parseTaskPlanMarkdown(md: string): TaskRecord[] {
  if (!md || typeof md !== 'string') return [];
  const tasks: TaskRecord[] = [];

  // Split on `## Task:` headings.
  const blocks = md.split(/^##\s+Task:\s+/m);
  // blocks[0] is everything before the first heading; skip it.
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const lines = block.split('\n');
    const id = lines[0].trim();
    if (!id) continue;

    const record: TaskRecord = {
      id,
      prompt: '',
      assignedAgent: '',
      createdAt: 0,
    };

    let inAcceptance = false;
    let inPrompt = false;
    const promptLines: string[] = [];

    for (let li = 1; li < lines.length; li++) {
      const raw = lines[li];
      const line = raw.trimEnd();

      if (line.startsWith('### Prompt')) {
        inPrompt = true;
        inAcceptance = false;
        continue;
      }

      if (inPrompt) {
        // Stop at the section separator.
        if (line.startsWith('---')) {
          inPrompt = false;
          continue;
        }
        // Lines inside the Prompt section start with "> " or are blank.
        if (line.startsWith('> ')) {
          promptLines.push(line.slice(2));
        } else if (line === '>') {
          promptLines.push('');
        } else if (line === '') {
          // Skip — blank lines between header and prompt don't contribute.
          // But if we've started collecting, allow leading/trailing blanks.
          if (promptLines.length > 0 && promptLines[promptLines.length - 1] !== '') {
            promptLines.push('');
          }
        } else if (line.startsWith('- ') || line.startsWith('## ') || line.startsWith('# ')) {
          // We've left the prompt block unexpectedly.
          inPrompt = false;
          // Fall through to other field parsing by re-processing this line.
          // (But re-processing risks double-increment; just handle the common case.)
        }
        continue;
      }

      if (inAcceptance) {
        if (line.startsWith('    - ') || line.startsWith('  - ') || line.startsWith('- ')) {
          const cleaned = line.replace(/^\s*-\s+/, '');
          if (!record.acceptance) record.acceptance = [];
          record.acceptance.push(cleaned);
          continue;
        } else {
          inAcceptance = false;
        }
      }

      if (line.startsWith('- Agent:')) {
        record.assignedAgent = line.slice('- Agent:'.length).trim();
      } else if (line.startsWith('- Status:')) {
        const s = line.slice('- Status:'.length).trim() as TaskRecord['status'];
        if (s) record.status = s;
      } else if (line.startsWith('- Created:')) {
        record.createdAt = Number(line.slice('- Created:'.length).trim()) || 0;
      } else if (line.startsWith('- DependsOn:')) {
        const raw = line.slice('- DependsOn:'.length).trim();
        if (raw) record.dependsOn = raw.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (line.startsWith('- Acceptance:')) {
        inAcceptance = true;
      } else if (line.startsWith('- Result:')) {
        record.result = line.slice('- Result:'.length).trim();
      }
    }

    record.prompt = promptLines.join('\n').trim();

    // Skip entries that lack essential fields.
    if (record.assignedAgent && record.id) {
      tasks.push(record);
    }
  }

  return tasks;
}
