import { zodToJsonSchema } from "zod-to-json-schema";
import { loadAgent, type LoadedAgent } from "../loader.js";
import type { TurnContext, ToolCallContext } from "../types.js";
import {
  createSessionStarted, createTurnStarted, createMessageReceived,
  createMessageAppended, createMessageCompleted, createStepStarted,
  createStepCompleted, createSessionWaiting, createTurnCompleted,
  createSessionCompleted, createToolCallStarted, createToolCallCompleted,
  type StreamEvent,
} from "../protocol/events.js";

export interface RunOptions {
  endpoint?: string;
  apiKey?: string;
  maxTurns?: number;
  sessionId?: string;
  onEvent?: (event: StreamEvent) => void;
}

export interface RunResult {
  output: string;
  turns: TurnContext[];
  events: StreamEvent[];
  sessionId: string;
}

const DEFAULT_ENDPOINT = "https://cencori.com/v1";

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
  const res = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: headers(apiKey, agent),
    body: JSON.stringify({
      agent_id: agent.manifest.config.name,
      metadata: {
        model: agent.manifest.config.model,
        instructions: agent.manifest.instructions,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cencori Sessions API error (${res.status}): ${err}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

function buildToolDefinitions(agent: LoadedAgent) {
  return Object.entries(agent.manifest.tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    input_schema: tool.inputSchema
      ? zodToJsonSchema(tool.inputSchema, { target: "openApi3" })
      : undefined,
    type: "function" as const,
  }));
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

  for await (const event of streamAgent(agentDir, input, { ...options, sessionId, endpoint, apiKey })) {
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
      toolCalls.push({
        tool: e.data.name,
        input: e.data.input,
        output: completed?.data.output,
        durationMs: undefined,
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
    throw new Error(`Cencori Sessions API error (${response.status}): ${error}`);
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
                    const tc = item.content?.find((c: any) => c.type === "output_text");
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

// ── Multi-turn agent loop ─────────────────────────────────────────

export async function* streamAgent(
  agentDir: string,
  input: string,
  options: RunOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const agent = await loadAgent(agentDir);
  const endpoint = options.endpoint || process.env.CENCORI_API_URL || DEFAULT_ENDPOINT;
  const apiKey = options.apiKey || process.env.CENCORI_API_KEY || "";

  if (!apiKey) {
    throw new Error(
      "Cencori API key required. Set CENCORI_API_KEY env var or pass apiKey in options.",
    );
  }

  const sessionId = options.sessionId || await createSession(endpoint, apiKey, agent);
  const model = agent.manifest.config.model;
  const instructions = agent.manifest.instructions;
  const tools = buildToolDefinitions(agent);

  yield createSessionStarted(sessionId, {
    agentId: agent.manifest.config.name ?? "unnamed",
    modelId: model,
    elineVersion: "0.1.2",
  });

  const turnId = crypto.randomUUID();
  const maxToolLoops = options.maxTurns ?? 25;

  let response = await fetch(`${endpoint}/sessions/${sessionId}/turns`, {
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

  if (!response.ok) {
    const error = await response.text();
    yield createTurnCompleted(1, turnId);
    yield createSessionCompleted();
    throw new Error(`Cencori Sessions API error (${response.status}): ${error}`);
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

    if (result.status === "completed") break;

    if (result.status !== "paused" || result.toolCalls.length === 0) break;

    const toolResults: Array<{ action_id: string; output: string }> = [];

    for (const tc of result.toolCalls) {
      const toolDef = agent.manifest.tools[tc.name];
      if (toolDef?.execute) {
        try {
          const output = await toolDef.execute(tc.args);
          const outputStr = typeof output === "string" ? output : JSON.stringify(output);
          yield createToolCallCompleted(tc.name, outputStr, tc.actionId, "completed", undefined, 1, 0, turnId);
          toolResults.push({ action_id: tc.actionId, output: outputStr });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Tool execution failed";
          yield createToolCallCompleted(tc.name, msg, tc.actionId, "failed", { code: "execution_error", message: msg }, 1, 0, turnId);
          toolResults.push({ action_id: tc.actionId, output: `Error: ${msg}` });
        }
      } else {
        yield createToolCallCompleted(tc.name, "Tool not found in agent manifest", tc.actionId, "failed", { code: "tool_not_found", message: `Tool "${tc.name}" not defined in agent` }, 1, 0, turnId);
        toolResults.push({ action_id: tc.actionId, output: "Error: tool not defined" });
      }
    }

    const firstActionId = toolResults[0]?.action_id ?? "";
    if (!firstActionId) break;

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
      throw new Error(`Cencori Sessions approve error (${approveRes.status}): ${errText}`);
    }

    response = approveRes;
  }

  yield createSessionWaiting();
}
