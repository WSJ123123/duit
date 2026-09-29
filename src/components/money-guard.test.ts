import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Plan 9 ruling 3 — the formatters are FENCED, and so is every other way to
 * print money. A synchronous walk over every non-test `.ts`/`.tsx` under
 * `src/**` — minus `src/lib` (where the formatters live), `src/db` and
 * `src/test`, and skipping `Money.tsx`, the one renderer (widened from
 * `src/app` + `src/components` by final review A, M1, so a future
 * `src/hooks/`, `src/features/`, `src/sw.ts` or `src/proxy.ts` cannot escape)
 * — that fails naming `file:line` for
 *   (a) any `formatSen` / `formatCcy` import, call or re-export — and, since
 *       Task 3a (Q36), `src/lib/pl-display.ts`'s `formatSignedSen` /
 *       `formatSignedCcy`, which wrap them and print P/L at rest — and
 *   (b) any hand-rolled shape — `toFixed(`, `toLocaleString(`,
 *       `Intl.NumberFormat`, `/ 100`, `Math.round|floor|trunc(` — outside the
 *       explicit allowlist below, written as file + ENCLOSING IDENTIFIER
 *       (never line numbers, which the sweeps move).
 *
 * Run red at the end of Task 1 against the unswept tree (32 formatter files +
 * `TradeSheet.tsx` `plainMinor`; the list is in PROGRESS.md, Session 16,
 * "Task 1 Step 3 — red runs"). Un-skipped, green, in Task 3 Step 4 (3b).
 */

const ROOT = join(__dirname, "..", "..");
const TREES = ["src"];
/** Not walked: the formatters' own home, the DB layer and the test helpers. */
const SKIPPED_TREES = ["src/lib", "src/db", "src/test"];
const RENDERER = "src/components/Money.tsx";

const FORMATTER_RE = /\bformat(?:Sen|Ccy|SignedSen|SignedCcy)\b/;
const HAND_ROLLED_RE = /toFixed\(|toLocaleString\(|Intl\.NumberFormat|\/\s*100\b|Math\.(?:round|floor|trunc)\(/;

/**
 * Ruling 3's allowlist, plus the Task 1 census's non-money hits (PROGRESS.md
 * Session 16, Step 0 (b)). `ident` is the chain of enclosing declarations,
 * outermost first, as `enclosingIdent` resolves it. `TradeSheet.tsx`
 * `plainMinor` is deliberately NOT here: money at rest, swept in Task 3.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; ident: string; why: string }> = [
  // Input prefill — an <input>'s value is never masked (ruling 4). ONE copy:
  // BudgetTable, QuickAdd, TxFormSheet and RecurringRuleForm import it
  // (final review A, T3 n1 — their byte-identical local copies collapsed).
  { file: "src/components/DialogKit.tsx", ident: "senToInputStr", why: "input prefill" },
  // Non-money: quantities, percentages, months, ratios, SVG coordinates.
  { file: "src/components/HoldingsTable.tsx", ident: "formatQty.s", why: "quantity" },
  { file: "src/components/HoldingsTable.tsx", ident: "pctLabel", why: "percent" },
  { file: "src/components/AllocationPlan.tsx", ident: "monthsOneDecimal", why: "months" },
  { file: "src/components/AllocationPlan.tsx", ident: "returnPctOneDecimal", why: "percent" },
  { file: "src/components/AllocationPlan.tsx", ident: "returnPctPlain", why: "percent" },
  { file: "src/components/AllocationPlan.tsx", ident: "monthsTenthsLabel", why: "months" },
  { file: "src/components/AllocationPlan.tsx", ident: "PresetCard.monthsLabel", why: "months" },
  { file: "src/components/NetWorthChart.tsx", ident: "toPoints", why: "SVG coordinates" },
  { file: "src/app/(app)/dashboard/page.tsx", ident: "MiniSparkline.points", why: "SVG coordinates" },
  // Census additions (local decision, PROGRESS.md Session 16 Step 0 (b)).
  { file: "src/app/(app)/dashboard/page.tsx", ident: "shiftMonth.newY", why: "month arithmetic" },
  { file: "src/app/(app)/transactions/page.tsx", ident: "shiftMonth.newY", why: "month arithmetic" },
  { file: "src/components/SavingsWaterfall.tsx", ident: "stepTrackFraction", why: "progress-track ratio" },
  {
    file: "src/components/ManualItemDialogs.tsx",
    ident: "AddLiabilityDialog.submit.interest_rate_bp",
    why: "interest-rate input parse → bp",
  },
  { file: "src/components/HoldingsTable.tsx", ident: "CreateHoldingDialog.submit", why: "manual price input parse → e8" },
  { file: "src/components/HoldingsTable.tsx", ident: "EditHoldingDialog.submit", why: "manual price input parse → e8" },
  { file: "src/components/import-wizard/MapStep.tsx", ident: "fileSizeKb", why: "file size in KB" },
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIPPED_TREES.includes(relative(ROOT, full))) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
}

const DECL_RES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{=]+)?\{\s*$/, // method
];

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "else", "do", "try", "return", "function"]);

function declName(line: string): string | null {
  for (const re of DECL_RES) {
    const m = re.exec(line);
    if (m?.[1] && !KEYWORDS.has(m[1])) return m[1];
  }
  return null;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The chain of declarations enclosing `lineIdx`, outermost first (`A.b.c`).
 * Walks upward keeping only lines indented LESS than everything seen so far,
 * so each kept declaration is an ancestor, never an earlier sibling. A line
 * that only closes a multi-line header (`}) {`, `}: {`) keeps the search open
 * at its own indent so the header's first line (`function X({`) is found. The
 * hit line counts as its own declaration when it is one (`const plainMinor = …`).
 */
function enclosingIdent(lines: string[], lineIdx: number): string {
  const chain: string[] = [];
  const own = declName(lines[lineIdx] ?? "");
  if (own) chain.push(own);
  let minIndent = indentOf(lines[lineIdx] ?? "");
  let headerOpen = false;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent > minIndent) continue;
    if (indent === minIndent && !headerOpen) continue;
    minIndent = indent;
    const name = declName(line);
    if (name) {
      chain.push(name);
      headerOpen = false;
      if (indent === 0) break;
    } else {
      headerOpen = /^\s*[)}\]]/.test(line);
    }
  }
  return chain.length ? chain.reverse().join(".") : "<module>";
}

function stripComments(source: string): string[] {
  // Block comments are blanked line-by-line (line count preserved); line
  // comments are cut at `//` when not inside a string-ish `://`.
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks.split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

interface Hit {
  file: string;
  line: number;
  ident: string;
  text: string;
}

function scan(): { formatter: Hit[]; handRolled: Hit[] } {
  const files: string[] = [];
  for (const tree of TREES) walk(join(ROOT, tree), files);
  const formatter: Hit[] = [];
  const handRolled: Hit[] = [];
  for (const full of files.sort()) {
    const file = relative(ROOT, full);
    if (file === RENDERER) continue;
    const lines = stripComments(readFileSync(full, "utf8"));
    lines.forEach((text, i) => {
      const line = i + 1;
      if (FORMATTER_RE.test(text)) {
        formatter.push({ file, line, ident: enclosingIdent(lines, i), text: text.trim() });
      }
      if (HAND_ROLLED_RE.test(text)) {
        const ident = enclosingIdent(lines, i);
        const allowed = ALLOWLIST.some((a) => a.file === file && a.ident === ident);
        if (!allowed) handRolled.push({ file, line, ident, text: text.trim() });
      }
    });
  }
  return { formatter, handRolled };
}

const describeHits = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line} [${h.ident}] ${h.text}`).join("\n");

// Un-skipped green in Task 3 Step 4 (Task 3b): every one of the 32 census
// files and TradeSheet's plainMinor swept; the only exemption is Money.tsx.
describe("ruling 3 — the money fence", () => {
  it("(a) formatSen / formatCcy / formatSigned* appear nowhere under src/app or src/components except Money.tsx", () => {
    const { formatter } = scan();
    expect(formatter, `formatter references outside the renderer:\n${describeHits(formatter)}`).toEqual([]);
  });

  it("(b) no hand-rolled money shape outside the file + enclosing-identifier allowlist", () => {
    const { handRolled } = scan();
    expect(handRolled, `hand-rolled shapes outside the allowlist:\n${describeHits(handRolled)}`).toEqual([]);
  });

  it("every allowlist entry still names a real hit (no stale exemptions)", () => {
    const files: string[] = [];
    for (const tree of TREES) walk(join(ROOT, tree), files);
    const seen = new Set<string>();
    for (const full of files) {
      const file = relative(ROOT, full);
      const lines = stripComments(readFileSync(full, "utf8"));
      lines.forEach((text, i) => {
        if (HAND_ROLLED_RE.test(text)) seen.add(`${file}#${enclosingIdent(lines, i)}`);
      });
    }
    const stale = ALLOWLIST.filter((a) => !seen.has(`${a.file}#${a.ident}`));
    expect(stale, "allowlist entries with no matching hit").toEqual([]);
  });
});
