import type { PluginInput } from '@opencode-ai/plugin';
import type { PersistedState } from './state/types.js';
import { Orchestrator, loadState, saveState, removeState, PersistedStateSchema } from './core/orchestrator.js';

const STATE_PATH = join('.agents-workspace', 'orchestrator-state.json');
const registry = new Map<string, Orchestrator>();

export function defineOrchestratorPlugin(input: PluginInput) {
  const load = async (runId: string): Promise<Orchestrator> => {
    const existing = registry.get(runId);
    if (existing) return existing;
    const defaults = {
      state: 'idle',
      graph: { tasks: {}, parents: {}, children: {} },
      assignments: {},
      stalls: [],
      log: { runId, events: [] },
      failedSiblings: {},
    } as any;
    const persisted = loadState(STATE_PATH, defaults);
    const orchestrator = new Orchestrator(runId, undefined, persisted.client);
    orchestrator.loadPersistedState(persisted);
    registry.set(runId, orchestrator);
    return orchestrator;
  };

  const finalize = async (
    runId: string,
    orchestrator: Orchestrator,
  ): Promise<void> => {
    const state = orchestrator.getState();
    const graph = orchestrator.getGraph();
    const assignments = Object.fromEntries(orchestrator.getAssignments());
    const stalls = Array.from(orchestrator.getStalls().values());
    const log = orchestrator.getLog();
    await saveState(STATE_PATH, {
      version: 1,
      runId,
      redirectedAt: Date.now(),
      state,
      graph,
      assignments,
      stalls,
      log,
      failedSiblings: {},
    });
  };

  return {
    "chat.message": async (
      _input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
      output: { message: unknown; parts: unknown[] },
    ) => {
      const runId = _input.sessionID ?? 'default';
      const orchestrator = await load(runId);
      orchestrator.setClient(input.client);
      const content = (output.message as any)?.content;
      if (typeof content !== 'object' || content === null || (content as Record<string, unknown>).kind !== 'dispatch-request') {
        return;
      }
      orchestrator.ingestRequest((content as { request: unknown }).request as Parameters<Orchestrator['ingestRequest']>[0]);
      await orchestrator.detectAndDispatch(input.client);
      await finalize(runId, orchestrator);
    },
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string; args?: unknown }) => {
      const runId = input.sessionID;
      const orchestrator = await load(runId);
      orchestrator.setClient(input.client);
      const hookName = inferTaskIdFromMetadata({ taskId: input.callID }, 'before');
      if (!hookName) return;
      orchestrator.recordHeartbeat(hookName, Date.now(), 1_000);
      await finalize(runId, orchestrator);
    },
    "tool.execute.after": async (input: { tool: string; sessionID: string; callID: string; args: unknown }, output: { title: string; output: string; metadata?: Record<string, unknown> }) => {
      const runId = input.sessionID;
      const orchestrator = await load(runId);
      orchestrator.setClient(input.client);
      const hookName = inferTaskIdFromMetadata({ taskId: input.callID, ...output }, 'after');
      if (hookName) {
        if (output?.output !== undefined) {
          orchestrator.collectResult(hookName, output);
        }
        await orchestrator.detectAndDispatch(input.client);
      }
      await finalize(runId, orchestrator);
    },
    "shell.env": async (_input: { cwd: string; sessionID?: string; callID?: string }, _output: { env: Record<string, string> }) => {
      // Reserved for environment contract validation.
    },
    "tool.definition": async (_input: { toolID: string }, _output: { description: string; parameters: unknown }) => {
      // Hook reserved for dynamic tool definition injection.
    },
    dispose: async () => {
      for (const [runId] of registry) {
        await removeState(STATE_PATH);
      }
      registry.clear();
    },
  } satisfies Hooks;
}

function inferTaskIdFromMetadata(metadata: Record<string, unknown> | undefined, _phase: string): string | undefined {
  if (!metadata) {
    return undefined;
  }
  const candidate = metadata.taskId ?? metadata.originalToolName;
  if (typeof candidate === 'string') {
    return candidate;
  }
  return undefined;
}
