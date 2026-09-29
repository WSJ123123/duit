"use client";

import { TwoTapAction } from "@/components/DialogKit";
import { archiveAccount } from "./actions";

/**
 * Plan 8 ruling 2: the archive control needs somewhere to SHOW a refusal —
 * the rules blocking it are data the owner acts on, not a Tip. The house's
 * archive affordance (ArchiveAssetButton / ArchiveLiabilityButton /
 * ArchiveBusinessButton) already renders the action's error line and
 * refreshes on success, so this is that same control.
 */
export function ArchiveAccountButton({ accountId }: { accountId: string }) {
  return (
    <TwoTapAction
      label="Archive"
      confirmLabel="Confirm archive"
      pendingLabel="Archiving…"
      run={() => archiveAccount(accountId)}
    />
  );
}
