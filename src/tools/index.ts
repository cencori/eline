import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolConfig } from "../types";

export function defineTool<TInput = unknown, TOutput = unknown>(
  config: ToolConfig<TInput, TOutput>
): ToolConfig<TInput, TOutput> {
  if (!config.description) {
    throw new Error("Tool must have a description");
  }
  if (!config.execute) {
    throw new Error("Tool must have an execute function");
  }
  return config;
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toModelOutput(name: string, tool: ToolConfig): ModelToolDefinition {
  // Cencori's Sessions API (and its provider layer) expects OpenAI
  // chat-completions tool shape: { type, function: { name, description,
  // parameters } }. A flat { name, input_schema } tool is silently dropped.
  return {
    type: "function",
    function: {
      name,
      description: tool.description,
      parameters: tool.inputSchema
        ? (zodToJsonSchema(tool.inputSchema, { target: "openApi3" }) as Record<string, unknown>)
        : { type: "object", properties: {} },
    },
  };
}
