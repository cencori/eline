import type { MemoryStore, MemoryStrategy, MemoryEntry, MemoryProcessor, RecallOptions, RecallResult, Thread, DeleteMessagesOptions } from "./types";
export type { MemoryEntry, MemoryStore, MemoryStrategy, MemoryQuery, Thread, RecallOptions, RecallResult, MemoryProcessor, Embedder, VectorStore, InputProcessor, OutputProcessor, DeleteMessagesOptions } from "./types";
export { InMemoryStore } from "./store";
export { SqliteStore } from "./sqlite-store";
export { FileStore } from "./file-store";
export { CencoriMemoryStore } from "./cencori-store";
export type { CencoriMemoryClient } from "./cencori-store";
export { LastNStrategy } from "./strategies/lastN";
export { KeyFactsStrategy } from "./strategies/keyFacts";
export { SummaryStrategy } from "./strategies/summary";
export type { SummarizeFn } from "./strategies/summary";
export { SemanticRecall } from "./semantic";
export { WorkingMemory, DEFAULT_TEMPLATE, WORKING_MEMORY_SYSTEM_INSTRUCTION } from "./working-memory";
export { MessageHistoryProcessor, WorkingMemoryProcessor, SemanticRecallProcessor } from "./processors/index";
export { StrategyAdapter } from "./processors/strategy-adapter";
export { asUserTurn } from "./multi-user";
export type { Speaker } from "./multi-user";
export type { WorkingMemoryConfig } from "./processors/working-memory";
export type { SemanticRecallConfig } from "./processors/semantic-recall";

import type { SessionConfig, ToolConfig } from "../types";
import { InMemoryStore } from "./store";
import { LastNStrategy } from "./strategies/lastN";
import { KeyFactsStrategy } from "./strategies/keyFacts";
import { SummaryStrategy } from "./strategies/summary";
import { SemanticRecall } from "./semantic";
import { MessageHistoryProcessor, WorkingMemoryProcessor, SemanticRecallProcessor } from "./processors/index";
import { StrategyAdapter } from "./processors/strategy-adapter";
import type { WorkingMemoryConfig } from "./processors/working-memory";
import type { SemanticRecallConfig } from "./processors/semantic-recall";

export interface MemoryOptions {
  store?: MemoryStore;
  resourceId?: string;
  threadId?: string;
  processors?: (MemoryProcessor | MemoryStrategy)[];
  embedder?: import("./types").Embedder;
  vectorStore?: import("./types").VectorStore;
  lastMessages?: number;
  readOnly?: boolean;
  /** When set, working memory is stored as a .md file in this directory
   *  instead of in the memory store. */
  workingMemoryDir?: string;
}

interface BuildConfig {
  type: "config";
  config: SessionConfig["memory"];
  opts: MemoryOptions;
}

interface BuildOptions {
  type: "options";
  opts: MemoryOptions;
}

type BuildSource = BuildConfig | BuildOptions;

export class Memory {
  store: MemoryStore;
  resourceId: string;
  threadId: string;
  private processors: MemoryProcessor[];
  private readOnly: boolean;
  private buildSource: BuildSource;

  constructor(options?: MemoryOptions);
  constructor(config: SessionConfig["memory"], options?: MemoryOptions);
  constructor(configOrOptions?: SessionConfig["memory"] | MemoryOptions, options?: MemoryOptions) {
    let config: SessionConfig["memory"] | undefined;
    let opts: MemoryOptions;

    if (configOrOptions && "store" in configOrOptions) {
      opts = configOrOptions;
      config = undefined;
    } else {
      config = configOrOptions as SessionConfig["memory"];
      opts = options ?? {};
    }

    this.buildSource = config
      ? { type: "config", config, opts }
      : { type: "options", opts };

    this.store = opts.store ?? new InMemoryStore();
    this.resourceId = opts.resourceId ?? "default";
    this.threadId = opts.threadId ?? "default";
    this.readOnly = opts.readOnly ?? false;

    this.processors = [];

    if (opts.processors) {
      for (const p of opts.processors) {
        if ("getInputContext" in p && "recordTurn" in p) {
          this.processors.push(new StrategyAdapter(p as MemoryStrategy));
        } else {
          this.processors.push(p as MemoryProcessor);
        }
      }
    } else if (config) {
      this.buildFromConfig(config, opts);
    } else if (opts.lastMessages) {
      this.processors.push(new MessageHistoryProcessor(opts.lastMessages));
    } else {
      this.processors.push(new MessageHistoryProcessor(10));
    }
  }

  private buildFromConfig(config: SessionConfig["memory"], opts: MemoryOptions): void {
    if (!config) return;
    switch (config.strategy) {
      case "lastN": {
        const strategy = new LastNStrategy(config.limit ?? 10);
        this.processors.push(new StrategyAdapter(strategy));
        break;
      }
      case "summary": {
        const strategy = new SummaryStrategy(config.limit ?? 10);
        this.processors.push(new StrategyAdapter(strategy));
        break;
      }
      case "keyFacts": {
        const strategy = new KeyFactsStrategy();
        this.processors.push(new StrategyAdapter(strategy));
        break;
      }
      case "semantic": {
        if (opts.embedder && opts.vectorStore) {
          this.processors.push(new SemanticRecallProcessor(opts.embedder, opts.vectorStore, {
            topK: config.limit ?? 5,
            scope: "resource",
          }));
        } else {
          const strategy = new SemanticRecall(config.limit ?? 5);
          this.processors.push(new StrategyAdapter(strategy));
        }
        break;
      }
      default:
        this.processors.push(new MessageHistoryProcessor(config.limit ?? 10));
    }

    if (config.workingMemory) {
      this.processors.push(new WorkingMemoryProcessor(this.store, this.resourceId, this.threadId, {
        enabled: true,
        template: config.workingMemoryTemplate,
        scope: "resource",
        dir: opts.workingMemoryDir,
      }));
    }
  }

  /**
   * Create a new Memory instance sharing the same store and configuration
   * but with overridden resourceId, threadId, and/or readOnly.
   * Useful for per-request memory config.
   */
  with(overrides: { resourceId?: string; threadId?: string; readOnly?: boolean }): Memory {
    if (this.buildSource.type === "config") {
      return new Memory(this.buildSource.config, {
        ...this.buildSource.opts,
        resourceId: overrides.resourceId ?? this.resourceId,
        threadId: overrides.threadId ?? this.threadId,
        readOnly: overrides.readOnly ?? this.readOnly,
      });
    }
    return new Memory({
      ...this.buildSource.opts,
      resourceId: overrides.resourceId ?? this.resourceId,
      threadId: overrides.threadId ?? this.threadId,
      readOnly: overrides.readOnly ?? this.readOnly,
    });
  }

  async destroy(): Promise<void> {
    await this.store.close?.();
  }

  async getInputContext(): Promise<string> {
    const parts: string[] = [];
    for (const p of this.processors) {
      const ctx = await p.processInput(this.store, this.resourceId, this.threadId);
      if (ctx) parts.push(ctx);
    }
    return parts.join("\n\n");
  }

  getSystemInstruction(): string {
    const parts: string[] = [];
    for (const p of this.processors) {
      if ("getSystemInstruction" in p) {
        const si = (p as { getSystemInstruction(): string }).getSystemInstruction();
        if (si) parts.push(si);
      }
    }
    return parts.join("\n\n");
  }

  getToolDefinitions(): Record<string, ToolConfig> {
    if (this.readOnly) return {};
    for (const p of this.processors) {
      if ("getToolDefinitions" in p) {
        const tools = (p as { getToolDefinitions(): Record<string, ToolConfig> }).getToolDefinitions();
        if (Object.keys(tools).length > 0) return tools;
      }
    }
    return {};
  }

  async recordTurn(
    input: string,
    output: string,
    toolCalls?: { tool: string; input: unknown; output: unknown }[],
  ): Promise<void> {
    if (this.readOnly) return;
    for (const p of this.processors) {
      if (p.processOutput) {
        await p.processOutput(this.store, this.resourceId, this.threadId, input, output, toolCalls);
      }
    }
  }

  async clear(): Promise<void> {
    await this.store.clear(this.resourceId, this.threadId);
  }

  // ── Thread API ──

  async createThread(thread: Thread): Promise<void> {
    if (!this.store.createThread) throw new Error("Store does not support thread creation");
    await this.store.createThread(thread);
  }

  async getThread(threadId: string, resourceId: string): Promise<Thread | null> {
    if (!this.store.getThread) throw new Error("Store does not support thread retrieval");
    return this.store.getThread(threadId, resourceId);
  }

  async listThreads(resourceId: string): Promise<Thread[]> {
    if (!this.store.listThreads) throw new Error("Store does not support thread listing");
    return this.store.listThreads(resourceId);
  }

  async updateThread(thread: Partial<Thread> & { id: string; resourceId: string }): Promise<void> {
    if (!this.store.updateThread) throw new Error("Store does not support thread updates");
    await this.store.updateThread(thread);
  }

  async deleteThread(threadId: string, resourceId: string): Promise<void> {
    if (!this.store.deleteThread) throw new Error("Store does not support thread deletion");
    await this.store.deleteThread(threadId, resourceId);
  }

  // ── Delete messages ──

  async deleteMessages(opts: DeleteMessagesOptions): Promise<number> {
    if (!this.store.deleteMessages) throw new Error("Store does not support message deletion");
    return this.store.deleteMessages(opts);
  }

  // ── Clone thread ──

  async cloneThread(
    source: { threadId: string; resourceId: string },
    dest: { threadId: string; resourceId: string },
  ): Promise<void> {
    if (!this.store.cloneThread) throw new Error("Store does not support thread cloning");
    await this.store.cloneThread(source, dest);
  }

  // ── Recall API ──

  async recall(opts: RecallOptions): Promise<RecallResult> {
    let entries = await this.store.load(opts.resourceId, opts.threadId);

    if (opts.dateRange) {
      const start = opts.dateRange.start?.getTime() ?? 0;
      const end = opts.dateRange.end?.getTime() ?? Infinity;
      entries = entries.filter((e) => e.timestamp >= start && e.timestamp <= end);
    }

    if (opts.include && opts.include.length > 0) {
      const included: MemoryEntry[] = [];
      for (const inc of opts.include) {
        const idx = entries.findIndex((e) => e.turnId === inc.id);
        if (idx === -1) continue;
        const start = Math.max(0, idx - (inc.withPreviousMessages ?? 0));
        const end = Math.min(entries.length, idx + 1 + (inc.withNextMessages ?? 0));
        for (let i = start; i < end; i++) {
          included.push(entries[i]);
        }
      }
      entries = included;
    }

    if (opts.vectorSearchString && this.store.search) {
      entries = await this.store.search(opts.resourceId, opts.threadId, opts.vectorSearchString);
    }

    const total = entries.length;
    const perPage = opts.perPage ?? 50;
    const page = opts.page ?? 0;
    const start = page * perPage;
    const hasMore = start + perPage < total;

    return {
      messages: entries.slice(start, start + perPage),
      total,
      hasMore,
    };
  }
}
