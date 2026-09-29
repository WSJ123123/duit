import { describe, it, expect } from "vitest";
import { IMPORT_CHUNK_ROWS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, IMPORT_PICKER_LINES, oversizeError } from "@/lib/import-limits";

/** Plan 9 Task 4 (R5): ruling 18's limits in one constant module. The
 *  `oversizeError` assertions are import-display.test.ts's, moved verbatim. */

describe("the import limits — one module, named in every refusal", () => {
  it("pins the caps", () => {
    expect(IMPORT_MAX_ROWS).toBe(500);
    expect(IMPORT_CHUNK_ROWS).toBe(100);
    expect(IMPORT_PICKER_LINES).toBe(12);
  });
});

describe("oversizeError — ruling 18's size cap, one sentence for client and server", () => {
  it("is null at the cap and names the size and the limit above it", () => {
    expect(IMPORT_MAX_BYTES).toBe(1_048_576);
    expect(oversizeError(IMPORT_MAX_BYTES)).toBeNull();
    expect(oversizeError(IMPORT_MAX_BYTES + 1)).toBe("File is 1025 KB — the limit is 1 MB; split the export by month");
    expect(oversizeError(1_500_000)).toBe("File is 1465 KB — the limit is 1 MB; split the export by month");
  });
});
