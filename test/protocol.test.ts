import { describe, it, expect } from "vitest";
import {
  createSessionStarted,
  createTurnStarted,
  createMessageReceived,
  createMessageAppended,
  createMessageCompleted,
  createStepCompleted,
  createSessionWaiting,
  createSessionCompleted,
  encodeEvent,
  encodeEvents,
} from "../src/protocol/events";

describe("protocol event constructors", () => {
  it("builds session.started with optional runtime", () => {
    expect(createSessionStarted("sess_1")).toEqual({
      type: "session.started",
      data: { sessionId: "sess_1" },
    });
    const withRuntime = createSessionStarted("sess_1", {
      agentId: "a",
      modelId: "claude-sonnet-4-5",
      zettVersion: "0.1.2",
    });
    expect(withRuntime.data.runtime?.modelId).toBe("claude-sonnet-4-5");
  });

  it("builds turn/message events with the expected shape", () => {
    expect(createTurnStarted(1, "t1").data).toEqual({ sequence: 1, turnId: "t1" });
    expect(createMessageReceived("hi", 1, "t1").data.message).toBe("hi");
    expect(createMessageAppended("ab", "ab", 1, 0, "t1").data.textSoFar).toBe("ab");
    expect(createMessageCompleted("done", "stop", 1, 0, "t1").data.finishReason).toBe("stop");
  });

  it("carries usage on step.completed when provided", () => {
    const ev = createStepCompleted("stop", 1, 0, "t1", { inputTokens: 5, outputTokens: 9 });
    expect(ev.data.usage).toEqual({ inputTokens: 5, outputTokens: 9 });
  });

  it("builds terminal session events", () => {
    expect(createSessionWaiting().data).toEqual({ wait: "next-user-message" });
    expect(createSessionCompleted()).toEqual({ type: "session.completed" });
  });
});

describe("event encoding", () => {
  it("encodeEvent appends a single newline of valid JSON", () => {
    const line = encodeEvent(createTurnStarted(1, "t1"));
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: "turn.started", data: { sequence: 1, turnId: "t1" } });
  });

  it("encodeEvents concatenates one NDJSON line per event", () => {
    const out = encodeEvents([createTurnStarted(1, "t1"), createSessionWaiting()]);
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("turn.started");
    expect(JSON.parse(lines[1]).type).toBe("session.waiting");
  });
});
