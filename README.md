# Arcie

The electronic line — build agents at the speed of light.

> Site: [cencori.com/arcie](https://cencori.com/arcie) · Docs: [cencori.com/arcie/docs](https://cencori.com/arcie/docs)

```
npx arcie@latest init my-agent
```

```
my-agent/
├── agent/
│   ├── agent.ts           # model + config
│   ├── instructions.md    # system prompt
│   ├── tools/             # what it can do
│   ├── knowledge/         # what it knows
│   ├── subagents/         # who it delegates to
│   ├── channels/          # HTTP, Slack, WhatsApp
│   ├── schedules/         # recurring jobs
│   ├── sessions/          # memory + session config
│   └── policies/          # guardrails, budgets, security
├── web/                   # chat UI (Next.js)
├── package.json
└── tsconfig.json
```

## Quick Start

```bash
npx arcie@latest init my-agent
cd my-agent
npm run dev
```

Opens a web chat UI at `http://localhost:5173`.

## Authoring

```ts
// agent/agent.ts
import { defineAgent } from "arcie";

export default defineAgent({
  model: "claude-sonnet-4-5",
  cencori: {
    billing: { budget: "50.00/month" },
  },
});
```

```ts
// agent/tools/get_weather.ts
import { defineTool } from "arcie/tools";
import { z } from "zod";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
```

## Programmatic API

```ts
import { createAgent } from "arcie";

const agent = createAgent({
  model: "gpt-4o",
  tools: {
    greet: {
      description: "Greet someone",
      execute: ({ name }) => `Hello, ${name}!`,
    },
  },
});

const reply = await agent.generate("Say hi to Alice");
```

## Subagents

Drop a specialist under `agent/subagents/<id>/`:

```
agent/subagents/researcher/
├── agent.ts          # defineAgent({ model, description })
├── instructions.md   # optional
└── tools/            # optional
```

Each subagent runs in a **fresh, isolated session** — the parent never sees the child's history. See [docs/subagents.md](docs/subagents.md).

## Memory & Policies

```ts
// agent/sessions/config.ts
export default {
  maxTurns: 50,
  memory: { strategy: "lastN", limit: 20, workingMemory: true },
};
```

```ts
// agent/policies/index.ts
export default {
  inputGuards: ["no-email", "no-phone"],
  blockedTools: ["dangerous_tool"],
  allowedModels: ["claude-*", "gpt-4*"],
};
```

## Docs

- [Getting Started](docs/getting-started.md)
- [API Reference](docs/api-reference.md)
- [Project Layout](docs/project-layout.md)
- [Subagents](docs/subagents.md)

## License

MIT
