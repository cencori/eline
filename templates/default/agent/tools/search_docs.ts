import { defineTool } from "arcie";
import { z } from "zod";

const DOCS_ENTRIES: Record<string, string> = {
  "arcie": "Arcie is an agent framework built by Cencori. It is filesystem-first — agents are defined as code in an `agent/` directory with `agent.ts`, `instructions.md`, `tools/`, `subagents/`, and more.",
  "defineAgent": "`defineAgent(config)` validates and returns an agent config. Required fields: `model`. Optional: `name`, `description`, `instructions`, `tools`, `subagents`, `cencori`.",
  "defineTool": "`defineTool(config)` creates a tool with `description`, `inputSchema` (zod), `execute` function, and optional `needsApproval`. The filename becomes the tool name.",
  "defineHook": "`defineHook(config)` creates a lifecycle hook. Events: `onStart`, `onEnd`, `beforeTurn`, `afterTurn`, `beforeToolCall`, `afterToolCall`, `onError`.",
  "defineSchedule": "`defineSchedule(config)` creates a cron-based schedule. Fields: `name`, `cron`, `handler`, `timezone`.",
  "defineConnection": "`defineConnection(config)` creates an OAuth2/API key/basic auth connection for external services.",
  "memory": "Arcie supports memory via `sessions/config.ts`. Strategies: `lastN` (keeps last N turns), `summary` (summarizes old turns), `keyFacts` (extracts key facts), `semantic` (vector recall).",
  "subagents": "Subagents are self-contained child agents in `subagents/<name>/`. Each has its own `agent.ts`, `instructions.md`, and `tools/`. The parent delegates tasks via tool call.",
  "arcie dev": "`arcie dev` starts a local dev server with hot reload. It auto-starts `web/` if scaffolded. Uses Cencori cloud by default, falls back to local provider keys.",
  "arcie init": "`arcie init` scaffolds a new project. `arcie init my-project` creates the directory. Interactive prompts set up the model and API key.",
  "cencori": "Cencori provides the cloud gateway for model inference. Set `CENCORI_API_KEY` in `.env.local`. Supports OpenAI, Anthropic, Groq, DeepSeek, Mistral, Google, and Meta models.",
  "policies": "Policies in `policies/index.ts` enforce `inputGuards`, `outputGuards`, `allowedModels`, `blockedTools`, and budget limits.",
  "channels": "Channels let agents respond via HTTP, Slack, Discord, or custom integrations. Defined in `channels/` directory.",
  "sessions": "Session config in `sessions/config.ts` controls `maxTurns`, `idleTimeoutMs`, `requireApproval`, and `memory` strategy.",
};

export default defineTool({
  description:
    "Search the arcie and Cencori documentation. Use this when the user asks about how arcie works, how to configure something, platform capabilities, or any reference question.",
  inputSchema: z.object({
    query: z.string().describe("The search term or topic to look up in the documentation"),
  }),
  execute: ({ query }) => {
    const normalized = query.toLowerCase().trim();
    const results: Array<{ topic: string; content: string }> = [];

    for (const [topic, content] of Object.entries(DOCS_ENTRIES)) {
      if (topic.includes(normalized) || content.toLowerCase().includes(normalized)) {
        results.push({ topic, content });
      }
    }

    return {
      query,
      count: results.length,
      results: results.length > 0 ? results.slice(0, 5) : [{ topic: "no-match", content: `No documentation found for "${query}". Try a different search term.` }],
    };
  },
});
