import { formatSen } from "@/lib/money";

/**
 * Final review A I1. After a PARTIAL liability payment (the expense saved,
 * the balance step failed) any field edit swaps the idempotency uuid (Plan 8
 * ruling 1), so the next press is a NEW payment and the first expense stays
 * in the ledger. The dialog replaces the retry message with this line the
 * moment the figures change, so that second entry is never a surprise.
 */
export function editedAfterPartialNotice(savedSen: number): string {
  return `The first payment of ${formatSen(savedSen)} is already saved as an expense — changing the figures records a second one. Retry unchanged to finish it, or delete the first in Transactions.`;
}
