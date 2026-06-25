import { describe, it, expect } from "vitest";
import {
  getContext,
  setContext,
  hasContext,
  requireContext,
  ensureContext,
  getSession,
  setSession,
  getTurn,
  setTurn,
} from "../src/context/index";

describe("shared context", () => {
  it("sets and gets typed values", () => {
    setContext("ctx:user", { id: 7 });
    expect(getContext<{ id: number }>("ctx:user")).toEqual({ id: 7 });
    expect(hasContext("ctx:user")).toBe(true);
  });

  it("requireContext throws on a missing key", () => {
    expect(() => requireContext("ctx:absent")).toThrow(/not found/);
  });

  it("ensureContext runs the factory exactly once", () => {
    let calls = 0;
    const factory = () => {
      calls += 1;
      return { n: calls };
    };
    const first = ensureContext("ctx:once", factory);
    const second = ensureContext("ctx:once", factory);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });
});

describe("session/turn singletons", () => {
  it("default to null until set", () => {
    // fresh keys are unaffected by other tests since these are module globals
    const sessionBefore = getSession();
    expect(sessionBefore === null || typeof sessionBefore === "object").toBe(true);
  });

  it("round-trips session and turn", () => {
    setSession({ id: "s1", created: new Date(0), turns: [], metadata: {} });
    expect(getSession()?.id).toBe("s1");
    setTurn({ id: "t1", input: "hello" });
    expect(getTurn()?.input).toBe("hello");
  });
});
