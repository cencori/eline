# API Reference

## defineAgent

Validates and returns a plain `AgentConfig` object. Use when your agent lives in `agent/agent.ts` and the framework loads it from the filesystem.

```ts
import { defineAgent } from "arcie";

export default defineAgent({
  model: "claude-sonnet-4-5",
  name: "my-agent",
  description: "Optional description for subagents",
  cencori: {
    billing: { budget: "50.00/month" },
    security: { policy: "standard" },
  },
  instructions: "Inline instructions (optional; filesystem instructions.md wins)",
  tools: { tool_name: { description: "...", execute: async () => {} } },
  subagents: { specialist: { model: "...", description: "...", tools: {...} } },
});
```

### AgentConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string` | required | Model ID (`claude-sonnet-4-5`, `gpt-4o`, `llama-3.3-70b-versatile`) |
| `name` | `string` | `undefined` | Agent name surfaced in observability |
| `description` | `string` | `undefined` | Required for subagents; used by orchestrator for delegation |
| `cencori` | `CencoriConfig` | `undefined` | Cencori cloud settings (billing, security) |
| `instructions` | `string` | `undefined` | Inline instructions; primary agents prefer `instructions.md` |
| `tools` | `Record<string, ToolConfig>` | `{}` | Inline tool map; merged with filesystem `tools/` directory |
| `subagents` | `Record<string, AgentConfig>` | `{}` | Inline subagents; merged with filesystem `subagents/` directory |

### CencoriConfig

```ts
{
  apiKey?: string;        // API key (also read from CENCORI_API_KEY env)
  billing?: {
    budget?: string;           // e.g. "50.00/month"
    endUserMarkup?: number;    // markup multiplier
  };
  security?: {
    policy?: "strict" | "standard" | "permissive";
  };
}
```

---

## createAgent

Returns an `Agent` instance with programmatic `generate`/`stream`/`execute` APIs. Use when you need to control the agent lifecycle in code rather than from the filesystem.

```ts
import { createAgent } from "arcie";

const agent = createAgent({
  model: "gpt-4o",
  tools: {
    get_weather: {
      description: "Get weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temp: 72 }),
    },
  },
});

// Generate a complete response
const text = await agent.generate("What's the weather in Paris?");

// Stream events
for await (const event of agent.stream("Hello!")) {
  if (event.type === "message.appended") {
    process.stdout.write(event.data.delta);
  }
}

// Execute a tool directly
const result = await agent.execute("get_weather", { city: "Tokyo" });

// List available tools
const tools = agent.getTools();
```

### Agent methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `generate` | `(input: string, options?: RunOptions) => Promise<string>` | Complete a single turn, return output text |
| `stream` | `(input: string, options?: RunOptions) => AsyncGenerator<StreamEvent>` | Stream turn events (messages, tool calls, subagent delegations) |
| `execute` | `(name: string, input: unknown) => Promise<unknown>` | Call a tool directly by name |
| `getTools` | `() => Record<string, ToolConfig>` | List all tools on this agent |

### RunOptions

```ts
{
  endpoint?: string;         // Cencori API URL (default: https://cencori.com/api/v1)
  apiKey?: string;           // Cencori API key (default: CENCORI_API_KEY env)
  maxTurns?: number;         // Max tool-call loops (default: 25)
  sessionId?: string;        // Resume or continue an existing session
  resourceId?: string;       // Memory resource identifier
  threadId?: string;         // Memory thread identifier
  memoryStore?: MemoryStore; // Custom memory store
  workingMemoryDir?: string; // Directory for .md working memory files
  onEvent?: (event: StreamEvent) => void;  // Callback for every event
  agentId?: string;          // Load a specific top-level agent file
  hotReload?: boolean;       // Cache-bust imports for dev (arcie dev sets this)
  resume?: { toolCalls: ResumeToolCall[] };  // Resume paused session with approvals
}
```

### RunResult

```ts
{
  output: string;           // Final output text
  turns: TurnContext[];      // Turn history from this run
  events: StreamEvent[];     // All events emitted
  sessionId: string;         // The session that was used
}
```

### ResumeToolCall

```ts
{
  actionId: string;   // The action_id from the tool.started event
  name: string;
  args: unknown;
  approved: boolean;  // true to execute, false to refuse
}
```

---

## defineTool

Defines a tool the agent can call. Tools export a `ToolConfig` with a Zod input schema and an execute function.

```ts
import { defineTool } from "arcie/tools";
import { z } from "zod";

export default defineTool({
  name: "get_weather",              // optional, inferred from filename
  description: "Get current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ temp: z.number() }),  // optional
  sandbox: false,                   // optional, default false
  needsApproval: "never",           // "always" | "once" | "never"
  async execute({ city }) {
    const res = await fetch(`https://api.weather.com/${city}`);
    return res.json();
  },
});
```

### ToolConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | filename | Tool name exposed to the model |
| `description` | `string` | required | What the tool does (model uses this to decide when to call) |
| `inputSchema` | `ZodType` | `undefined` | Zod schema for input validation |
| `outputSchema` | `ZodType` | `undefined` | Zod schema for structured output |
| `sandbox` | `boolean` | `false` | Run in isolated sandbox |
| `needsApproval` | `"always" \| "once" \| "never"` | `"never"` | Approval strategy |
| `execute` | `(input: TInput) => TOutput \| Promise<TOutput>` | required | Implementation |

### toModelOutput

Converts a `ToolConfig` to the OpenAI-compatible tool definition that the Cencori Sessions API expects.

```ts
import { toModelOutput } from "arcie/tools";

const modelDef = toModelOutput("get_weather", myTool);
// → { type: "function", function: { name, description, parameters } }
```

---

## defineInstructions

Loads instructions from a file path or accepts an inline config.

```ts
import { defineInstructions } from "arcie";

// From file path
const instructions = defineInstructions("./path/to/instructions.md");

// Inline
const instructions = defineInstructions({
  content: "You are a helpful assistant.",
});
```

### loadInstructions

Reads `instructions.md` or `instructions.ts` from an agent directory.

```ts
import { loadInstructions } from "arcie";

const config = loadInstructions("/path/to/agent");
// → { content: "...", filePath: "..." } or null
```

---

## defineSkill

Defines a loadable knowledge procedure the agent can reference.

```ts
import { defineSkill } from "arcie";

export default defineSkill({
  name: "company-policy",
  description: "HR policy handbook",
  content: "Vacation policy: 20 days per year...",
});
```

### getSkill

Reads a skill from the `knowledge/` directory by name (supports `.md` and `.ts`).

```ts
import { getSkill } from "arcie";

const skill = getSkill("/path/to/agent", "company-policy");
```

---

## defineHook

Registers a lifecycle hook that fires during agent execution.

```ts
import { defineHook } from "arcie";

// In agent/hooks/logging.ts
export default defineHook({
  name: "logging",
  event: "afterToolCall",
  handler: async ({ toolCall }) => {
    console.log(`Tool ${toolCall?.tool} took ${toolCall?.durationMs}ms`);
  },
});
```

### Hook events

| Event | Payload | Fires |
|-------|---------|-------|
| `onStart` | `{}` | Before turn begins |
| `beforeTurn` | `{ turn }` | Before sending input to model |
| `afterTurn` | `{ turn }` | After turn completes |
| `beforeToolCall` | `{ toolCall }` | Before a tool executes |
| `afterToolCall` | `{ toolCall }` | After a tool executes |
| `onError` | `{ error }` | When an error occurs |
| `onEnd` | `{}` | After session completes (always fires) |

### HookConfig

```ts
{
  name: string;
  event: HookEvent;
  handler: (payload: HookPayload) => void | Promise<void>;
}
```

---

## defineChannel

Defines a message channel for agent ingress (HTTP, Slack, Discord, custom).

```ts
import { defineChannel, POST, GET } from "arcie";

// In agent/channels/webhook.ts
export default defineChannel({
  name: "webhook",
  type: "http",
  handler: POST(async (request) => {
    const { body, headers, method } = request;
    return { status: 200, body: { ok: true } };
  }),
});
```

### ChannelConfig

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Channel identifier |
| `type` | `"http" \| "slack" \| "discord" \| "custom"` | Channel type |
| `handler` | `(req: ChannelRequest) => ChannelResponse \| Promise<ChannelResponse>` | Message handler |

### ChannelRequest / ChannelResponse

```ts
interface ChannelRequest {
  body: unknown;
  headers: Record<string, string>;
  method: string;
}

interface ChannelResponse {
  status: number;
  body: unknown;
}
```

`POST` and `GET` are typed helper wrappers around channel handlers.

---

## defineSchedule

Defines a recurring cron job for the agent.

```ts
import { defineSchedule } from "arcie";

// In agent/schedules/daily-report.ts
export default defineSchedule({
  name: "daily-report",
  cron: "0 9 * * 1-5",
  timezone: "America/New_York",
  handler: async () => {
    console.log("Generating daily report...");
  },
});
```

### startScheduler

Starts a scheduler that polls schedules on an interval and fires matching cron expressions.

```ts
import { startScheduler, type SchedulerHandle } from "arcie";

const handle: SchedulerHandle = startScheduler(
  { "daily-report": scheduleConfig },
  { intervalMs: 60_000 }  // check every 60s
);

// Later:
handle.stop();
```

### cronMatches

Tests whether a cron expression matches a given date.

```ts
import { cronMatches } from "arcie";

cronMatches("0 9 * * 1-5", new Date()); // true if it's 9AM on a weekday
```

### ScheduleConfig

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Schedule identifier |
| `cron` | `string` | 5-field cron expression (`minute hour day month dayOfWeek`) |
| `handler` | `() => void \| Promise<void>` | The job to run |
| `timezone` | `string` | Optional IANA timezone |

---

## defineConnection

Defines an outbound connection with auth configuration (OAuth2, API key, Basic auth).

```ts
import { defineConnection } from "arcie";

// In agent/connections/slack.ts
export default defineConnection({
  name: "slack",
  description: "Slack workspace integration",
  auth: {
    type: "oauth2",
    authorizeUrl: "https://slack.com/oauth/authorize",
    tokenUrl: "https://slack.com/api/oauth.access",
    clientId: process.env.SLACK_CLIENT_ID,
    scopes: ["channels:read", "chat:write"],
  },
});
```

### ConnectionConfig

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Connection identifier |
| `description` | `string` | Human-readable description |
| `auth.type` | `"oauth2" \| "apiKey" \| "basic"` | Authentication type |
| `auth.authorizeUrl` | `string` | OAuth authorize endpoint |
| `auth.tokenUrl` | `string` | OAuth token endpoint |
| `auth.clientId` | `string` | OAuth client ID |
| `auth.scopes` | `string[]` | OAuth scopes |

---

## Memory

The `Memory` class manages conversation history, working memory, and semantic recall. It processes input context before each turn and records output after each turn.

```ts
import { Memory } from "arcie";

// From filesystem config
const memory = new Memory(
  { strategy: "lastN", limit: 20, workingMemory: true },
  { store, resourceId, threadId }
);

// From options only
const memory = new Memory({ lastMessages: 50 });

const context = await memory.getInputContext();  // → string for system prompt
await memory.recordTurn(input, output, toolCalls);
```

### Memory strategies

| Strategy | Class | Description |
|----------|-------|-------------|
| `lastN` | `LastNStrategy` | Keep the last N messages |
| `summary` | `SummaryStrategy` | Summarize older messages when exceeding limit |
| `keyFacts` | `KeyFactsStrategy` | Extract and retain key facts |
| `semantic` | `SemanticRecall` | Vector-similarity retrieval |

### Memory stores

| Store | Class | Description |
|-------|-------|-------------|
| In-memory | `InMemoryStore` | Default, ephemeral |
| SQLite | `SqliteStore` | Persistent SQLite-backed |
| File | `FileStore` | JSON file-backed |
| Cencori | `CencoriMemoryStore` | Cencori cloud-backed |

### Working memory

When `workingMemory: true` is set in session config, the agent maintains a working memory document. By default it's stored in the memory store; set `workingMemoryDir` to store as an editable `.md` file:

```ts
// In agent/sessions/config.ts
export default {
  memory: {
    strategy: "lastN",
    workingMemory: true,
    workingMemoryTemplate: "# Session Notes\n\nKey updates from this conversation:\n",
  },
};
```

Working memory supports custom templates. The `DEFAULT_TEMPLATE` and `WORKING_MEMORY_SYSTEM_INSTRUCTION` are exported from `arcie`.

### Thread API

```ts
await memory.createThread({ id: "thread-1", resourceId: "default", metadata: {} });
const thread = await memory.getThread("thread-1", "default");
const threads = await memory.listThreads("default");
await memory.updateThread({ id: "thread-1", resourceId: "default", metadata: { title: "Updated" } });
await memory.deleteThread("thread-1", "default");
await memory.cloneThread(
  { threadId: "source", resourceId: "default" },
  { threadId: "dest", resourceId: "default" },
);
await memory.deleteMessages({ threadId: "t1", resourceId: "default", before: new Date() });
```

### Recall API

```ts
const result = await memory.recall({
  resourceId: "default",
  threadId: "default",
  dateRange: { start: new Date("2024-01-01"), end: new Date() },
  include: [{ id: "turn-3", withPreviousMessages: 2, withNextMessages: 1 }],
  vectorSearchString: "budget discussion",
  perPage: 50,
  page: 0,
});

// result: { messages: MemoryEntry[], total: number, hasMore: boolean }
```

### Memory.with()

Create a derived Memory instance sharing the same store but with overridden identifiers:

```ts
const perRequest = memory.with({ resourceId: "user-123", threadId: "thread-456" });
```

---

## Policies

Define security policies for your agent in `agent/policies/index.ts`:

```ts
// agent/policies/index.ts
export default {
  inputGuards: ["no-email", "no-phone", "no-ssn", "no-url", "no-code", "max-length:4000", "contains:required-term"],
  outputGuards: ["no-email", "max-length:10000"],
  allowedModels: ["claude-*", "gpt-4*"],
  blockedTools: ["dangerous_tool", "internal_*"],
  budget: {
    maxSpendPerSession: "5.00",
    maxSpendPerDay: "50.00",
    maxSpendPerMonth: "500.00",
  },
};
```

### Guards

Guards are string patterns checked on input and output text:

| Guard | Description |
|-------|-------------|
| `no-email` | Blocks text containing email addresses |
| `no-phone` | Blocks phone numbers |
| `no-ssn` | Blocks social security numbers |
| `no-url` | Blocks URLs |
| `no-code` | Blocks markdown code blocks |
| `max-length:N` | Blocks text exceeding N characters |
| `contains:X` | Requires text to contain substring X |

### blockedTools

Wildcard patterns supported: `dangerous_tool` (exact), `internal_*` (prefix), `*dangerous` (suffix).

### allowedModels

Wildcard patterns supported: `claude-*`, `gpt-4*`, `*turbo`.

---

## Sessions

Configure session behavior in `agent/sessions/config.ts`:

```ts
// agent/sessions/config.ts
export default {
  maxTurns: 50,
  idleTimeoutMs: 300000,  // 5 minutes
  requireApproval: false,
  memory: {
    strategy: "lastN",
    limit: 20,
    workingMemory: true,
    workingMemoryTemplate: "# Custom Template\n",
  },
};
```

### SessionConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTurns` | `number` | `25` | Max tool-call loops per turn |
| `idleTimeoutMs` | `number` | `300000` | Session idle timeout |
| `requireApproval` | `boolean` | `false` | Require approval for all tool calls |
| `memory.strategy` | `"lastN" \| "summary" \| "keyFacts" \| "semantic"` | `"lastN"` | Memory strategy |
| `memory.limit` | `number` | `10` | Strategy-specific limit |
| `memory.workingMemory` | `boolean` | `false` | Enable working memory |
| `memory.workingMemoryTemplate` | `string` | default template | Custom working memory template |

---

## Event protocol

Arcie emits SSE-compatible stream events during agent execution. Each event has a `type` discriminator and a `data` payload.

### Event types

| Event | Description |
|-------|-------------|
| `session.started` | Session created on Cencori |
| `session.completed` | Session ended |
| `session.waiting` | Waiting for next user message |
| `session.failed` | Session error |
| `turn.started` | Turn began |
| `turn.completed` | Turn ended |
| `turn.failed` | Turn error |
| `message.received` | User input received |
| `message.appended` | Token delta from model |
| `message.completed` | Model finished generating |
| `step.started` | Reasoning step began |
| `step.completed` | Reasoning step ended |
| `step.failed` | Step error |
| `reasoning.appended` | Reasoning token delta |
| `reasoning.completed` | Reasoning finished |
| `tool.started` | Tool call initiated |
| `tool.completed` | Tool call finished (`completed`, `failed`, `rejected`, `pending`) |
| `subagent.called` | Subagent delegation started |
| `subagent.completed` | Subagent delegation finished |

### Helper functions

```ts
import {
  createSessionStarted, createTurnStarted, createMessageReceived,
  createMessageAppended, createMessageCompleted, createStepStarted,
  createStepCompleted, createStepFailed, createTurnCompleted,
  createTurnFailed, createSessionFailed, createSessionWaiting,
  createSessionCompleted, createToolCallStarted, createToolCallCompleted,
  createSubagentCalled, createSubagentCompleted,
  createReasoningAppended, createReasoningCompleted,
  encodeEvent, encodeEvents,
} from "arcie";
```

---

## Context

Global context functions for sharing state across agent hooks and tools within a process:

```ts
import {
  getSession, setSession,
  getTurn, setTurn,
  getContext, setContext, hasContext, requireContext, ensureContext,
} from "arcie";

// Session context
const session = getSession();  // → Session | null
setSession({ id: "...", created: new Date(), turns: [], metadata: {} });

// Turn context
const turn = getTurn();  // → TurnContext | null
setTurn({ id: "...", input: "Hello", output: "Hi" });

// Shared key-value context
setContext("db", dbConnection);
const db = requireContext<Database>("db");
const exists = hasContext("db");
const config = ensureContext("config", () => loadConfig());
```

---

## Auth

Helpers for building outbound authentication functions:

```ts
import { bearer, basic } from "arcie";

// Bearer token (static or dynamic)
const auth = bearer("sk-abc123");
const auth = bearer(() => process.env.API_KEY);

// Basic auth
const auth = basic({
  username: "admin",
  password: "secret",
});

// Both return: OutboundAuthFn = () => Promise<{ headers: Record<string, string> }>
const { headers } = await auth();
```

---

## Server

Arcie ships a local LLM inference server with multi-provider support for development. The `handleSessionsRequest` function implements the Cencori Sessions API protocol locally.

### handleSessionsRequest

```ts
import { handleSessionsRequest } from "arcie/server";
import http from "node:http";

const server = http.createServer(async (req, res) => {
  const handled = await handleSessionsRequest(req, res);
  if (!handled) {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(3000);
```

### streamLlm

Low-level async generator that streams tokens from any supported provider:

```ts
import { streamLlm, resolveProviderForModel, getProviderApiKey } from "arcie/server";

for await (const event of streamLlm("gpt-4o", messages, tools)) {
  if (event.type === "delta") process.stdout.write(event.delta);
  if (event.type === "tool_call") handleToolCall(event.toolCalls);
}
```

### Supported providers

| Provider | Model prefix | Env var |
|----------|--------------|---------|
| OpenAI | `gpt-*`, `o*` | `OPENAI_API_KEY` |
| Anthropic | `claude-*` | `ANTHROPIC_API_KEY` |
| Groq | `llama-*`, `qwen`, `gemma-*` | `GROQ_API_KEY` |
| DeepSeek | `deepseek-*` | `DEEPSEEK_API_KEY` |
| Mistral | `mistral-*`, `codestral` | `MISTRAL_API_KEY` |
| Google | `gemini-*` | `GOOGLE_API_KEY` |
| Together | `meta/` prefix | `TOGETHER_API_KEY` |

Models can be specified as `provider/model` (e.g. `openai/gpt-4o`) or bare (e.g. `gpt-4o`), in which case the provider is inferred from the prefix.

---

## Loader

Programmatic agent loading from the filesystem:

```ts
import { loadAgent, loadAgentById, discoverAgents } from "arcie";

// Load the primary agent (agent.ts + siblings)
const agent = await loadAgent("./my-agent", { hotReload: true });

// Load by id (loadAgentById dispatches to loadAgent for "agent" or loadInlineAgent for others)
const researcher = await loadAgentById("./my-agent", "researcher");

// Discover all top-level agents
const agents = discoverAgents("./my-agent");
// → [{ id: "agent", filePath: "/abs/path/agent.ts" }, { id: "researcher", filePath: ... }]
```

### LoadedAgent

```ts
{
  id: string;                    // "agent" for primary, filename for inline
  agentDir: string;              // Absolute path to agent directory
  manifest: AgentManifest;       // Fully resolved agent manifest
}
```

### AgentManifest

The fully resolved agent, merging filesystem directories with inline config:

```ts
{
  config: AgentConfig;
  instructions: string;
  tools: Record<string, ToolConfig>;
  skills: Record<string, SkillConfig>;
  hooks: Record<string, HookConfig>;
  channels: Record<string, ChannelConfig>;
  schedules: Record<string, ScheduleConfig>;
  connections: Record<string, ConnectionConfig>;
  subagents: Record<string, SubagentManifest>;
  session?: SessionConfig;
  policy?: PolicyConfig;
}
```

---

## Discover

Scans an agent directory and reports its structure and diagnostics:

```ts
import { discoverAgent } from "arcie";

const result = discoverAgent("./my-agent");
// → { agent: DiscoveredAgent, diagnostics: DiscoverDiagnostic[] }

result.agent.tools         // → DiscoveredSlot[]
result.agent.subagents     // → DiscoveredSubagent[]
result.diagnostics         // → warnings and errors (INVALID_SLOT_NAME, SUBAGENT_MISSING_CONFIG, etc.)
```

---

## Runner

Low-level execution of agent turns:

```ts
import { runAgent, streamAgent } from "arcie";

// Collect all events into a result
const result = await runAgent("./my-agent", "Hello!", {
  sessionId: "existing-session-id",
  onEvent: (event) => console.log(event.type),
});

// Stream events directly
for await (const event of streamAgent("./my-agent", "Hello!")) {
  if (event.type === "message.appended") {
    process.stdout.write(event.data.delta);
  }
}
```

### streamLoadedAgent

Internal function that streams events from an already-loaded `LoadedAgent` without re-reading the filesystem. Used by `createAgent().stream()`.

```ts
import { streamLoadedAgent } from "arcie/runner";  // internal, not in public API
```
