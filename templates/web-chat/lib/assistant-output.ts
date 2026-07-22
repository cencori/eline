export interface AssistantSource {
  title: string;
  url: string;
}

export interface AssistantArtifact {
  kind: "query" | "results" | "source" | "document";
  label: string;
  detail?: string;
  resultCount?: number;
  sources?: AssistantSource[];
}

export interface ParsedAssistantOutput {
  text: string;
  artifacts: AssistantArtifact[];
  pendingArtifact: boolean;
}

interface ParseOptions {
  streaming: boolean;
  hasToolContext: boolean;
}

type JsonObjectResult =
  | { status: "complete"; end: number; value: Record<string, unknown> }
  | { status: "incomplete" }
  | { status: "invalid" };

function readJsonObject(input: string, start: number): JsonObjectResult {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const character = input[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(input.slice(start, index + 1)) as unknown;
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return { status: "invalid" };
          }
          return {
            status: "complete",
            end: index + 1,
            value: value as Record<string, unknown>,
          };
        } catch {
          return { status: "invalid" };
        }
      }
    }
  }

  return { status: "incomplete" };
}

function extractSources(value: unknown): AssistantSource[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== "string") return [];
    return [{
      title: typeof record.title === "string" ? record.title : record.url,
      url: record.url,
    }];
  });
}

function toArtifact(value: Record<string, unknown>): AssistantArtifact | undefined {
  const query = typeof value.query === "string" ? value.query : undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  const pattern = typeof value.pattern === "string" ? value.pattern : undefined;
  const files = Array.isArray(value.files)
    ? value.files.filter((entry): entry is string => typeof entry === "string")
    : [];
  const sources = extractSources(value.results);
  const count = typeof value.count === "number" ? value.count : sources.length;

  if (query && Array.isArray(value.results)) {
    return {
      kind: "results",
      label: count === 0 ? "No documentation match" : `Found ${count} source${count === 1 ? "" : "s"}`,
      detail: query,
      resultCount: count,
      sources,
    };
  }

  if (query && typeof value.count === "number") {
    return {
      kind: "results",
      label: count === 0 ? "No documentation match" : `Found ${count} source${count === 1 ? "" : "s"}`,
      detail: query,
      resultCount: count,
    };
  }

  if (query) {
    return {
      kind: "query",
      label: "Prepared search",
      detail: query,
    };
  }

  if (pattern || path?.trim()) {
    return {
      kind: "document",
      label: "Searched files",
      detail: pattern || path,
    };
  }

  if (files.length > 0) {
    return {
      kind: "document",
      label: `Found ${files.length} file${files.length === 1 ? "" : "s"}`,
      detail: files.slice(0, 3).join(", "),
    };
  }

  if (Array.isArray(value.results)) {
    return {
      kind: "results",
      label: `Found ${count} source${count === 1 ? "" : "s"}`,
      resultCount: count,
      sources,
    };
  }

  if (typeof value.url === "string" && typeof value.content !== "string") {
    return {
      kind: "source",
      label: "Opened source",
      detail: value.url,
      sources: [{ title: value.url, url: value.url }],
    };
  }

  if (typeof value.content === "string") {
    const firstLine = value.content.split("\n").find((line) => line.trim().length > 0);
    return {
      kind: "document",
      label: "Read source",
      detail: firstLine?.slice(0, 120),
    };
  }

  return undefined;
}

function isInternalArtifactObject(value: Record<string, unknown>): boolean {
  return ["query", "results", "url", "content", "path", "pattern", "matches", "files"].some(
    (key) => Object.hasOwn(value, key),
  );
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;
  return cursor;
}

function isInternalArtifactBridge(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return true;
  return /^(?:we|i|let(?:'s| us)|need to|calling|searching)\b/i.test(text) &&
    /\b(?:call|tool|search|query|docs?|fetch|look up)\b/i.test(text);
}

export function parseAssistantOutput(
  content: string,
  { streaming, hasToolContext }: ParseOptions,
): ParsedAssistantOutput {
  if (!hasToolContext) {
    return { text: content, artifacts: [], pendingArtifact: false };
  }

  let cursor = skipWhitespace(content, 0);
  if (content[cursor] !== "{") {
    return { text: content, artifacts: [], pendingArtifact: false };
  }

  const artifacts: AssistantArtifact[] = [];
  let consumedInternalObject = false;

  while (cursor < content.length) {
    if (content[cursor] !== "{") {
      const nextObject = content.indexOf("{", cursor);
      const bridge = content.slice(cursor, nextObject === -1 ? content.length : nextObject);

      if (!isInternalArtifactBridge(bridge)) break;
      if (nextObject === -1) {
        cursor = content.length;
        break;
      }
      cursor = nextObject;
    }

    const parsed = readJsonObject(content, cursor);

    if (parsed.status === "incomplete") {
      if (streaming || consumedInternalObject) {
        return { text: "", artifacts, pendingArtifact: streaming };
      }
      return { text: content, artifacts: [], pendingArtifact: false };
    }

    if (parsed.status === "invalid") {
      break;
    }

    const artifact = toArtifact(parsed.value);
    if (!artifact && !isInternalArtifactObject(parsed.value)) break;

    consumedInternalObject = true;
    if (artifact) artifacts.push(artifact);
    cursor = skipWhitespace(content, parsed.end);
  }

  if (!consumedInternalObject) {
    return { text: content, artifacts: [], pendingArtifact: false };
  }

  return {
    text: content.slice(cursor).trimStart(),
    artifacts,
    pendingArtifact: streaming && cursor >= content.length,
  };
}
