# Platform integration spec: arcie as a first-class deploy framework

Audience: deploy platform teams (Pxxl, Brimble, and any future partner).

Arcie is a filesystem-first AI agent framework built on the Cencori AI Gateway. Every arcie project is a small, uniform tree: an `agent/` runtime, one or more sibling `apps/*` (today: a Next.js `web/`), and an `arcie.json` at the root that declares the layout. Users scaffold projects with `npx arcie@latest my-agent`, develop with `arcie dev`, and — with your integration — deploy with a single click from your dashboard or one command from arcie's CLI.

This document specifies exactly what your platform needs to add to detect and deploy arcie projects. The engineering work on your side is small; the marketing benefit is that every new arcie project ships on your platform by default.

## Detection

An imported repository should be detected as an arcie project when **any** of the following are true, in priority order:

1. **`arcie.json` exists at the repo root.** Definitive. Read the file for exact deploy settings; ignore signals 2 and 3.
2. **`arcie` appears in `package.json` dependencies.** Cheap regex check. Use your default arcie preset (see below).
3. **`agent/agent.ts` exists at the repo root.** Structural fallback. Use your default arcie preset.

If (1) is present, it wins. If only (2) or (3), fall back to the preset with defaults matching the schema below.

## `arcie.json` — the source of truth

Ships in every scaffolded arcie project. Full schema:

```json
{
  "$schema": "https://arcie.dev/schema/arcie.json",
  "framework": "arcie",
  "version": 1,

  "agent": {
    "dir": "./agent",
    "entry": "./agent/agent.ts"
  },

  "apps": {
    "web": {
      "dir": "./web",
      "framework": "nextjs",
      "installCommand": "npm install",
      "buildCommand": "npm run build",
      "startCommand": "npm start",
      "env": ["CENCORI_API_KEY"]
    }
  },

  "deploy": {
    "default": "web",
    "stage": {
      "./agent": "./web/agent"
    }
  }
}
```

Field semantics:

- **`agent.dir`** — the runtime lives here. Contains `agent.ts`, `tools/`, `subagents/`, `channels/` (non-web integrations like Slack, WhatsApp), and other filesystem-first configuration.
- **`apps`** — a map of deployable applications. Today the only entry is `web`; future arcie versions may add `dashboard`, `landing`, etc. Each app is a self-contained subtree with its own framework and build commands.
- **`apps.*.env`** — the environment variables this app requires. Your dashboard should prompt for these on first deploy.
- **`deploy.default`** — which app ships when a user clicks "Deploy" or runs `arcie deploy` with no arg.
- **`deploy.stage`** — a pre-build hook. Map of `source → destination` paths, all relative to repo root. Copy each source into each destination before the app's build runs. This is how Next.js file tracing sees `agent/` even though it lives outside `web/`.

## Preset build settings

When you detect an arcie project (any of the three signals), configure the build with these values, either from `arcie.json` if present or from these defaults:

| Setting | Value |
|---|---|
| Base directory | `./web` (from `arcie.json` `apps.web.dir`) |
| Pre-build step | Copy `./agent` → `./web/agent` (from `arcie.json` `deploy.stage`) |
| Install command | `npm install` at repo root, then `npm install` in `./web` |
| Build command | `npm run build` in `./web` |
| Start command | `npm start` in `./web` |
| Port | `$PORT` (Next.js reads it automatically) |
| Bind | `0.0.0.0` (Next.js handles) |
| Required env | `CENCORI_API_KEY` (secret) |

Root install picks up shared dev tooling (`typescript`, etc.). The `./web` install pulls Next.js and the `arcie` runtime the API route calls. The stage step is critical — without it, Next's file tracing skips `./agent` and the deployed app can't load the agent runtime.

## What arcie provides on our side

- **`arcie init`** ships every project with `arcie.json` at the root, `agent/agent.ts`, and `web/` as a Next.js app. Detection works from day one.
- **`arcie deploy`** presents a picker (Pxxl / Brimble), launches your platform's login flow, syncs `.env.local` into your encrypted env store, and triggers a deploy. Users never leave the terminal.
- **Framework picker parity.** If your platform lists frameworks in its "New Project" UI, arcie should appear alongside Next.js, Nuxt, and the rest. The arcie logo and a one-line description are provided on request.

## The reciprocal ask

We list your platform in the `arcie deploy` picker. You list arcie in your framework picker. Users flowing through either surface land on both brands.

Concretely:

1. Ship the detection rules and preset above.
2. Add "arcie" to your public framework list on the marketing site and in-product picker.
3. Publish a short deploy guide: *"Deploying arcie agents on \<your platform\>"*.
4. Link back from your docs when relevant.

Arcie in exchange:

1. Ships your platform as a first-class target in `arcie deploy` (alongside the other partner).
2. References your platform in the arcie docs' *Deployment* section.
3. Coordinates launch: joint announcement, cross-posted on both blogs.

## Questions or ready to ship

Reach out to Roy at Cencori. Preset schema and logo assets available on request. Once the preset is live on your side, arcie will list you in the next patch release.
