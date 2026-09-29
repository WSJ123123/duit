import { describe, expect, it } from "vitest";
import { ONB_COOKIE, ONB_COOKIE_OPTS, onbCookieValid } from "./onboarding-cookie";

describe("onbCookieValid", () => {
  it("accepts the cookie when it names the current user", () => {
    expect(onbCookieValid("u1", "u1")).toBe(true);
  });

  it("rejects a cookie naming a different user (shared-browser safety)", () => {
    expect(onbCookieValid("u2", "u1")).toBe(false);
  });

  it("rejects a missing cookie", () => {
    expect(onbCookieValid(undefined, "u1")).toBe(false);
  });

  it("rejects an empty cookie value", () => {
    expect(onbCookieValid("", "u1")).toBe(false);
  });
});

describe("cookie constants", () => {
  it("uses the agreed cookie name", () => {
    expect(ONB_COOKIE).toBe("duit_onb");
  });

  it("pins the hardened cookie options", () => {
    expect(ONB_COOKIE_OPTS).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  });
});
