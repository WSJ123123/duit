import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMasked } from "@/test/render-money";

// The Sidebar reads the pathname for its active row; stubbed so the whole
// sidebar renders outside an App Router context (Plan 9 ruling 5's order test).
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

const { Sidebar, SidebarFooter, SidebarLogout } = await import("@/app/(app)/Sidebar");

/**
 * Ruling 7: the desktop sidebar's footer Logout posts to the EXISTING
 * `/logout` route handler with the same form the More page uses — no new
 * route and no client-side sign-out call. The Sidebar itself is a client
 * component with `usePathname` and cannot render outside an App Router
 * context, so the footer row is its own presentational component and this is
 * the test named by the ruling ("the form's action is /logout and method is
 * post").
 */
const markup = (collapsed: boolean) =>
  renderToStaticMarkup(createElement(SidebarLogout, { collapsed }));

describe("ruling 7 — sidebar footer Logout", () => {
  it("posts to the existing /logout route handler", () => {
    const html = markup(false);
    expect(html).toContain('action="/logout"');
    expect(html).toContain('method="post"');
    expect(html).toContain('type="submit"');
  });

  it("expanded: renders the v7 §11 icon and the word Logout", () => {
    const html = markup(false);
    // The exact path v7 §11 draws — the mockup is the binding rendering.
    expect(html).toContain(
      "M6 2.5H3.5A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5H6M10 11l3-3-3-3M13 8H6",
    );
    expect(html).toContain(">Logout<");
  });

  it("collapsed: icon only, with title=Logout", () => {
    const html = markup(true);
    expect(html).toContain('title="Logout"');
    expect(html).not.toContain(">Logout<");
    expect(html).toContain('action="/logout"');
  });

  it("keeps the critical colour in both states (v7 §11)", () => {
    expect(markup(false)).toContain("var(--critical)");
    expect(markup(true)).toContain("var(--critical)");
  });
});

/**
 * Plan 9 ruling 5 (mockup v8 §14): the footer gains the `Hide amounts` /
 * `Show amounts` row BETWEEN the email line and Logout; collapsed, it is
 * icon-only with `title` (+ `aria-label`), the same treatment as Logout.
 */
describe("ruling 5 — sidebar footer amounts row", () => {
  const EMAIL = "e2e@test.local";

  it("expanded: email line, then Hide amounts, then Logout, then Collapse", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { userEmail: EMAIL }));
    const email = html.indexOf(EMAIL);
    const amounts = html.indexOf(">Hide amounts<");
    const logout = html.indexOf(">Logout<");
    const collapse = html.indexOf(">Collapse<");
    expect(email).toBeGreaterThan(-1);
    expect(amounts).toBeGreaterThan(email);
    expect(logout).toBeGreaterThan(amounts);
    expect(collapse).toBeGreaterThan(logout);
  });

  it("expanded, amounts hidden: the row reads Show amounts", () => {
    const html = renderMasked(createElement(SidebarFooter, { userEmail: EMAIL, collapsed: false }));
    expect(html).toContain(">Show amounts<");
    expect(html).not.toContain(">Hide amounts<");
  });

  it("collapsed: the amounts row is icon-only with title + aria-label, before Logout's title", () => {
    const html = renderToStaticMarkup(createElement(SidebarFooter, { userEmail: EMAIL, collapsed: true }));
    expect(html).toContain('title="Hide amounts"');
    expect(html).toContain('aria-label="Hide amounts"');
    expect(html).not.toContain(">Hide amounts<");
    expect(html).not.toContain(EMAIL);
    expect(html).toContain("<svg");
    expect(html.indexOf('title="Hide amounts"')).toBeLessThan(html.indexOf('title="Logout"'));
  });

  it("collapsed, amounts hidden: title and aria-label read Show amounts", () => {
    const html = renderMasked(createElement(SidebarFooter, { userEmail: EMAIL, collapsed: true }));
    expect(html).toContain('title="Show amounts"');
    expect(html).toContain('aria-label="Show amounts"');
  });
});
