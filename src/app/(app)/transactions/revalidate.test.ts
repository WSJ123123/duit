import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { revalidatePath } = await import("next/cache");
const { revalidateTxPaths } = await import("@/app/(app)/transactions/revalidate");

/**
 * Plan 8 Task 7 audit 1, gaps 1–6. The import history (Settings and the
 * wizard) reads batch-tagged transactions and their reimbursement payments,
 * so EVERY transaction write moves it — an edit makes a batch "touched", a
 * delete shrinks its count. One shared set, one plain module (the house
 * shape of settings/revalidate.ts); the source checks below are the only
 * assertion available for call sites without a router harness.
 */
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("revalidateTxPaths", () => {
  beforeEach(() => vi.mocked(revalidatePath).mockClear());

  it("revalidates every transaction reader, the import history's two pages included", () => {
    revalidateTxPaths();
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual([
      "/transactions",
      "/dashboard",
      "/quick",
      "/budget",
      "/goals",
      "/bills",
      "/net-worth",
      "/investments",
      "/settings/accounts",
      "/more",
      "/settings",
      "/transactions/import",
    ]);
  });

  it("is the one set behind the ordinary transaction actions and the import actions", () => {
    for (const file of ["src/app/(app)/transactions/actions.ts", "src/app/(app)/transactions/import/actions.ts"]) {
      expect(source(file)).toContain("revalidateTxPaths()");
    }
  });
});

describe("the import pages' other writers", () => {
  it.each([
    ["a reimbursement payment (makes an imported row touched)", "src/app/(app)/transactions/reimburse-actions.ts", ["/settings", "/transactions/import"]],
    ["beginImport (inserts a listed batch row)", "src/app/(app)/transactions/import/actions.ts", ["/settings", "/transactions/import"]],
    ["account writes (the target picker, history account names)", "src/app/(app)/settings/accounts/actions.ts", ["/transactions/import"]],
    ["category writes (the preview's category labels)", "src/app/(app)/settings/categories/actions.ts", ["/transactions/import"]],
    ["token create/revoke (the /settings active-token count)", "src/app/(app)/settings/shortcut/actions.ts", ["/settings"]],
  ])("%s revalidates them", (_what, file, paths) => {
    for (const p of paths) expect(source(file)).toContain(`revalidatePath("${p}")`);
  });
});
