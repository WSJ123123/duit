import { describe, it, expect } from "vitest";
import { adminClient } from "@/db/test-clients";
import { checkRateLimit, LOGIN_RATE_LIMIT } from "@/lib/rate-limit";

describe("login rate limit wiring constants", () => {
  it("allows exactly LOGIN_RATE_LIMIT.limit attempts per window, then denies", async () => {
    const admin = adminClient();
    const key = `login-test:${crypto.randomUUID()}`;
    const now = "2026-08-16T10:02:00Z";
    for (let i = 0; i < LOGIN_RATE_LIMIT.limit; i++) {
      expect(await checkRateLimit(admin, { key, ...LOGIN_RATE_LIMIT, now })).toBe(true);
    }
    expect(await checkRateLimit(admin, { key, ...LOGIN_RATE_LIMIT, now })).toBe(false);
  });
  it("a later window allows again", async () => {
    const admin = adminClient();
    const key = `login-test:${crypto.randomUUID()}`;
    for (let i = 0; i <= LOGIN_RATE_LIMIT.limit; i++) {
      await checkRateLimit(admin, { key, ...LOGIN_RATE_LIMIT, now: "2026-08-16T10:02:00Z" });
    }
    expect(
      await checkRateLimit(admin, { key, ...LOGIN_RATE_LIMIT, now: "2026-08-16T10:07:01Z" })
    ).toBe(true);
  });
});
