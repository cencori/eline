import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantOutput } from "../lib/assistant-output.ts";

test("keeps every meaningful artifact and removes the internal JSON prefix", () => {
  const content = [
    '{"files":["README.md","docs","src"]}',
    '{"query":"Arcie"}',
    '{"query":"Arcie","count":10}',
    '{"query":"Arcie","count":10,"results":[{"topic":"Overview","content":"Arcie docs"}]}',
    '{"path":""}',
    '{"path":".","pattern":"Arcie Quick Start"}',
    '{"url":"https://arcie.dev/docs"}',
    "# Getting Started with Arcie\n\nInstall the SDK.",
  ].join("");

  const parsed = parseAssistantOutput(content, { streaming: false, hasToolContext: true });

  assert.equal(parsed.text, "# Getting Started with Arcie\n\nInstall the SDK.");
  assert.deepEqual(parsed.artifacts.map(({ kind, label, detail }) => ({ kind, label, detail })), [
    { kind: "document", label: "Found 3 files", detail: "README.md, docs, src" },
    { kind: "query", label: "Prepared search", detail: "Arcie" },
    { kind: "results", label: "Found 10 sources", detail: "Arcie" },
    { kind: "results", label: "Found 10 sources", detail: "Arcie" },
    { kind: "document", label: "Searched files", detail: "Arcie Quick Start" },
    { kind: "source", label: "Opened source", detail: "https://arcie.dev/docs" },
  ]);
});

test("consumes file listings, selected paths, and document contents", () => {
  const content = [
    '{"files":["getting_started.md","configuration.md"]}',
    '{"path":"docs/getting_started.md"}',
    '{"content":"# Getting Started\\n\\nInstall Arcie."}',
    "## Quick start\n\nUse npm to install Arcie.",
  ].join("");

  const parsed = parseAssistantOutput(content, { streaming: false, hasToolContext: true });

  assert.equal(parsed.text, "## Quick start\n\nUse npm to install Arcie.");
  assert.deepEqual(parsed.artifacts.map(({ label }) => label), [
    "Found 2 files",
    "Searched files",
    "Read source",
  ]);
});

test("preserves collected artifacts before an unrelated JSON answer", () => {
  const parsed = parseAssistantOutput('{"query":"Arcie"}{"answer":42}', {
    streaming: false,
    hasToolContext: true,
  });

  assert.equal(parsed.text, '{"answer":42}');
  assert.equal(parsed.artifacts.length, 1);
});

test("hides an incomplete internal object while streaming", () => {
  const parsed = parseAssistantOutput('{"query":"Arcie"}{"path":', {
    streaming: true,
    hasToolContext: true,
  });

  assert.equal(parsed.text, "");
  assert.equal(parsed.pendingArtifact, true);
  assert.equal(parsed.artifacts.length, 1);
});

test("does not rewrite standalone JSON answers", () => {
  const content = '{"answer":42}';
  const parsed = parseAssistantOutput(content, { streaming: false, hasToolContext: true });

  assert.equal(parsed.text, content);
  assert.deepEqual(parsed.artifacts, []);
});

test("does nothing without tool context", () => {
  const content = '{"query":"Arcie"}Visible answer';
  const parsed = parseAssistantOutput(content, { streaming: false, hasToolContext: false });

  assert.equal(parsed.text, content);
  assert.deepEqual(parsed.artifacts, []);
});
