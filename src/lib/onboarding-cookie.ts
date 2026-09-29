/**
 * Onboarding cookie-cache: once the session proxy has concluded a user is
 * past first-run onboarding, that fact is cached in a cookie so subsequent
 * authed requests skip the two DB round-trips (settings fetch + account
 * existence check) entirely. The cookie VALUE is the user id it was issued
 * for — see `onbCookieValid`.
 */

export const ONB_COOKIE = "duit_onb";

/** Cookie is trusted only when it names the CURRENT user — a shared browser
 *  must never inherit another user's onboarded state. */
export function onbCookieValid(cookieValue: string | undefined, userId: string): boolean {
  return cookieValue === userId;
}

export const ONB_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
} as const;
