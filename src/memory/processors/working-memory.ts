import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import type { MemoryStore, MemoryProcessor } from "../types";
import type { ToolConfig } from "../../types";

const WORKING_MEMORY_KEY = "__working_memory__";

const DEFAULT_TEMPLATE = `# User Profile

- **Name**:
- **Interests**:
- **Goals**:
- **Preferences**:
`;

const TEMPLATE_SYSTEM_INSTRUCTION = `You have access to a persistent working memory that stores information about the user.
You can read the current working memory below and update it using the \`updateWorkingMemory\` tool.

When the user tells you something about themselves, update the working memory to reflect it.
Use the \`updateWorkingMemory\` tool with \`content\` set to the full updated markdown content.`;

const SCHEMA_SYSTEM_INSTRUCTION = `You have access to a persistent working memory that stores structured data about the user.
You can read the current working memory below and update it using the \`updateWorkingMemory\` tool.

When the user tells you something about themselves, update the working memory to reflect it.
The tool uses merge semantics: send only the fields you want to add or change. Set a field to null to delete it.
Objects are deep-merged. Arrays are replaced entirely.`;

export interface WorkingMemoryConfig {
  enabled?: boolean;
  template?: string;
  schema?: z.ZodType<any>;
  scope?: "thread" | "resource";
  /** Directory to store the working memory .md file. When set, uses file-based
   *  storage instead of the memory store. */
  dir?: string;
}

type WmMode = { type: "template"; template: string } | { type: "schema"; schema: z.ZodType<any> };

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val === null) {
      delete result[key];
    } else if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export const WORKING_MEMORY_SYSTEM_INSTRUCTION = TEMPLATE_SYSTEM_INSTRUCTION;

export class WorkingMemoryProcessor implements MemoryProcessor {
  name = "working-memory";
  private store: MemoryStore;
  private resourceId: string;
  private threadId: string;
  private config: WorkingMemoryConfig;
  private mode: WmMode;
  currentContent: string = "";

  constructor(store: MemoryStore, resourceId: string, threadId: string, config?: WorkingMemoryConfig) {
    this.store = store;
    this.resourceId = resourceId;
    this.threadId = threadId;
    this.config = {
      enabled: true,
      scope: "resource",
      ...config,
    };

    if (this.config.schema) {
      this.mode = { type: "schema", schema: this.config.schema };
    } else {
      this.mode = { type: "template", template: this.config.template ?? DEFAULT_TEMPLATE };
    }
  }

  private key(): string {
    return this.config.scope === "resource" ? this.resourceId : this.threadId;
  }

  private filePath(): string | null {
    if (!this.config.dir) return null;
    return resolve(this.config.dir, `${this.key()}.md`);
  }

  private defaultContent(): string {
    if (this.mode.type === "template") return this.mode.template;
    return JSON.stringify(this.mode.schema.parse({}), null, 2);
  }

  private ensureDir(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
  }

  async loadContent(): Promise<string> {
    const fp = this.filePath();
    if (fp) {
      if (existsSync(fp)) {
        return readFileSync(fp, "utf-8");
      }
      return this.defaultContent();
    }
    const k = this.key();
    const entries = await this.store.load(k, WORKING_MEMORY_KEY);
    if (entries.length === 0) return this.defaultContent();
    const wm = entries.find((e) => e.role === "system");
    return wm?.content ?? this.defaultContent();
  }

  private async saveContent(content: string): Promise<void> {
    const fp = this.filePath();
    if (fp) {
      this.ensureDir(fp);
      writeFileSync(fp, content, "utf-8");
      return;
    }
    const k = this.key();
    await this.store.save(k, WORKING_MEMORY_KEY, [
      { role: "system", content, timestamp: Date.now() },
    ]);
  }

  async processInput(_store: MemoryStore, _resourceId: string, _threadId: string): Promise<string> {
    if (!this.config.enabled) return "";
    this.currentContent = await this.loadContent();
    if (!this.currentContent || this.currentContent === this.defaultContent()) return "";
    const fp = this.filePath();
    const editHint = fp ? ` (edit ${fp} directly)` : "";
    const label = this.mode.type === "schema" ? `## Working Memory${editHint}\n\n\`\`\`json` : `## Working Memory${editHint}`;
    const suffix = this.mode.type === "schema" ? "```" : "";
    return `${label}\n${this.currentContent}${suffix ? `\n${suffix}` : ""}`;
  }

  async processOutput(
    _store: MemoryStore,
    _resourceId: string,
    _threadId: string,
    _input: string,
    _output: string,
    _toolCalls?: { tool: string; input: unknown; output: unknown }[],
  ): Promise<void> {
    // Working memory is updated via tool calls, not automatically
  }

  getSystemInstruction(): string {
    if (!this.config.enabled) return "";
    return this.mode.type === "schema" ? SCHEMA_SYSTEM_INSTRUCTION : TEMPLATE_SYSTEM_INSTRUCTION;
  }

  getToolDefinitions(): Record<string, ToolConfig> {
    if (!this.config.enabled) return {};
    const self = this;

    if (this.mode.type === "schema") {
      return {
        updateWorkingMemory: {
          description: "Update the working memory with new information about the user or conversation. Uses merge semantics: send only the fields to add or change.",
          inputSchema: z.object({
            updates: z
              .record(z.unknown())
              .describe("Partial data to merge into working memory. Objects deep-merge, arrays replace, null deletes."),
          }),
          execute: async (input: unknown) => {
            const { updates } = input as { updates: Record<string, unknown> };
            const raw = await self.loadContent();
            let current: Record<string, unknown>;
            try {
              current = JSON.parse(raw);
            } catch {
              current = {};
            }
            const merged = deepMerge(current, updates);
            const content = JSON.stringify(merged, null, 2);
            await self.saveContent(content);
            return { updated: true };
          },
        },
      };
    }

    // Template mode
    const updateWmSchema = z.object({
      content: z.string().describe("The full updated markdown content for working memory"),
    });

    return {
      updateWorkingMemory: {
        description: "Update the working memory with new content about the user.",
        inputSchema: updateWmSchema,
        execute: async (input: unknown) => {
          const { content } = input as { content: string };
          await self.saveContent(content);
          return { updated: true };
        },
      },
    };
  }
}
