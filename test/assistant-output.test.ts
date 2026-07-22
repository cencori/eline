import { describe, expect, it } from "vitest";
import { parseAssistantOutput } from "../templates/web-chat/lib/assistant-output";

describe("parseAssistantOutput", () => {
  it("separates concatenated tool-shaped JSON from the answer", () => {
    const content = [
      JSON.stringify({ query: "Arcie documentation", count: 10 }),
      JSON.stringify({ query: "Arcie getting started" }),
      JSON.stringify({
        results: [
          { url: "https://arcie.io/docs/quickstart", title: "Arcie Quickstart Guide" },
          { url: "https://arcie.io/docs/overview", title: "Arcie Overview" },
        ],
        count: 2,
      }),
      JSON.stringify({
        content: "Arcie Quickstart Guide\n\n```ts\nconst value = { ready: true };\n```",
      }),
      "## Getting started\n\nInstall Arcie with npm.",
    ].join("");

    const parsed = parseAssistantOutput(content, {
      streaming: false,
      hasToolContext: true,
    });

    expect(parsed.text).toBe("## Getting started\n\nInstall Arcie with npm.");
    expect(parsed.artifacts).toHaveLength(4);
    expect(parsed.artifacts[2]).toMatchObject({
      kind: "results",
      label: "Found 2 sources",
      resultCount: 2,
    });
    expect(parsed.artifacts[3]).toMatchObject({
      kind: "document",
      label: "Read source",
      detail: "Arcie Quickstart Guide",
    });
  });

  it("does not reinterpret JSON without tool context", () => {
    const content = '{"query":"example"}';
    expect(parseAssistantOutput(content, {
      streaming: false,
      hasToolContext: false,
    })).toEqual({
      text: content,
      artifacts: [],
      pendingArtifact: false,
    });
  });

  it("hides an incomplete tool artifact while it streams", () => {
    expect(parseAssistantOutput('{"query":"Arc', {
      streaming: true,
      hasToolContext: true,
    })).toEqual({
      text: "",
      artifacts: [],
      pendingArtifact: true,
    });
  });

  it("removes tool-oriented internal chatter between artifacts", () => {
    const content = [
      JSON.stringify({ query: "Arcie" }),
      'We need to call search_docs with query "Arcie".',
      JSON.stringify({ query: "Arcie platform" }),
      "**Quick-start guide**\n\nUse the npm package.",
    ].join("");

    const parsed = parseAssistantOutput(content, {
      streaming: false,
      hasToolContext: true,
    });

    expect(parsed.text).toBe("**Quick-start guide**\n\nUse the npm package.");
    expect(parsed.artifacts).toHaveLength(2);
  });

  it("falls back to the original text for unrecognized objects", () => {
    const content = '{"answer":42}\n\nThe answer is 42.';
    expect(parseAssistantOutput(content, {
      streaming: false,
      hasToolContext: true,
    }).text).toBe(content);
  });
});
