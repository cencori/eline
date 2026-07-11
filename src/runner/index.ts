import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, loadAgentById, type LoadedAgent } from "../loader";
import { toModelOutput } from "../tools/index";
import { Memory } from "../memory/index";
import type { TurnContext, ToolCallContext, ApprovalStrategy, ToolConfig, HookEvent, HookPayload } from "../types";
import {
  createSessionStarted, createTurnStarted, createMessageReceived,
  createMessageAppended, createMessageCompleted, createStepStarted,
  createStepCompleted, createSessionWaiting, createTurnCompleted,
  createSessionCompleted, createToolCallStarted, createToolCallCompleted,
  createSubagentCalled, createSubagentCompleted,
  type StreamEvent,
} from "../protocol/events";

/**
 * Reads arcie's own package.json at runtime to emit the real installed
 * version in session.started events. Walks up from the compiled file's
 * location because tsup's chunk layout puts the module at various
 * dist depths depending on splitting decisions.
 */
function readArcieVersion(): string {
  try {
    const start = dirname(fileURLToPath(import.meta.url));
    let current = start;
    for (let i = 0; i < 8; i += 1) {
      try {
        const pkg = JSON.parse(readFileSync(resolvePath(current, "package.json"), "utf-8"));
        if (pkg.name === "arcie" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* keep walking */
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

const ARCIE_VERSION = readArcieVersion();

type RunHooksFn = (event: HookEvent, payload: HookPayload) => Promise<void>;

function isToolBlocked(toolName: string, policy: import("../types").PolicyConfig | undefined): boolean {
  return !!policy?.blockedTools?.some(
    (blocked) => blocked === toolName || (blocked.endsWith("*") && toolName.startsWith(blocked.slice(0, -1)))
  );
}

function isModelAllowed(model: string, policy: import("../types").PolicyConfig | undefined): boolean {
  if (!policy?.allowedModels || policy.allowedModels.length === 0) return true;
  return policy.allowedModels.some(
    (allowed) => allowed === model || (allowed.endsWith("*") && model.startsWith(allowed.slice(0, -1)))
  );
}

const GUARD_PATTERNS: Record<string, RegExp> = {
  "no-email": /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  "no-phone": /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
  "no-ssn": /\b\d{3}-\d{2}-\d{4}\b/,
  "no-url": /https?:\/\/[^\s]+/,
  "no-code": /```[\s\S]*?```/,
};

function checkGuards(text: string, guards: string[] | undefined, direction: "input" | "output"): string | null {
  if (!guards || guards.length === 0) return null;
  for (const guard of guards) {
    const pattern = GUARD_PATTERNS[guard];
    if (pattern && pattern.test(text)) {
      return `Policy violation: ${guard} guard triggered on ${direction}`;
    }
    const maxLenMatch = guard.match(/^max-length:(\d+)$/);
    if (maxLenMatch) {
      const maxLen = parseInt(maxLenMatch[1], 10);
      if (text.length > maxLen) {
        return `Policy violation: ${direction} exceeds max length of ${maxLen} (${text.length} chars)`;
      }
    }
    if (guard.startsWith("contains:")) {
      const required = guard.slice(9);
      if (!text.includes(required)) {
        return `Policy violation: ${direction} must contain "${required}"`;
      }
    }
  }
  return null;
}

function createHookRunner(hooks: Record<string, import("../types").HookConfig>): RunHooksFn {
  const byEvent = new Map<HookEvent, import("../types").HookConfig[]>();
  for (const hook of Object.values(hooks)) {
    if (!hook.event) continue;
    const list = byEvent.get(hook.event) ?? [];
    list.push(hook);
    byEvent.set(hook.event, list);
  }
  return async (event: HookEvent, payload: HookPayload) => {
    const list = byEvent.get(event);
    if (!list) return;
    for (const hook of list) {
      try {
        await hook.handler(payload);
      } catch (err) {
        console.warn(`[arcie] Hook "${hook.name}" failed:`, err);
      }
    }
  };
}

export interface RunOptions {
  endpoint?: string;
  apiKey?: string;
  maxTurns?: number;
  sessionId?: string;
  resourceId?: string;
  threadId?: string;
  memoryStore?: import("../memory/index").MemoryStore;
  /** Directory for working memory .md files (sessions/). When set, working
   *  memory is stored as editable markdown instead of in the memory store. */
  workingMemoryDir?: string;
  onEvent?: (event: StreamEvent) => void;
  /**
   * Which top-level agent to run. Defaults to `"agent"` (the primary
   * loaded from `<agentDir>/agent.ts` + siblings). Any other id loads
   * `<agentDir>/<agentId>.ts` as a self-contained inline agent.
   */
  agentId?: string;
  /**
   * When true, the loader cache-busts every dynamic `import()` so edits to
   * agent files land on the next request without restarting the process.
   * `arcie dev` sets this to true by default. Not for production.
   */
  hotReload?: boolean;
  /**
   * Resume a session that paused for tool approval. Provide the paused
   * calls (from the tool.started events) with the user's verdict:
   * approved calls execute locally, denied calls return a refusal to the
   * model, and the turn continues. Requires `sessionId`; `input` is
   * ignored on a resumed turn.
   */
  resume?: { toolCalls: ResumeToolCall[] };
}

export interface ResumeToolCall {
  /** The action_id from the tool.started event's callId. */
  actionId: string;
  name: string;
  args: unknown;
  approved: boolean;
}

export interface RunResult {
  output: string;
  turns: TurnContext[];
  events: StreamEvent[];
  sessionId: string;
}

function truncateBody(body: string): string {
  if (body.length > 200 && (body.startsWith("<!") || body.startsWith("<html"))) {
    return body.slice(0, 200) + "... (HTML response truncated)";
  }
  return body;
}

const DEFAULT_ENDPOINT = "https://cencori.com/api/v1";

async function createChildSession(
  endpoint: string,
  apiKey: string,
  agent: LoadedAgent,
  subagentId: string,
): Promise<string> {
  const sub = agent.manifest.subagents[subagentId];
  const res = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      agent_id: null,
      metadata: {
        parent: agent.manifest.config.name ?? "unnamed",
        subagent: subagentId,
        model: sub.config.model,
        instructions: sub.instructions,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Subagent session error (${res.status}): ${truncateBody(err)}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

async function executeSubagent(
  endpoint: string,
  apiKey: string,
  agent: LoadedAgent,
  subagentId: string,
  input: unknown,
  childSessionId?: string,
): Promise<string> {
  const sub = agent.manifest.subagents[subagentId];
  childSessionId ??= await createChildSession(endpoint, apiKey, agent, subagentId);
  // The orchestrator calls subagents as functions with an { input } arg;
  // unwrap it so the child session gets the bare task text.
  const inputStr = typeof input === "string"
    ? input
    : input !== null && typeof input === "object" && typeof (input as { input?: unknown }).input === "string"
      ? (input as { input: string }).input
      : JSON.stringify(input);
  const tools = Object.entries(sub.tools).map(([name, tool]) =>
    toModelOutput(name, tool)
  );

  const res = await fetch(`${endpoint}/sessions/${childSessionId}/turns`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: sub.config.model,
      input: inputStr,
      instructions: sub.instructions,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      pause_on_tool_calls: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Subagent turn error (${res.status}): ${truncateBody(err)}`);
  }

  let output = "";
  let currentEvent = "";
  const reader = res.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7);
        } else if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const eventType = currentEvent || parsed.type;
            if (eventType === "message.appended" && parsed.delta) {
              output += parsed.delta;
            }
          } catch {}
        }
      }
    }
  }

  return output || inputStr;
}

function headers(apiKey: string, agent: LoadedAgent): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(agent.manifest.config.cencori?.project
      ? { "X-Project-ID": agent.manifest.config.cencori.project }
      : {}),
  };
}

async function createSession(
  endpoint: string,
  apiKey: string,
  agent: LoadedAgent,
): Promise<string> {
  // Cencori's `agent_id` is a nullable UUID that links a session to a
  // Cencori-side registered agent. Arcie is filesystem-first — the
  // "agent" lives in code, not as a DB row — so we let Cencori
  // auto-provision the session without a linked agent_id. The agent
  // name, model, and instructions travel in metadata for observability.
  const res = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: headers(apiKey, agent),
    body: JSON.stringify({
      agent_id: null,
      metadata: {
        name: agent.manifest.config.name,
        model: agent.manifest.config.model,
        instructions: agent.manifest.instructions,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cencori Sessions API error (${res.status}): ${truncateBody(err)}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

export async function runAgent(
  agentDir: string,
  input: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const agent = await loadAgent(agentDir);
  const endpoint = options.endpoint || process.env.CENCORI_API_URL || DEFAULT_ENDPOINT;
  const apiKey = options.apiKey || process.env.CENCORI_API_KEY || "";
  const events: StreamEvent[] = [];
  let outputText = "";

  if (!apiKey) {
    throw new Error(
      "Cencori API key required. Set CENCORI_API_KEY env var or pass apiKey in options.",
    );
  }

  const sessionId = options.sessionId || await createSession(endpoint, apiKey, agent);

  for await (const event of streamLoadedAgent(agent, input, { ...options, sessionId, endpoint, apiKey })) {
    events.push(event);
    options.onEvent?.(event);
    if (event.type === "message.completed" && event.data.text) {
      outputText = event.data.text;
    }
  }

  const toolCalls: ToolCallContext[] = [];
  for (const e of events) {
    if (e.type === "tool.started") {
      const completed = events.find(
        (ev): ev is ReturnType<typeof createToolCallCompleted> =>
          ev.type === "tool.completed" && ev.data.callId === e.data.callId
      );
      const error = completed?.data.status === "failed" || completed?.data.status === "rejected"
        ? new Error(completed.data.error?.message ?? "Tool failed")
        : undefined;
      toolCalls.push({
        tool: e.data.name,
        input: e.data.input,
        output: completed?.data.output,
        durationMs: undefined,
        ...(error ? { error } : {}),
      });
    }
  }

  return {
    output: outputText,
    turns: [{
      id: events.find(e => e.type === "turn.started")?.data.turnId ?? "",
      sessionId,
      input,
      output: outputText,
      toolCalls,
    }],
    events,
    sessionId,
  };
}

// ── SSE event reader ──────────────────────────────────────────────

type ToolCallInfo = {
  name: string;
  args: unknown;
  actionId: string;
};

type TurnResult =
  | { status: "completed"; text: string }
  | { status: "paused"; toolCalls: ToolCallInfo[]; text: string };

async function* readTurnSSE(
  response: Response,
  turnId: string,
): AsyncGenerator<StreamEvent, TurnResult, unknown> {
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cencori Sessions API error (${response.status}): ${truncateBody(error)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) return { status: "completed", text: "" } as TurnResult;

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let textSoFar = "";
  const toolCalls: ToolCallInfo[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const eventType = currentEvent || parsed.type;

          switch (eventType) {
            case "turn.started": {
              yield createTurnStarted(parsed.turn_number ?? 1, turnId);
              yield createMessageReceived(parsed.input_text ?? "", parsed.turn_number ?? 1, turnId);
              yield createStepStarted(1, 0, turnId);
              break;
            }

            case "output_text.delta": {
              if (parsed.delta) {
                textSoFar += parsed.delta;
                yield createMessageAppended(parsed.delta, textSoFar, 1, 0, turnId);
              }
              break;
            }

            case "tool_call.started": {
              toolCalls.push({
                name: parsed.tool,
                args: parsed.arguments,
                actionId: parsed.action_id,
              });
              yield createToolCallStarted(
                parsed.tool,
                parsed.arguments,
                parsed.action_id,
                1,
                0,
                turnId,
              );
              break;
            }

            case "turn.paused": {
              currentEvent = "";
              return {
                status: "paused",
                toolCalls: [...toolCalls],
                text: textSoFar,
              } as TurnResult;
            }

            case "turn.completed": {
              const out = parsed.output;
              let finalText = textSoFar;
              let finishReason: "stop" | "error" = "stop";
              if (out?.error) {
                finishReason = "error";
              } else if (Array.isArray(out?.output)) {
                for (const item of out.output) {
                  if (item.type === "message") {
                    const tc = item.content?.find((c: { type: string; text?: string }) => c.type === "output_text");
                    if (tc?.text) finalText = tc.text;
                  }
                }
              }
              textSoFar = finalText;
              yield createMessageCompleted(finalText, finishReason, 1, 0, turnId);
              yield createStepCompleted(finishReason, 1, 0, turnId);
              yield createTurnCompleted(1, turnId);
              currentEvent = "";
              return { status: "completed", text: finalText } as TurnResult;
            }

            case "turn.failed": {
              const errRaw = parsed.output?.error;
              const errMsg = typeof errRaw === "string" ? errRaw : "Turn failed";
              const finalText = textSoFar.length > 0 ? textSoFar : `Error: ${errMsg}`;
              yield createMessageCompleted(finalText, "error", 1, 0, turnId);
              yield createStepCompleted("error", 1, 0, turnId);
              yield createTurnCompleted(1, turnId);
              currentEvent = "";
              return { status: "completed", text: finalText } as TurnResult;
            }

            case "turn.resumed": {
              break;
            }

            default: {
              break;
            }
          }

          currentEvent = "";
        } catch {}
      }
    }
  }

  return { status: "completed", text: textSoFar } as TurnResult;
}

// ── Tool execution ────────────────────────────────────────────────

type PendingToolCall = { name: string; args: unknown; actionId: string; denied?: boolean };

type ToolBatchOutcome = {
  toolResults: Array<{ action_id: string; output: string }>;
  needsUserApproval: boolean;
};

type ToolExecutionContext = {
  agent: LoadedAgent;
  memoryTools: Record<string, ToolConfig>;
  approvedTools: Set<string>;
  allToolCalls: { tool: string; input: unknown; output: unknown }[];
  endpoint: string;
  apiKey: string;
  turnId: string;
  bypassApproval: boolean;
  runHooks: RunHooksFn;
};

/**
 * Executes one batch of model-requested tool calls, yielding progress
 * events. Approval strategies are enforced unless `bypassApproval` is
 * set (used on resume, when the user has already ruled on each call);
 * calls marked `denied` are not executed and report a refusal back to
 * the model instead.
 */
async function* executeToolCalls(
  calls: PendingToolCall[],
  ctx: ToolExecutionContext,
): AsyncGenerator<StreamEvent, ToolBatchOutcome, unknown> {
  const { agent, memoryTools, approvedTools, allToolCalls, endpoint, apiKey, turnId, runHooks } = ctx;
  const toolResults: Array<{ action_id: string; output: string }> = [];
  let needsUserApproval = false;

  for (const tc of calls) {
    const toolDef = agent.manifest.tools[tc.name] ?? memoryTools[tc.name];
    const subDef = agent.manifest.subagents[tc.name];
    const strategy: ApprovalStrategy | undefined = toolDef?.needsApproval;

    if (tc.denied) {
      const msg = `User declined to run tool "${tc.name}".`;
      yield createToolCallCompleted(tc.name, msg, tc.actionId, "rejected",
        { code: "user_rejected", message: msg }, 1, 0, turnId);
      toolResults.push({ action_id: tc.actionId, output: msg });
      allToolCalls.push({ tool: tc.name, input: tc.args, output: msg });
      continue;
    }

    if (isToolBlocked(tc.name, agent.manifest.policy)) {
      const msg = `Tool "${tc.name}" is blocked by policy.`;
      yield createToolCallCompleted(tc.name, msg, tc.actionId, "rejected",
        { code: "blocked_by_policy", message: msg }, 1, 0, turnId);
      toolResults.push({ action_id: tc.actionId, output: msg });
      allToolCalls.push({ tool: tc.name, input: tc.args, output: msg });
      continue;
    }

    if (!ctx.bypassApproval && (strategy === "always" || (strategy === "once" && !approvedTools.has(tc.name)))) {
      needsUserApproval = true;
      yield createToolCallCompleted(tc.name, null, tc.actionId, "pending",
        { code: "needs_approval", message: `Tool "${tc.name}" requires approval` }, 1, 0, turnId);
      continue;
    }

    if (strategy === "once") approvedTools.add(tc.name);

    if (toolDef?.execute) {
      const start = Date.now();
      await runHooks("beforeToolCall", { toolCall: { tool: tc.name, input: tc.args } });
      try {
        const output = await toolDef.execute(tc.args);
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);
        yield createToolCallCompleted(tc.name, outputStr, tc.actionId, "completed", undefined, 1, 0, turnId);
        toolResults.push({ action_id: tc.actionId, output: outputStr });
        allToolCalls.push({ tool: tc.name, input: tc.args, output });
        await runHooks("afterToolCall", { toolCall: { tool: tc.name, input: tc.args, output, durationMs: Date.now() - start } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Tool execution failed";
        const error = err instanceof Error ? err : new Error(msg);
        yield createToolCallCompleted(tc.name, msg, tc.actionId, "failed", { code: "execution_error", message: msg }, 1, 0, turnId);
        toolResults.push({ action_id: tc.actionId, output: `Error: ${msg}` });
        allToolCalls.push({ tool: tc.name, input: tc.args, output: `Error: ${msg}` });
        await runHooks("afterToolCall", { toolCall: { tool: tc.name, input: tc.args, error, durationMs: Date.now() - start } });
      }
    } else if (subDef) {
      const callId = tc.actionId;
      const start = Date.now();
      await runHooks("beforeToolCall", { toolCall: { tool: tc.name, input: tc.args } });
      try {
        const childSessionId = await createChildSession(endpoint, apiKey, agent, tc.name);
        yield createSubagentCalled(tc.name, callId, childSessionId, turnId);
        const output = await executeSubagent(endpoint, apiKey, agent, tc.name, tc.args, childSessionId);
        yield createSubagentCompleted(tc.name, callId, output);
        yield createToolCallCompleted(tc.name, output, tc.actionId, "completed", undefined, 1, 0, turnId);
        toolResults.push({ action_id: tc.actionId, output });
        allToolCalls.push({ tool: tc.name, input: tc.args, output });
        await runHooks("afterToolCall", { toolCall: { tool: tc.name, input: tc.args, output, durationMs: Date.now() - start } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Subagent execution failed";
        const error = err instanceof Error ? err : new Error(msg);
        yield createSubagentCompleted(tc.name, callId, `Error: ${msg}`);
        yield createToolCallCompleted(tc.name, msg, tc.actionId, "failed", { code: "execution_error", message: msg }, 1, 0, turnId);
        toolResults.push({ action_id: tc.actionId, output: `Error: ${msg}` });
        allToolCalls.push({ tool: tc.name, input: tc.args, output: `Error: ${msg}` });
        await runHooks("afterToolCall", { toolCall: { tool: tc.name, input: tc.args, error, durationMs: Date.now() - start } });
      }
    } else {
      yield createToolCallCompleted(tc.name, "Tool not found in agent manifest", tc.actionId, "failed", { code: "tool_not_found", message: `Tool "${tc.name}" not defined in agent` }, 1, 0, turnId);
      toolResults.push({ action_id: tc.actionId, output: "Error: tool not defined" });
      allToolCalls.push({ tool: tc.name, input: tc.args, output: "Error: tool not defined" });
    }
  }

  return { toolResults, needsUserApproval };
}

// ── Multi-turn agent loop ─────────────────────────────────────────

export async function* streamAgent(
  agentDir: string,
  input: string,
  options: RunOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const loadOpts = { hotReload: options.hotReload };
  const agent =
    options.agentId !== undefined && options.agentId !== "agent"
      ? await loadAgentById(agentDir, options.agentId, loadOpts)
      : await loadAgent(agentDir, loadOpts);
  yield* streamLoadedAgent(agent, input, options);
}

/** Internal entry point that works directly on a LoadedAgent without filesystem loading. */
export async function* streamLoadedAgent(
  agent: LoadedAgent,
  input: string,
  options: RunOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const endpoint = options.endpoint || process.env.CENCORI_API_URL || DEFAULT_ENDPOINT;
  const apiKey = options.apiKey || process.env.CENCORI_API_KEY || "";

  if (!apiKey) {
    throw new Error(
      "Cencori API key required. Set CENCORI_API_KEY env var or pass apiKey in options.",
    );
  }

  const runHooks = createHookRunner(agent.manifest.hooks);
  await runHooks("onStart", {});

  if (!isModelAllowed(agent.manifest.config.model, agent.manifest.policy)) {
    throw new Error(
      `Model "${agent.manifest.config.model}" is not allowed by policy. Allowed: ${agent.manifest.policy?.allowedModels?.join(", ") ?? "none"}`,
    );
  }

  const inputViolation = checkGuards(input, agent.manifest.policy?.inputGuards, "input");
  if (inputViolation) {
    throw new Error(inputViolation);
  }

  let sessionId = options.sessionId || await createSession(endpoint, apiKey, agent);

  try {
  const model = agent.manifest.config.model;

  const memory = agent.manifest.session?.memory
    ? new Memory(agent.manifest.session.memory, {
        store: options.memoryStore,
        resourceId: options.resourceId,
        threadId: options.threadId,
        workingMemoryDir: options.workingMemoryDir,
      })
    : null;
  const memoryTools = memory ? memory.getToolDefinitions() : {};
  const allTools = { ...agent.manifest.tools, ...memoryTools };
  // Subagents are callable like tools: advertise each as a function that
  // takes the task to delegate. Execution routes through executeSubagent.
  const subagentTools = Object.entries(agent.manifest.subagents).map(([name, sub]) => ({
    type: "function" as const,
    function: {
      name,
      description: sub.config.description ?? `Delegate a task to the "${name}" subagent.`,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "The task or question to hand to the subagent" },
        },
        required: ["input"],
      },
    },
  }));
  const tools = [
    ...Object.entries(allTools).map(([name, tool]) => toModelOutput(name, tool)),
    ...subagentTools,
  ];
  const memoryContext = memory ? await memory.getInputContext() : "";
  const memoryInstruction = memory ? memory.getSystemInstruction() : "";
  const instructions = [
    agent.manifest.instructions,
    memoryInstruction,
    memoryContext,
  ].filter(Boolean).join("\n\n");

  yield createSessionStarted(sessionId, {
    agentId: agent.manifest.config.name ?? "unnamed",
    modelId: model,
    arcieVersion: ARCIE_VERSION,
  });

  const turnId = crypto.randomUUID();
  const maxToolLoops = options.maxTurns ?? 25;

  // Track tools approved via "once" strategy within this session
  const approvedTools = new Set<string>();
  const allToolCalls: { tool: string; input: unknown; output: unknown }[] = [];
  const execCtx: ToolExecutionContext = {
    agent, memoryTools, approvedTools, allToolCalls,
    endpoint, apiKey, turnId, bypassApproval: false, runHooks,
  };

  let response: Response;
  if (options.resume) {
    if (!options.sessionId) {
      throw new Error("resume requires a sessionId");
    }
    // The user has ruled on each paused call: execute the approved ones
    // (bypassing needsApproval — that's what the ruling was), report
    // refusals for the denied ones, then hand the results to Cencori to
    // continue the paused turn.
    const calls: PendingToolCall[] = options.resume.toolCalls.map((tc) => ({
      name: tc.name, args: tc.args, actionId: tc.actionId, denied: !tc.approved,
    }));
    const gen = executeToolCalls(calls, { ...execCtx, bypassApproval: true });
    let it = await gen.next();
    while (!it.done) {
      yield it.value;
      it = await gen.next();
    }
    const { toolResults } = it.value;
    if (toolResults.length === 0) {
      yield createSessionWaiting();
      return;
    }
    response = await fetch(`${endpoint}/sessions/${sessionId}/approve`, {
      method: "POST",
      headers: headers(apiKey, agent),
      body: JSON.stringify({
        action_id: toolResults[0]!.action_id,
        tool_results: toolResults,
      }),
    });
  } else {
    await runHooks("beforeTurn", { turn: { id: turnId, sessionId, input } });
    const postTurn = (sid: string) =>
      fetch(`${endpoint}/sessions/${sid}/turns`, {
        method: "POST",
        headers: headers(apiKey, agent),
        body: JSON.stringify({
          model,
          input,
          instructions,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          pause_on_tool_calls: true,
        }),
      });

    response = await postTurn(sessionId);

    // A caller-supplied sessionId can point at a session that has been
    // closed or expired server-side. Rather than surfacing a 409 to the
    // user, transparently start a fresh session and retry once; the new
    // session.started event lets clients update their stored id.
    if (response.status === 409 && options.sessionId) {
      const body = await response.text();
      if (body.includes("session_not_active")) {
        sessionId = await createSession(endpoint, apiKey, agent);
        yield createSessionStarted(sessionId, {
          agentId: agent.manifest.config.name ?? "unnamed",
          modelId: model,
          arcieVersion: ARCIE_VERSION,
        });
        response = await postTurn(sessionId);
      } else {
        yield createTurnCompleted(1, turnId);
        yield createSessionCompleted();
        throw new Error(`Cencori Sessions API error (409): ${truncateBody(body)}`);
      }
    }
  }

  if (!response.ok) {
    const error = await response.text();
    yield createTurnCompleted(1, turnId);
    yield createSessionCompleted();
    throw new Error(`Cencori Sessions API error (${response.status}): ${truncateBody(error)}`);
  }

  // Tool call loop: pause → execute → approve → resume → repeat
  for (let loop = 0; loop < maxToolLoops; loop++) {
    const eventGen = readTurnSSE(response, turnId);
    let result: TurnResult;

    let iter = await eventGen.next();
    while (!iter.done) {
      yield iter.value;
      iter = await eventGen.next();
    }
    result = iter.value;

    if (result.status === "completed") {
      if (memory) {
        await memory.recordTurn(input, result.text, allToolCalls.length > 0 ? allToolCalls : undefined);
      }
      await runHooks("afterTurn", {
        turn: { id: turnId, sessionId, input, output: result.text, toolCalls: allToolCalls.map(tc => ({ tool: tc.tool, input: tc.input, output: tc.output })) }
      });
      const outputViolation = checkGuards(result.text, agent.manifest.policy?.outputGuards, "output");
      if (outputViolation) {
        yield createMessageCompleted(result.text, "error", 1, 0, turnId);
        yield createStepCompleted("error", 1, 0, turnId);
        yield createTurnCompleted(1, turnId);
        yield createSessionCompleted();
        throw new Error(outputViolation);
      }
      break;
    }

    if (result.status !== "paused" || result.toolCalls.length === 0) break;

    const gen = executeToolCalls(result.toolCalls, execCtx);
    let it = await gen.next();
    while (!it.done) {
      yield it.value;
      it = await gen.next();
    }
    const { toolResults, needsUserApproval } = it.value;

    if (needsUserApproval && toolResults.length === 0) {
      yield createSessionWaiting();
      return;
    }

    const firstActionId = toolResults[0]!.action_id;

    const approveRes = await fetch(
      `${endpoint}/sessions/${sessionId}/approve`,
      {
        method: "POST",
        headers: headers(apiKey, agent),
        body: JSON.stringify({
          action_id: firstActionId,
          tool_results: toolResults,
        }),
      },
    );

    if (!approveRes.ok) {
      const errText = await approveRes.text();
      yield createTurnCompleted(1, turnId);
      yield createSessionCompleted();
      throw new Error(`Cencori Sessions approve error (${approveRes.status}): ${truncateBody(errText)}`);
    }

    response = approveRes;
  }

  yield createSessionWaiting();
  } catch (_err) {
    const _hookErr = _err instanceof Error ? _err : new Error(String(_err));
    await runHooks("onError", { error: _hookErr });
    throw _err;
  } finally {
    await runHooks("onEnd", {});
  }
}
