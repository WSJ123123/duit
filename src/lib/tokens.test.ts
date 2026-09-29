import { describe, it, expect } from "vitest";
import { generateToken, hashToken } from "@/lib/tokens";

describe("generateToken", () => {
  it("produces a token starting with duit_", () => {
    const { token } = generateToken();
    expect(token.startsWith("duit_")).toBe(true);
  });

  it("produces a token at least 40 chars long", () => {
    const { token } = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it("produces different tokens on each call", () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });

  it("returns a hash matching hashToken of the same token", () => {
    const { token, hash } = generateToken();
    expect(hashToken(token)).toBe(hash);
  });

  it("returns a hash of exactly 64 lowercase hex chars", () => {
    const { hash } = generateToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashToken", () => {
  it("is stable: same input hashes to the same value", () => {
    expect(hashToken("duit_example")).toBe(hashToken("duit_example"));
  });

  it("differs for different inputs", () => {
    expect(hashToken("duit_one")).not.toBe(hashToken("duit_two"));
  });
});
