// "I lost every device": the dialogs on the shared ConfirmDialog shell, raised
// from the approve-this-computer prompt and the waiting notice. Pure logic and
// copy live in `lib/vaultKeys/recovery.ts`. Nothing here deletes local files or
// touches a vault key this computer already holds.

import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { RestoreVaultKeyDialog } from "./RestoreVaultKeyDialog";

export { RestoreVaultKeyDialog };
import { toast } from "../lib/toast";
import { startFreshAccountKey } from "../lib/vaultKeys/runtime";
import {
  FRESH_KEY_EXPLAINER,
  FRESH_KEY_WAITING_PREFIX,
  RESTORE_INSTEAD_LABEL,
  lostDevicesStep,
  offersRestoreInstead,
  type LostDevicesStep,
} from "../lib/vaultKeys/recovery";

/** The fresh-key wait: the code teammates must confirm. */
export function FreshKeyWaitingDialog({ code, onClose }: { code: string; onClose: () => void }) {
  return (
    <ConfirmDialog title="New security key created" tone="accent" confirmLabel="OK" cancelLabel="Close" onConfirm={onClose} onCancel={onClose}>
      <p>
        {FRESH_KEY_WAITING_PREFIX} <strong>{code}</strong>
      </p>
    </ConfirmDialog>
  );
}

/**
 * "I don't have my other devices": confirm → `startFreshAccountKey` → the
 * waiting dialog with the new code. Owners may restore with the vault key
 * instead. A refusal (rate limited: the runtime toasts the server's message)
 * or an error changes nothing and closes.
 */
export function LostDevicesFlow({
  isOwner,
  vaultId,
  onClose,
}: {
  isOwner: boolean;
  vaultId: string | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<LostDevicesStep>({ step: "confirm" });
  const close = () => {
    setStep((s) => lostDevicesStep(s, { type: "cancel" }));
    onClose();
  };

  if (step.step === "restore" && vaultId) return <RestoreVaultKeyDialog vaultId={vaultId} onClose={close} />;
  if (step.step === "waiting") return <FreshKeyWaitingDialog code={step.code} onClose={close} />;
  if (step.step !== "confirm") return null;

  return (
    <ConfirmDialog
      title="Create a new security key"
      tone="accent"
      confirmLabel="Create new key"
      onCancel={close}
      onConfirm={async () => {
        let next: LostDevicesStep;
        try {
          const result = await startFreshAccountKey();
          if (result.kind === "started") {
            next = lostDevicesStep(step, { type: "started", code: result.code });
          } else {
            if (result.kind === "not-allowed") {
              toast("This computer already has a security key, or keys are off. Nothing was changed.", "error");
            }
            next = lostDevicesStep(step, { type: "refused" });
          }
        } catch {
          toast("Could not create a new security key right now. Nothing was changed. Try again later.", "error");
          next = lostDevicesStep(step, { type: "refused" });
        }
        if (next.step === "closed") onClose();
        setStep(next);
      }}
    >
      <p>{FRESH_KEY_EXPLAINER}</p>
      {offersRestoreInstead({ isOwner, vaultId }) && (
        <p>
          <button type="button" className="link-btn" onClick={() => setStep((s) => lostDevicesStep(s, { type: "restore" }))}>
            {RESTORE_INSTEAD_LABEL}
          </button>
        </p>
      )}
    </ConfirmDialog>
  );
}
