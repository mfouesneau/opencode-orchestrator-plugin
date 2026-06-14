import { z } from 'zod';

export const HookNameSchema = z.enum(['chat.message', 'tool.execute.before', 'tool.execute.after', 'shell.env', 'tool.definition']);
export type HookName = z.infer<typeof HookNameSchema>;

export const TERMINAL_TASK_STATUS = ['succeeded', 'failed', 'escalated', 'recovery_error', 'invalid_payload', 'api_error', 'deadlock', 'timeout_exhausted'] as const;

export const TerminalTaskStatusSchema = z.enum(['succeeded', 'failed', 'escalated', 'recovery_error', 'invalid_payload', 'api_error', 'deadlock', 'timeout_exhausted']);
export type TerminalTaskStatus = z.infer<typeof TerminalTaskStatusSchema>;

export const TaskStatusSchema = z.enum(['pending', 'ready', 'running', 'succeeded', 'failed', 'escalated', 'recovery_error', 'invalid_payload', 'api_error', 'deadlock', 'timeout_exhausted']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const DispatchRequestSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  assignedAgent: z.string(),
  parentTaskId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  acceptance: z.array(z.string()),
  createdAt: z.number(),
});
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

export const AssignmentSchema = z.object({
  taskId: z.string(),
  agentId: z.string(),
  assignedAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  attempts: z.number(),
  lastToolResult: z.unknown().optional(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.record(z.string(), DispatchRequestSchema),
  parents: z.record(z.string(), z.array(z.string())),
  children: z.record(z.string(), z.array(z.string())),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const StallStateSchema = z.object({
  taskId: z.string(),
  heartbeatAt: z.number(),
  timeoutMs: z.number(),
  attempts: z.number(),
  stalled: z.boolean(),
});
export type StallState = z.infer<typeof StallStateSchema>;

export const ORCHESTRATOR_STATES = [
  'idle',
  'ingesting',
  'verifying',
  'dispatching',
  'collecting',
  'stall_check',
  'succeeded',
  'failed',
  'escalated',
  'recovery',
] as const;

export type OrchestratorState = (typeof ORCHESTRATOR_STATES)[number];

export const OrchestratorEventSchema = z.object({
  timestamp: z.number(),
  transition: z.enum(ORCHESTRATOR_STATES),
  taskId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type OrchestratorEvent = z.infer<typeof OrchestratorEventSchema>;

export const OrchestratorLogSchema = z.object({
  runId: z.string(),
  events: z.array(OrchestratorEventSchema),
});
export type OrchestratorLog = z.infer<typeof OrchestratorLogSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number(),
  backoffMs: z.number(),
  jitterRatio: z.number(),
  timeoutMs: z.number().optional(),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const RecoveryErrorSchema = z.object({
  message: z.string(),
  cause: z.string(),
  path: z.string().optional(),
});
export type RecoveryError = z.infer<typeof RecoveryErrorSchema>;

export type DependencyCheckResult = 'met' | 'missing' | 'unfinished' | 'failed_sibling';

export const PersistedStateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  redirectedAt: z.number(),
  state: z.enum(ORCHESTRATOR_STATES),
  graph: TaskGraphSchema,
  assignments: z.record(z.string(), AssignmentSchema),
  stalls: z.array(StallStateSchema),
  log: OrchestratorLogSchema,
  failedSiblings: z.record(z.string(), z.array(z.string())),
  cycleDetected: z.boolean().optional(),
});
export type PersistedState = z.infer<typeof PersistedStateSchema>;

export type DispatchInput = {
  taskId: string;
  prompt: string;
  parentId?: string;
};

export type SubtaskPartInput = {
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
};
