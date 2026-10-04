// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useStore } from "../store";
import { Banner } from "./Banner";
import { UpgradeDialog } from "./UpgradeDialog";

export function attachmentNoticeVisible(blocked: boolean, detected: boolean): boolean {
  return blocked && detected;
}

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
}: {
  show: boolean;
  showUpgrade: boolean;
  onUpgrade?: () => void;
}) {
  return (
    <Banner
      show={show}
      className="attachment-sync-notice attachment-sync-notice-preview"
      role="status"
    >
      <span className="attachment-sync-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M8.5 12.5 14 7a3 3 0 0 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1l7.5-7.5" />
          <path d="m15.5 15.5 4 4m0-4-4 4" />
        </svg>
      </span>
      <span className="attachment-sync-copy">
        <strong className="attachment-sync-title">
          Standalone files require Pro to sync
        </strong>
        <span className="attachment-sync-body">
          Notes and their embedded attachments still sync. Standalone files stay on
          this device and remain available to preview locally.
        </span>
      </span>
      {showUpgrade && onUpgrade && (
        <div className="banner-actions">
          <button className="primary sm attachment-sync-cta" onClick={onUpgrade}>
            Upgrade to Pro
          </button>
        </div>
      )}
    </Banner>
  );
}

export function AttachmentSyncNotice({
  detected = true,
}: {
  /** False/unknown callers keep the notice hidden until a local attachment exists. */
  detected?: boolean;
}) {
  const blocked = useStore((s) => s.attachmentSyncBlocked);
  const billingEnabled = useStore((s) => s.billingConfig?.enabled === true);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  return (
    <>
      <AttachmentLocalOnlyNoticeView
        show={attachmentNoticeVisible(blocked, detected)}
        showUpgrade={billingEnabled}
        onUpgrade={() => setUpgradeOpen(true)}
      />
      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}
