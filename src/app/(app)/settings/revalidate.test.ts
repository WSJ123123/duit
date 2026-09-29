import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { revalidatePath } = await import("next/cache");
const { revalidateSettingsIndexPaths } = await import("@/app/(app)/settings/revalidate");

/**
 * Q10: four recorded revalidation gaps, all cosmetic, all inside the 30 s
 * `staleTimes.dynamic` window — `/settings/recurring` and `/settings/aliases`
 * render account and category DISPLAY NAMES, `/settings` renders SUMMARY
 * COUNTS of accounts / categories / rules / aliases, and `updateCategoryTag`
 * never revalidated `/settings/categories`, the page its own control sits on.
 * Ruled: one shared helper, called from the actions that move those pages.
 */
const CALL_SITES = [
  // account names on /settings/recurring + /settings/aliases, accounts count
  "src/app/(app)/settings/accounts/actions.ts",
  // category names on both, categories count
  "src/app/(app)/settings/categories/actions.ts",
  // the /settings active-rules count
  "src/app/(app)/settings/recurring/actions.ts",
  // the /settings alias count
  "src/app/(app)/settings/aliases/actions.ts",
  // the tag control lives on /settings/categories; the action lives in budget/
  "src/app/(app)/budget/actions.ts",
];

describe("revalidateSettingsIndexPaths", () => {
  beforeEach(() => vi.mocked(revalidatePath).mockClear());

  it("revalidates the settings index and the three sub-pages it feeds", () => {
    revalidateSettingsIndexPaths();
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual([
      "/settings",
      "/settings/recurring",
      "/settings/aliases",
      "/settings/categories",
    ]);
  });

  it("is called from every action that moves one of those pages", () => {
    for (const file of CALL_SITES) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      // The parens matter: an action that imports the helper and never calls
      // it would satisfy a bare-name check while leaving the page stale.
      expect(source).toContain("revalidateSettingsIndexPaths()");
    }
  });
});
