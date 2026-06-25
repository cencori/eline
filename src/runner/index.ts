import { loadAgent, type LoadedAgent } from "../loader";
import { discoverAgent } from "../discover/index";
import type { TurnContext, ToolCallContext } from "../types";
import {
  createSessionStarted, createTurnStarted, createMessageReceived,
  createMessageAppended, createMessageCompleted, createStepStarted,
  createStepCompleted, createSessionWaiting, createTurnCompleted,
  createSessionCompleted,
  type StreamEvent,
} from "../protocol/events";

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

async function submitTurn(
  endpoint: string,
  apiKey: string,
  agent: LoadedAgent,
  sessionId: string,
  input: string,
  stream: boolean,
): Promise<Response> {
  const model = agent.manifest.config.model;
  const instructions = agent.manifest.instructions;
  const tools = Object.entries(agent.manifest.tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    input_schema: tool.inputSchema ? {} : undefined,
    type: "function" as const,
  }));

  return fetch(`${endpoint}/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: headers(apiKey, agent),
    body: JSON.stringify({
      model,
      input,
      instructions,
      tools: tools.length > 0 ? tools : undefined,
      stream,
      pause_on_tool_calls: false,
    }),
  });
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

  if (!apiKey) {
    throw new Error(
      "Cencori API key required. Set CENCORI_API_KEY env var or pass apiKey in options.",
    );
  }

  const sessionId = options.sessionId || await createSession(endpoint, apiKey, agent);
  const turnId = crypto.randomUUID();

  const emit = (event: StreamEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };

  emit(createSessionStarted(sessionId, {
    agentId: agent.manifest.config.name ?? "unnamed",
    modelId: agent.manifest.config.model,
    zettVersion: "0.1.2",
  }));

  emit(createTurnStarted(1, turnId));
  emit(createMessageReceived(input, 1, turnId));

  const response = await submitTurn(endpoint, apiKey, agent, sessionId, input, false);

  if (!response.ok) {
    const error = await response.text();
    emit(createTurnCompleted(1, turnId));
    emit(createSessionCompleted());
    throw new Error(`Cencori Sessions API error (${response.status}): ${error}`);
  }

  // Non-streaming: read full SSE body and collect events
  const body = await response.text();
  let outputText = "";

  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "message.appended" && data.delta) {
          outputText += data.delta;
        }
      } catch {}
    }
  }

  emit(createStepCompleted("stop", 1, 0, turnId));
  emit(createMessageCompleted(outputText, "stop", 1, 0, turnId));
  emit(createTurnCompleted(1, turnId));
  emit(createSessionWaiting());

  const turn: TurnContext = {
    id: turnId,
    sessionId,
    input,
    output: outputText,
  };

  return {
    output: outputText,
    turns: [turn],
    events,
    sessionId,
  };
}

export async function* streamAgent(
  agentDir: string,
  input: string,
  options: RunOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const agent = await loadAgent(agentDir);
  const endpoint = options.endpoint || process.env.CENCORI_API_URL || DEFAULT_ENDPOINT;
  const apiKey = options.apiKey || process.env.CENCORI_API_KEY || "";
  const turnId = crypto.randomUUID();

  if (!apiKey) {
    throw new Error(
      "Cencori API key required. Set CENCORI_API_KEY env var or pass apiKey in options.",
    );
  }

  const sessionId = options.sessionId || await createSession(endpoint, apiKey, agent);

  const model = agent.manifest.config.model;
  const instructions = agent.manifest.instructions;
  const tools = Object.entries(agent.manifest.tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    input_schema: tool.inputSchema ? {} : undefined,
    type: "function" as const,
  }));

  yield createSessionStarted(sessionId, {
    agentId: agent.manifest.config.name ?? "unnamed",
    modelId: model,
    zettVersion: "0.1.2",
  });

  yield createTurnStarted(1, turnId);
  yield createMessageReceived(input, 1, turnId);
  yield createStepStarted(1, 0, turnId);

  const response = await fetch(`${endpoint}/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: headers(apiKey, agent),
    body: JSON.stringify({
      model,
      input,
      instructions,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      pause_on_tool_calls: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    yield createTurnCompleted(1, turnId);
    yield createSessionCompleted();
    throw new Error(`Cencori Sessions API error (${response.status}): ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let textSoFar = "";

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

          // Map Cencori Session events to Zett protocol events
          switch (currentEvent || parsed.type) {
            case "message.appended":
              if (parsed.delta) {
                textSoFar += parsed.delta;
                yield createMessageAppended(
                  parsed.delta,
                  textSoFar,
                  parsed.sequence ?? 1,
                  parsed.stepIndex ?? 0,
                  turnId,
                );
              }
              break;
            case "message.completed":
              if (parsed.text) textSoFar = parsed.text;
              break;
          }
        } catch {}
      }
    }
  }

  yield createMessageCompleted(textSoFar || null, "stop", 1, 0, turnId);
  yield createStepCompleted("stop", 1, 0, turnId);
  yield createTurnCompleted(1, turnId);
  yield createSessionWaiting();
}
