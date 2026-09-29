import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRateLimit } from "@/lib/rate-limit";
import { adminClient, makeTestUsers } from "@/db/test-clients";

describe("rate limiting (DB fixed window)", () => {
  it("allows up to the limit within a window, denies past it, allows in a later window", async () => {
    const admin = adminClient();
    const key = `test:${randomUUID()}`;
    const limit = 3;
    const now = "2026-08-16T10:07:01Z";

    for (let i = 0; i < limit; i++) {
      expect(await checkRateLimit(admin, { key, limit, windowSeconds: 60, now })).toBe(true);
    }
    expect(await checkRateLimit(admin, { key, limit, windowSeconds: 60, now })).toBe(false);

    const later = "2026-08-16T10:08:01Z";
    expect(await checkRateLimit(admin, { key, limit, windowSeconds: 60, now: later })).toBe(true);
  });

  it("denies bump_rate_limit rpc to authenticated clients (execute revoked)", async () => {
    const { a } = await makeTestUsers();
    const { error } = await a.rpc("bump_rate_limit", {
      p_key: `test:${randomUUID()}`,
      p_window_start: "2026-08-16T10:07:00Z",
    });
    expect(error).not.toBeNull();
  });
});
