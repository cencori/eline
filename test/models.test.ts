import { describe, it, expect } from "vitest";
import { cencori } from "../src/models";

describe("cencori(slug)", () => {
  it("returns the slug as-is for bare names", () => {
    expect(cencori("gemini-3.1-pro")).toBe("gemini-3.1-pro");
  });

  it("returns provider-qualified slugs unchanged", () => {
    expect(cencori("google/gemini-3.1-pro")).toBe("google/gemini-3.1-pro");
  });

  it("throws on empty string", () => {
    expect(() => cencori("")).toThrow(/non-empty string/);
  });

  it("throws on non-string input", () => {
    expect(() => cencori(undefined as unknown as string)).toThrow(/non-empty string/);
    expect(() => cencori(null as unknown as string)).toThrow(/non-empty string/);
  });
});
