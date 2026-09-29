import { describe, expect, it } from "vitest";
import { clientIp, windowStart } from "@/lib/rate-limit";

describe("windowStart", () => {
  it("floors mid-minute to the minute for a 60s window", () => {
    expect(windowStart("2026-08-16T10:07:31Z", 60)).toBe("2026-08-16T10:07:00.000Z");
  });

  it("floors to the 300s window boundary", () => {
    expect(windowStart("2026-08-16T10:04:59Z", 300)).toBe("2026-08-16T10:00:00.000Z");
  });
});

describe("clientIp", () => {
  it("takes the first x-forwarded-for entry", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(clientIp(headers)).toBe("1.2.3.4");
  });

  it("falls back to 'local' when the header is absent", () => {
    expect(clientIp(new Headers())).toBe("local");
  });
});
