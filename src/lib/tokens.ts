import { createHash, randomBytes } from "node:crypto";

/**
 * API tokens for the iOS Shortcut quick-entry endpoint (spec §6 rev 8).
 * Only the sha-256 hash is ever stored; the raw token is shown once and then
 * exists nowhere but the user's clipboard/Shortcut. Never log the raw token.
 */

/** sha-256 hex of a presented token — used to look up the stored hash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** New token `duit_<base64url 32 random bytes>` plus its storable hash. */
export function generateToken(): { token: string; hash: string } {
  const token = `duit_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}
