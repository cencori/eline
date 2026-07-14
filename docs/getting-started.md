# Getting Started

## Install

```bash
npx arcie@latest init my-agent
cd my-agent
npm install
```

## Run

```bash
npm run dev
```

Opens `http://localhost:5173` — a web chat UI connected to your agent.

## Add a Tool

Create `agent/tools/get_weather.ts`:

```ts
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

Tools are automatically discovered from the `tools/` directory. No registration needed.

## Add a Subagent

Create `agent/subagents/researcher/agent.ts`:

```ts
import { defineAgent } from "arcie";

export default defineAgent({
  model: "claude-sonnet-4-5",
  description: "Investigate ambiguous questions before responding.",
});
```

The directory name (`researcher`) becomes the tool name the orchestrator uses. Subagents must declare a `description`.

## Configure Memory

Create `agent/sessions/config.ts`:

```ts
export default {
  maxTurns: 50,
  memory: {
    strategy: "lastN",
    limit: 20,
    workingMemory: true,
  },
};
```

Working memory with `workingMemory: true` stores session state as an editable `.md` file in `agent/sessions/`.

## Set Policies

Create `agent/policies/index.ts`:

```ts
export default {
  inputGuards: ["no-email", "no-phone"],
  blockedTools: ["dangerous_tool"],
  allowedModels: ["claude-*", "gpt-4*"],
};
```

## Deploy

```bash
export CENCORI_API_KEY=sk_...

npm run build
```

## Use the Programmatic API

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
console.log(reply); // "Hello, Alice!"
```

## Next steps

- [API Reference](api-reference.md) — complete docs for every export
- [Subagents](subagents.md) — deep dive into delegation patterns
- [Project Layout](project-layout.md) — filesystem reference
