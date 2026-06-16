import type {
  DispatchRequest,
  Assignment,
  TaskGraph,
  StallState,
  OrchestratorState,
  OrchestratorEvent,
  OrchestratorLog,
  RetryPolicy,
  PersistedState,
} from '../state/types.js';

import { z } from 'zod';
import { DispatchRequestSchema, TaskGraphSchema, AssignmentSchema, StallStateSchema, OrchestratorLogSchema, ORCHESTRATOR_STATES, PersistedStateSchema } from '../state/types.js';
import { readFileSync, writeFileSync, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';

export type { PersistedState };

const graphToRecord = (graph: TaskGraph): PersistedState['graph'] => ({
  tasks: Object.fromEntries(graph.tasks),
  parents: Object.fromEntries(graph.parents),
  children: Object.fromEntries(graph.children),
});

const recordToGraph = (record: PersistedState['graph']): TaskGraph => ({
  tasks: new Map(Object.entries(record.tasks ?? {})),
  parents: new Map(Object.entries(record.parents ?? {})),
  children: new Map(Object.entries(record.children ?? {})),
});

export function loadState(filePath: string, defaults: Omit<PersistedState, 'version' | 'runId' | 'redirectedAt'>): PersistedState {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = PersistedStateSchema.parse(JSON.parse(raw));
    return {
      version: parsed.version,
      runId: parsed.runId,
      redirectedAt: parsed.redirectedAt,
      state: parsed.state,
      graph: recordToGraph(parsed.graph),
      assignments: new Map(Object.entries(parsed.assignments ?? {})),
      stalls: parsed.stalls,
      log: parsed.log,
      failedSiblings: parsed.failedSiblings,
      cycleDetected: parsed.cycleDetected,
    };
  } catch {
    return {
      version: 1,
      runId: defaults.runId,
      redirectedAt: Date.now(),
      state: 'idle',
      graph: graphToRecord(defaults.graph),
      assignments: Object.fromEntries(defaults.assignments),
      stalls: defaults.stalls,
      log: defaults.log,
      failedSiblings: {},
    };
  }
}

export async function saveState(filePath: string, state: PersistedState): Promise<void> {
  const payload = {
    ...state,
    graph: graphToRecord(state.graph),
    assignments: Object.fromEntries(state.assignments),
  };
  const tmpFile = join(tmpdir(), `state.${process.getuid() ?? process.pid}.${Date.now()}.tmp`);
  await writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf-8');
  await rename(tmpFile, filePath);
}

export async function removeState(filePath: string): Promise<void> {
  try { await rm(filePath); } catch {}
}

const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  backoffMs: 2_000,
  jitterRatio: 0.25,
  timeoutMs: 30 * 60 * 1_000,
};

export class Orchestrator {
  private runId: string;
  private state: OrchestratorState = 'idle';
  private graph: TaskGraph = {
    tasks: new Map<string, DispatchRequest>(),
    parents: new Map<string, string[]>(),
    children: new Map<string, string[]>(),
  };
  private assignments: Map<string, Assignment> = new Map();
  private stalls: Map<string, StallState> = new Map();
  private retryPolicy: RetryPolicy;
  private log: OrchestratorLog;
  private lastEvent?: OrchestratorEvent;
  private client?: OpencodeClient;

  constructor(runId: string, retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY }, client?: OpencodeClient) {
    this.runId = runId;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...retryPolicy };
    this.log = { runId, events: [] };
    this.client = client;
  }

  setClient(client: OpencodeClient): void {
    this.client = client;
  }

  getState(): OrchestratorState {
    return this.state;
  }

  loadPersistedState(persisted: PersistedState): void {
    this.state = persisted.state;
    this.graph = recordToGraph(persisted.graph);
    this.assignments = new Map(Object.entries(persisted.assignments ?? {}));
    this.stalls = new Map(persisted.stalls.map((s) => [s.taskId, s]));
    this.log = persisted.log;
  }

  ingestRequest(request: DispatchRequest): void {
    const parsed = DispatchRequestSchema.safeParse(request);
    if (!parsed.success) {
      this.transition('failed', { taskId: request.id, reason: 'invalid_payload', issues: parsed.error.issues.map((issue) => issue.message) });
      return;
    }

    if (detectCycle(this.graph, request.id, request.dependsOn ?? [])) {
      this.transition('failed', { taskId: request.id, reason: 'dependency_cycle' });
      return;
    }

    this.transition('ingesting', { taskId: request.id, request });
    const depIds = new Set(request.dependsOn ?? []);
    this.graph.tasks.set(request.id, request);
    this.graph.parents.set(request.id, Array.from(depIds));
    for (const parentId of depIds) {
      const children = this.graph.children.get(parentId) ?? [];
      if (!children.includes(request.id)) {
        children.push(request.id);
      }
      this.graph.children.set(parentId, children);
    }
    this.transition('idle');
  }

  verifyDeps(request: DispatchRequest): boolean {
    this.transition('verifying', { taskId: request.id });
    const depIds = (request.dependsOn ?? []).slice().sort();
    const missing = new Set<string>();
    for (const depId of depIds) {
      const assignment = this.assignments.get(depId);
      if (!assignment || assignment.finishedAt === undefined) {
        missing.add(depId);
      }
    }

    if (missing.size > 0) {
      this.transition('failed', { taskId: request.id, missing: Array.from(missing) });
      return false;
    }

    this.transition('idle');
    return true;
  }

  dispatch(taskId: string): boolean {
    const task = this.graph.tasks.get(taskId);
    if (!task) {
      this.transition('failed', { taskId, reason: 'missing-task' });
      return false;
    }
    if (!this.verifyDeps(task)) {
      return false;
    }

    this.transition('dispatching', { taskId });
    const assignment: Assignment = {
      taskId,
      agentId: task.assignedAgent,
      assignedAt: Date.now(),
      attempts: 0,
      startedAt: Date.now(),
    };
    this.assignments.set(taskId, assignment);
    this.transition('idle');
    return true;
  }

  async detectAndDispatch(client: OpencodeClient): Promise<void> {
    const pending = [...this.graph.tasks.keys()].filter((id) => this.assignments.get(id)?.finishedAt == null);
    pending.sort((a, b) => a.localeCompare(b));

    let anyDispatched = false;

    for (const taskId of pending) {
      const task = this.graph.tasks.get(taskId);
      if (!task) {
        continue;
      }
      if (!this.verifyDeps(task)) {
        continue;
      }

      if (this.assignments.has(taskId)) {
        continue;
      }

      this.transition('dispatching', { taskId });
      try {
        const session = await client.session.create({ agent: task.assignedAgent, parentID: this.runId, metadata: { taskId: task.id } });
        const sessionID = (session as any)?.id ?? taskId;
        await client.session.promptAsync({
          sessionID,
          parts: [{ type: 'subtask', prompt: task.prompt, description: task.prompt, agent: task.assignedAgent }],
        });
      } catch (error) {
        this.transition('api_error', { taskId, error: String(error) });
        continue;
      }

      this.transition('running', { taskId });
      anyDispatched = true;
    }

    if (!anyDispatched && pending.length > 0) {
      this.transition('deadlock', {});
    }
  }

  collectResult(taskId: string, result: unknown): void {
    this.transition('collecting', { taskId });
    const assignment = this.assignments.get(taskId);
    if (!assignment) {
      this.transition('failed', { taskId, reason: 'missing-assignment' });
      return;
    }
    assignment.lastToolResult = result;
    assignment.finishedAt = Date.now();
    this.stalls.delete(taskId);
    this.transition('succeeded', { taskId });
  }

  recordHeartbeat(taskId: string, now: number, timeoutMs: number): void {
    const assignment = this.assignments.get(taskId);
    if (!assignment || assignment.finishedAt !== undefined) return;
    const stall = this.stalls.get(taskId);
    if (!stall) {
      this.stalls.set(taskId, { taskId, heartbeatAt: now, timeoutMs, attempts: 0, stalled: false });
      return;
    }
    stall.heartbeatAt = now;
  }

  stallCheck(): 'ok' | 'retry' | 'escalate' {
    this.transition('stall_check');
    const now = Date.now();
    let stalled = false;
    for (const [taskId, stall] of this.stalls) {
      const assignment = this.assignments.get(taskId);
      if (!assignment || assignment.finishedAt !== undefined) {
        this.stalls.delete(taskId);
        continue;
      }
      stalled = now - stall.heartbeatAt > stall.timeoutMs;
      if (!stalled) continue;
      if (stall.attempts < this.retryPolicy.maxAttempts) {
        stall.attempts += 1;
        stall.heartbeatAt = now;
        stall.stalled = false;
        this.transition('idle');
        return 'retry';
      }
      this.transition('escalated', { taskId, reason: 'stall-exhausted', attempts: stall.attempts });
      this.stalls.delete(taskId);
      return 'escalate';
    }

    this.transition('idle');
    return 'ok';
  }

  getGraph(): TaskGraph {
    const tasks: Record<string, DispatchRequest> = {};
    for (const [key, value] of this.graph.tasks) {
      tasks[key] = value;
    }
    const parents: Record<string, string[]> = {};
    for (const [key, value] of this.graph.parents) {
      parents[key] = Array.isArray(value) ? value : Array.from(value);
    }
    const children: Record<string, string[]> = {};
    for (const [key, value] of this.graph.children) {
      children[key] = Array.isArray(value) ? value : Array.from(value);
    }
    return { tasks, parents, children };
  }

  getAssignments(): Map<string, Assignment> {
    return this.assignments;
  }

  getStalls(): Map<string, StallState> {
    return this.stalls;
  }

  getLog(): OrchestratorLog {
    return this.log;
  }

  private transition(next: OrchestratorState, payload?: Record<string, unknown>): void {
    this.state = next;
    const event: OrchestratorEvent = {
      timestamp: Date.now(),
      transition: next,
      taskId: payload?.taskId as string | undefined,
      payload,
    };
    this.lastEvent = event;
    this.log.events.push(event);
  }
}

export function detectCycle(graph: { tasks: Map<string, DispatchRequest>; parents: Map<string, string[]> }, newTaskId: string, newDeps: string[]): boolean {
  for (const depId of newDeps) {
    const stack: string[] = [depId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === newTaskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const stored = graph.parents.get(current);
      if (stored) {
        for (const parent of stored) stack.push(parent);
      }
    }
  }
  return false;
}
