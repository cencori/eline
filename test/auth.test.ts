import { describe, it, expect } from "vitest";
import { bearer, basic } from "../src/auth/index";

describe("bearer", () => {
  it("resolves a static token", async () => {
    const { headers } = await bearer("tok123")();
    expect(headers.authorization).toBe("Bearer tok123");
  });
  it("resolves a sync function token", async () => {
    const { headers } = await bearer(() => "fn-tok")();
    expect(headers.authorization).toBe("Bearer fn-tok");
  });
  it("resolves an async function token", async () => {
    const { headers } = await bearer(async () => "async-tok")();
    expect(headers.authorization).toBe("Bearer async-tok");
  });
});

describe("basic", () => {
  it("base64-encodes username:password", async () => {
    const { headers } = await basic({ username: "user", password: "pass" })();
    expect(headers.authorization).toBe(`Basic ${btoa("user:pass")}`);
  });
  it("supports a dynamic password", async () => {
    const { headers } = await basic({ username: "u", password: async () => "p" })();
    expect(headers.authorization).toBe(`Basic ${btoa("u:p")}`);
  });
});
