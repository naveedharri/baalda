// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useStore } from "../store";
import { Banner } from "./Banner";
import { UpgradeDialog } from "./UpgradeDialog";

/**
 * Persistent explanation for the attachment mirror's explicit Pro refusal.
 * The file remains fully usable from disk; only its cross-device copy is
 * withheld. `showUpgrade` is capability-gated by the server so self-hosts do
 * not get a checkout action they cannot complete.
 */
export function AttachmentLocalOnlyNoticeView({
  show,
  showUpgrade,
  onUpgrade,
  onOpenHealth,
  surface = "preview",
}: {
  show: boolean;
  showUpgrade: boolean;
  onUpgrade?: () => void;
  onOpenHealth?: () => void;
  surface?: "preview" | "health";
}) {
  return (
    <Banner
      show={show}
      className={`attachment-sync-notice attachment-sync-notice-${surface}`}
      role="status"
    >
      <span>
        <strong>Attachments are local only in this vault.</strong>{" "}
        Notes still sync, and you can preview every supported file on this device.
      </span>
      {(showUpgrade || onOpenHealth) && (
        <div className="banner-actions">
          {showUpgrade && onUpgrade && (
            <button className="primary" onClick={onUpgrade}>
              Upgrade to sync attachments
            </button>
          )}
          {onOpenHealth && <button onClick={onOpenHealth}>Open Health</button>}
        </div>
      )}
    </Banner>
  );
}

export function AttachmentSyncNotice({ surface = "preview" }: { surface?: "preview" | "health" }) {
  const blocked = useStore((s) => s.attachmentSyncBlocked);
  const billingEnabled = useStore((s) => s.billingConfig?.enabled === true);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  return (
    <>
      <AttachmentLocalOnlyNoticeView
        show={blocked}
        showUpgrade={billingEnabled}
        onUpgrade={() => setUpgradeOpen(true)}
        onOpenHealth={
          surface === "preview"
            ? () => useStore.getState().requestSettings("health")
            : undefined
        }
        surface={surface}
      />
      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}
