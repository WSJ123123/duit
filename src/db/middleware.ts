import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ONB_COOKIE, ONB_COOKIE_OPTS, onbCookieValid } from "@/lib/onboarding-cookie";

// Paths never subject to the first-run onboarding redirect: the onboarding
// wizard itself (avoids a redirect loop — this is the simplest place to know
// the current path, since Server Component layouts have no pathname of
// their own), auth/logout, and API routes (token-authed, not browser nav).
const ONBOARDING_EXEMPT_PREFIXES = ["/onboarding", "/login", "/logout", "/api"];

/**
 * Canonical @supabase/ssr session-refresh middleware.
 * Refreshes the auth token cookie on every matched request so server
 * components always see a fresh session. No auth-gating here — pages
 * guard themselves with requireUser().
 *
 * Also carries the Task 15 first-run onboarding redirect: signed-in users
 * with no `onboarded_at` AND zero accounts get sent to /onboarding. Both
 * conditions must hold — a pre-wizard user who already has data (e.g.
 * seeded before this feature existed) must not get trapped. Middleware is
 * the chosen mechanism (over the shared `(app)/layout.tsx`) because it's
 * the only place that trivially knows the request path, which is exactly
 * what's needed to avoid redirecting away from /onboarding itself.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not run code between client creation and getUser() —
  // this call refreshes the session and writes updated cookies.
  const { data } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const exempt = ONBOARDING_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Cookie-cache (Plan 3 Task 3): once a user is known to be past
  // onboarding, a cookie whose VALUE is that user's id short-circuits both
  // DB checks on every subsequent request. The value check is the
  // shared-browser guard — another user in the same cookie jar never
  // inherits it. Cleared on logout; also set by the wizard's completion
  // action so the very next request already skips.
  if (data.user && !exempt && !onbCookieValid(request.cookies.get(ONB_COOKIE)?.value, data.user.id)) {
    const [{ data: settingsRow }, { data: accountRows }] = await Promise.all([
      supabase.from("user_settings").select("onboarded_at").maybeSingle(),
      supabase.from("accounts").select("id").limit(1),
    ]);
    const onboarded = !!settingsRow?.onboarded_at;
    const hasAccounts = (accountRows?.length ?? 0) > 0;
    if (!onboarded && !hasAccounts) {
      const url = request.nextUrl.clone();
      url.pathname = "/onboarding";
      return NextResponse.redirect(url);
    }
    // Checks passed — cache the conclusion. `response` is the object
    // actually returned (reassigned by setAll on session refresh, so this
    // runs after getUser() and reads the current binding).
    response.cookies.set(ONB_COOKIE, data.user.id, ONB_COOKIE_OPTS);
  }

  return response;
}
