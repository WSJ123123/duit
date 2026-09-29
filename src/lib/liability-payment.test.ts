import { describe, it, expect } from "vitest";
import { editedAfterPartialNotice } from "@/lib/liability-payment";

describe("editedAfterPartialNotice", () => {
  it("names the saved expense and both ways out once the figures change after a partial failure", () => {
    expect(editedAfterPartialNotice(50_000)).toBe(
      "The first payment of RM 500.00 is already saved as an expense — changing the figures records a second one. Retry unchanged to finish it, or delete the first in Transactions.",
    );
  });
});
