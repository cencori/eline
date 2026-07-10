import type { ModelToolDefinition } from "../tools/index";

interface ProviderConfig {
  baseUrl: string;
  apiKey: () => string | undefined;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: () => process.env.OPENAI_API_KEY,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: () => process.env.ANTHROPIC_API_KEY,
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: () => process.env.GROQ_API_KEY,
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: () => process.env.DEEPSEEK_API_KEY,
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: () => process.env.MISTRAL_API_KEY,
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: () => process.env.GOOGLE_API_KEY,
  },
  meta: {
    baseUrl: "https://api.together.xyz/v1",
    apiKey: () => process.env.TOGETHER_API_KEY || process.env.OPENAI_API_KEY,
  },
};

/**
 * Infers the provider for bare model ids (no "provider/" prefix), the
 * way gateways route them. Keeps `defineAgent({ model: "llama-3.3-70b-versatile" })`
 * working against direct provider APIs, not just Cencori.
 */
const BARE_MODEL_PROVIDERS: Array<[RegExp, string]> = [
  [/^gpt-oss/, "groq"], // open-weight gpt-oss models are hosted by Groq, not OpenAI
  [/^(gpt-|o[0-9])/, "openai"],
  [/^claude-/, "anthropic"],
  [/^gemini-/, "google"],
  [/^deepseek-/, "deepseek"],
  [/^(mistral-|codestral)/, "mistral"],
  [/^(llama-|qwen|kimi|moonshot|gemma)/, "groq"],
];

function inferProvider(model: string): string {
  for (const [pattern, provider] of BARE_MODEL_PROVIDERS) {
    if (pattern.test(model)) return provider;
  }
  return "";
}

function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: inferProvider(modelId), model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

/** Resolves which provider serves a model id ("groq" for "llama-3.3-70b-versatile"). */
export function resolveProviderForModel(modelId: string): string {
  return parseModelId(modelId).provider;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ToolResult {
  action_id: string;
  output: string;
}

export interface LlmStreamEvent {
  type: "delta" | "tool_call" | "done" | "error";
  delta?: string;
  toolCall?: { name: string; arguments: string; id: string };
  toolCalls?: Array<{ name: string; arguments: string; id: string }>;
  finishReason?: string;
  error?: string;
}

export function getProviderApiKey(provider: string): string | undefined {
  const cfg = PROVIDERS[provider];
  return cfg?.apiKey?.();
}

function flattenToolResults(model: string, results: ToolResult[]): LlmMessage[] {
  const provider = parseModelId(model).provider;
  if (provider === "anthropic") {
    return results.map((r) => ({
      role: "user" as const,
      content: JSON.stringify({ type: "tool_result", tool_use_id: r.action_id, content: r.output }),
    }));
  }
  return results.map((r) => ({
    role: "tool" as const,
    tool_call_id: r.action_id,
    content: r.output,
  }));
}

export async function* streamLlm(
  modelId: string,
  messages: LlmMessage[],
  tools?: ModelToolDefinition[],
  toolResults?: ToolResult[],
): AsyncGenerator<LlmStreamEvent> {
  const { provider, model } = parseModelId(modelId);
  const cfg = PROVIDERS[provider];

  if (!cfg) {
    yield { type: "error", error: `Unknown provider: ${provider}` };
    return;
  }

  const apiKey = cfg.apiKey();
  if (!apiKey) {
    yield { type: "error", error: `Missing API key for provider: ${provider}. Set ${provider.toUpperCase()}_API_KEY` };
    return;
  }

  if (provider === "anthropic") {
    yield* streamAnthropic(cfg.baseUrl, apiKey, model, messages, tools, toolResults);
  } else if (provider === "google") {
    yield* streamGoogle(cfg.baseUrl, apiKey, model, messages, tools, toolResults);
  } else {
    yield* streamOpenAICompatible(cfg.baseUrl, apiKey, model, messages, tools, toolResults);
  }
}

async function* streamOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools?: ModelToolDefinition[],
  toolResults?: ToolResult[],
): AsyncGenerator<LlmStreamEvent> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: false },
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    yield { type: "error", error: `LLM API error (${res.status}): ${err.slice(0, 300)}` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        if (accumulatedToolCalls.size > 0) {
          const calls = Array.from(accumulatedToolCalls.values()).map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.args,
          }));
          yield { type: "tool_call", toolCalls: calls };
        }
        yield { type: "done", finishReason: "stop" };
        return;
      }

      try {
        const parsed = JSON.parse(payload);
        const choice = parsed.choices?.[0];

        if (choice?.finish_reason) {
          if (choice.finish_reason === "tool_calls" && accumulatedToolCalls.size > 0) {
            const calls = Array.from(accumulatedToolCalls.values()).map((c) => ({
              id: c.id,
              name: c.name,
              arguments: c.args,
            }));
            yield { type: "tool_call", toolCalls: calls };
          }
          yield { type: "done", finishReason: choice.finish_reason };
          return;
        }

        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "delta", delta: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let existing = accumulatedToolCalls.get(idx);
            if (!existing) {
              if (!tc.function?.name) continue;
              existing = { id: tc.id ?? "", name: tc.function.name, args: "" };
              accumulatedToolCalls.set(idx, existing);
            }
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          }
        }
      } catch {}
    }
  }

  if (accumulatedToolCalls.size > 0) {
    const calls = Array.from(accumulatedToolCalls.values()).map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.args,
    }));
    yield { type: "tool_call", toolCalls: calls };
  }
  yield { type: "done", finishReason: "stop" };
}

async function* streamAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools?: ModelToolDefinition[],
  toolResults?: ToolResult[],
): AsyncGenerator<LlmStreamEvent> {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const chatMsgs = messages.filter((m) => m.role !== "system").map((m) => {
    if (m.role === "tool") {
      return {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: m.tool_call_id!, content: m.content }],
      };
    }
    if (m.tool_calls) {
      return {
        role: "assistant" as const,
        content: m.tool_calls.map((tc) => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        })),
      };
    }
    return { role: m.role as "user" | "assistant", content: m.content };
  });

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: chatMsgs,
    stream: true,
  };

  if (systemMsgs.length > 0) {
    body.system = systemMsgs.map((m) => ({ type: "text", text: m.content }));
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
  }

  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    yield { type: "error", error: `Anthropic API error (${res.status}): ${err.slice(0, 300)}` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let accumulatedToolCalls: Map<string, { id: string; name: string; args: string }> = new Map();
  let inputJsonBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
        if (currentEvent === "content_block_start" || currentEvent === "content_block_delta") {
          inputJsonBuffer = "";
        }
      } else if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (!payload) continue;

        try {
          const parsed = JSON.parse(payload);

          if (currentEvent === "content_block_start" && parsed.content_block) {
            if (parsed.content_block.type === "tool_use") {
              accumulatedToolCalls.set(parsed.index, {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                args: "",
              });
            }
          } else if (currentEvent === "content_block_delta" && parsed.delta) {
            if (parsed.delta.type === "text_delta" && parsed.delta.text) {
              yield { type: "delta", delta: parsed.delta.text };
            } else if (parsed.delta.type === "input_json_delta" && parsed.delta.partial_json) {
              for (const [idx, tc] of accumulatedToolCalls) {
                if (String(parsed.index) === String(idx)) {
                  tc.args += parsed.delta.partial_json;
                }
              }
            }
          } else if (currentEvent === "message_start") {
          } else if (currentEvent === "message_delta") {
            if (parsed.delta?.stop_reason === "tool_use" || parsed.delta?.stop_reason === "end_turn") {
            }
            if (parsed.delta?.stop_reason === "end_turn" && accumulatedToolCalls.size > 0) {
              const calls = Array.from(accumulatedToolCalls.values()).map((c) => ({
                id: c.id,
                name: c.name,
                arguments: c.args,
              }));
              yield { type: "tool_call", toolCalls: calls };
              accumulatedToolCalls.clear();
            }
          } else if (currentEvent === "message_stop") {
            if (accumulatedToolCalls.size > 0) {
              const calls = Array.from(accumulatedToolCalls.values()).map((c) => ({
                id: c.id,
                name: c.name,
                arguments: c.args,
              }));
              yield { type: "tool_call", toolCalls: calls };
              accumulatedToolCalls.clear();
            }
            yield { type: "done", finishReason: "stop" };
            return;
          }
        } catch {}
      }
    }
  }

  yield { type: "done", finishReason: "stop" };
}

async function* streamGoogle(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools?: ModelToolDefinition[],
  toolResults?: ToolResult[],
): AsyncGenerator<LlmStreamEvent> {
  const contents = messages.filter((m) => m.role !== "system").map((m) => {
    const role = m.role === "assistant" ? "model" : (m.role === "tool" ? "user" : m.role);
    return {
      role,
      parts: [{ text: m.content }],
    };
  });

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: 0.7 },
  };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      functionDeclarations: [{
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters || {},
      }],
    }));
  }

  const res = await fetch(
    `${baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    yield { type: "error", error: `Google API error (${res.status}): ${err.slice(0, 300)}` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;

      try {
        const parsed = JSON.parse(payload);
        const candidate = parsed.candidates?.[0];
        if (!candidate) continue;

        const part = candidate.content?.parts?.[0];
        if (part?.text) {
          yield { type: "delta", delta: part.text };
        }

        if (candidate.finishReason) {
          yield { type: "done", finishReason: candidate.finishReason.toLowerCase() };
          return;
        }
      } catch {}
    }
  }

  yield { type: "done", finishReason: "stop" };
}
