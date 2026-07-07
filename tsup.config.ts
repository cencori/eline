import { defineConfig } from "tsup";

// Entry keys are the output paths (without extension) under dist/, so each one
// lines up exactly with the package.json "exports" map and the "bin" field.
export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "tools/index": "src/tools/index.ts",
    "skills/index": "src/skills/index.ts",
    "instructions/index": "src/instructions/index.ts",
    "hooks/index": "src/hooks/index.ts",
    "channels/index": "src/channels/index.ts",
    "schedules/index": "src/schedules/index.ts",
    "context/index": "src/context/index.ts",
    "agent/index": "src/agent/index.ts",
    "runner/index": "src/runner/index.ts",
    "auth/index": "src/auth/index.ts",
    "discover/index": "src/discover/index.ts",
    "protocol/events": "src/protocol/events.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  experimentalDts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  shims: false,
});
