import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DIALOG_SHELL_CLASS } from "@/components/DialogKit";

/**
 * Ruling 6 (Smoke Minor A): the bottom-sheet / centred-card shells in
 * TxFormSheet and DialogKit are `flex-col overflow-y-auto max-h-[90vh]`
 * containers, so once their content exceeds the cap EVERY flex child shrinks
 * before the container scrolls — and the entry dialog's type-tab row, the one
 * child with no intrinsic minimum, collapsed to 16 px against ~35 px normal
 * on a short viewport.
 *
 * The fix is that the shell's DIRECT CHILDREN do not shrink; overflow is the
 * container's scroll. It cannot be a class on each child, because both shells
 * render caller-supplied children (`DialogShell`'s `children`, and every
 * conditional block in `SheetForm`) — so it is one arbitrary-variant rule on
 * the container, `[&>*]:flex-shrink-0`, owned by ONE exported constant both
 * shells use.
 *
 * ⚠ WHAT THIS TEST IS. The house has no DOM-rendering test setup at all —
 * vitest runs `environment: "node"`, there is no RTL, and both shells sit
 * behind `Portal`, which returns null outside the browser — so the height the
 * ruling names cannot be measured here. This asserts the CLASS CONTRACT
 * instead (the ruling's own stated fallback); the 700 px-tall visual check is
 * the build-and-drive step's.
 */

const read = (file: string) =>
  readFileSync(path.join(process.cwd(), "src/components", file), "utf8");

describe("ruling 6 — dialog children do not shrink", () => {
  it("the shell class makes every direct child non-shrinking", () => {
    expect(DIALOG_SHELL_CLASS).toContain("[&>*]:flex-shrink-0");
  });

  it("it is still the scrolling flex-column shell it was", () => {
    expect(DIALOG_SHELL_CLASS).toContain("flex-col");
    expect(DIALOG_SHELL_CLASS).toContain("overflow-y-auto");
    expect(DIALOG_SHELL_CLASS).toContain("max-h-[90vh]");
  });

  it("both shells build from that one constant — no second copy to drift", () => {
    for (const file of ["TxFormSheet.tsx", "DialogKit.tsx"]) {
      const source = read(file);
      expect(source).toContain("DIALOG_SHELL_CLASS");
      // The literal only ever appears in the constant itself; a shell class
      // string hand-written in either component would be the drift that
      // produced Minor A in the first place.
      expect(source.match(/max-h-\[90vh\]/g) ?? []).toHaveLength(
        file === "DialogKit.tsx" ? 1 : 0,
      );
    }
  });
});
