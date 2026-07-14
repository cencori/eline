# Arcie Documentation

Arcie is a filesystem-first framework for production agents on Cencori.

## Getting Started

- [Getting Started](getting-started.md) — install, run, add tools, deploy
- [Project Layout](project-layout.md) — filesystem structure
- [API Reference](api-reference.md) — complete reference for all exports
- [Subagents](subagents.md) — delegation and orchestration

## Platform

- [Platform Integration](platform-integration.md) — spec for deploy platforms

## Key Concepts

- **Filesystem-first** — your agent is a directory tree. Tools are `.ts` files in `tools/`, instructions are `instructions.md`, subagents are nested directories.
- **Loader-driven** — at runtime, the loader discovers `tools/`, `subagents/`, `instructions.md`, `sessions/config.ts`, `policies/index.ts` and merges them into a single agent manifest. No registration or import boilerplate needed.
- **Two APIs** — `defineAgent()` for filesystem-loaded agents (declarative config), `createAgent()` for programmatic use (with `generate`/`stream`/`execute`/`getTools`).
- **Cencori-native** — sessions, turns, and streaming run through the Cencori Sessions API. Set `CENCORI_API_KEY` and go.
- **Policy-driven** — guardrails, blocked tools, allowed models, and budgets enforced at runtime via `agent/policies/`.
- **Memory strategies** — `lastN`, `summary`, `keyFacts`, `semantic` recall, plus file-backed working memory as editable `.md` files.
- **Local-first dev** — `arcie dev` starts a Next.js web UI with hot-reload. The built-in LLM server supports OpenAI, Anthropic, Groq, DeepSeek, Mistral, Google, and Together — no Cencori dependency required for development.
