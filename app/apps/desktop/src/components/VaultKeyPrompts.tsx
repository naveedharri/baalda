// Client-held vault keys (W3): the prompts the key session raises, one at a
// time, on the shared ConfirmDialog shell and the app toast. No bespoke styles.
//
// - "Approve this device from your other computer" while linking.
// - "A new device is signing in as you" on an existing device.
// - "<person>'s security key changed": the one human override of a pin.
// - "Gave <person> the vault key" toast with the key's short fingerprint.
// - "Keep these connections working?": the owner's review at conversion.

import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { memberDisplayName } from "../lib/vaultKeys/names";
import { currentVaultKeySession, onVaultKeyEvent, submitConversionReview } from "../lib/vaultKeys/runtime";
import { candidateKey } from "../lib/vaultKeys/conversionReview";
import type { AllowlistCandidate } from "../lib/api";
import { ConversionReviewDialog } from "./ConversionReviewDialog";
import { LOST_DEVICES_LABEL } from "../lib/vaultKeys/recovery";
import { syncManager } from "../lib/sync/docSession";
import { LostDevicesFlow } from "./VaultKeyRecovery";
import type { PendingDeviceView, SealedFor } from "../lib/vaultKeys/session";

type Prompt =
  | { kind: "awaiting-device"; code: string }
  /** "I don't have my other devices", chosen from the awaiting-device prompt. */
  | { kind: "lost-devices" }
  | { kind: "approve-device"; device: PendingDeviceView }
  | { kind: "key-changed"; vaultId: string; change: SealedFor & { publicKey: string } }
  | { kind: "conversion-review"; vaultId: string; candidates: AllowlistCandidate[] };

const promptKey = (p: Prompt) =>
  p.kind === "conversion-review"
    ? `r:${p.vaultId}:${p.candidates.map(candidateKey).sort().join(",")}`
    : p.kind === "approve-device"
    ? `d:${p.device.deviceId}`
    : p.kind === "key-changed"
      ? `k:${p.vaultId}:${p.change.userId}:${p.change.fingerprint}`
      : p.kind === "lost-devices"
        ? "lost"
        : `a:${p.code}`;

const nameOf = (userId: string) => memberDisplayName(useStore.getState().members, userId);

/**
 * "<device> is signing in": one click, Approve or Not me (seamless keys, E).
 * The code is shown read-only so the person can glance at the new computer;
 * nothing is typed. This deliberately replaces the earlier typed-code step
 * (owner decision 2026-11-01): the prompt only ever appears for this
 * account's own pending devices, and the new device keeps showing its code.
 */
export function ApproveDevicePrompt({ device, done }: { device: PendingDeviceView; done: () => void }) {
  const name = device.name?.trim() || "A new computer";
  return (
    <ConfirmDialog
      title={`${name} is signing in`}
      tone="accent"
      confirmLabel="Approve"
      cancelLabel="Not me"
      onConfirm={async () => {
        const ok = await currentVaultKeySession()?.approveDevice(device, device.code);
        toast(ok ? "Computer approved." : "Could not approve that computer. Nothing was approved.", ok ? "success" : "error");
        done();
      }}
      onCancel={() => {
        void currentVaultKeySession()?.denyDevice(device.deviceId);
        done();
      }}
    >
      <p>
        If you are setting up Baalda on another computer, approve it. It shows the code{" "}
        <strong aria-label="Code shown on the new computer">{device.code}</strong>. If this is not you, choose Not
        me.
      </p>
    </ConfirmDialog>
  );
}

export function VaultKeyPrompts() {
  const [queue, setQueue] = useState<Prompt[]>([]);
  useStore((s) => s.members); // re-render when the roster arrives
  const isOwner = useStore((s) => s.members.find((m) => m.userId === s.session?.user.id)?.role === "owner");

  useEffect(() => {
    const seen = new Set<string>();
    const push = (p: Prompt) => {
      const key = promptKey(p);
      if (seen.has(key)) return;
      seen.add(key);
      setQueue((q) => [...q, p]);
    };
    return onVaultKeyEvent((e) => {
      if (e.kind === "account" && e.state.state === "awaiting-device-approval") {
        push({ kind: "awaiting-device", code: e.state.code });
      } else if (e.kind === "account" && e.state.state === "security-warning") {
        toast("Your security key on the server does not match this computer. Vault keys are paused.", "error");
      } else if (e.kind === "rate-limited") {
        toast(e.message, "error");
      } else if (e.kind === "conversion-review") {
        push({ kind: "conversion-review", vaultId: e.vaultId, candidates: e.candidates });
      } else if (e.kind === "pending-devices") {
        for (const device of e.devices) push({ kind: "approve-device", device });
      } else if (e.kind === "serviced") {
        for (const s of e.result.sealed) {
          toast(`Gave ${e.names?.[s.userId] ?? nameOf(s.userId)} the vault key · ${s.fingerprint}`);
        }
        for (const change of e.result.keyChanged) push({ kind: "key-changed", vaultId: e.vaultId, change });
      }
    });
  }, []);

  const current = queue[0];
  const done = () => setQueue((q) => q.slice(1));
  /** Swap the head prompt for another (the lost-devices path). */
  const replaceHead = (p: Prompt) => setQueue((q) => [p, ...q.slice(1)]);
  if (!current) return null;

  switch (current.kind) {
    case "awaiting-device":
      return (
        <ConfirmDialog
          title="Approve this computer"
          tone="accent"
          confirmLabel="OK"
          cancelLabel="Close"
          onConfirm={done}
          onCancel={done}
        >
          <p>
            Open Baalda on a computer where you are already signed in and approve this one. Check that it
            shows the same code: <strong>{current.code}</strong>
          </p>
          <p>
            <button type="button" className="link-btn" onClick={() => replaceHead({ kind: "lost-devices" })}>
              {LOST_DEVICES_LABEL}
            </button>
          </p>
        </ConfirmDialog>
      );
    case "lost-devices":
      return <LostDevicesFlow isOwner={isOwner} vaultId={syncManager.registry.vaultId} onClose={done} />;
    case "approve-device":
      return <ApproveDevicePrompt key={current.device.deviceId} device={current.device} done={done} />;
    case "conversion-review":
      return (
        <ConversionReviewDialog
          key={promptKey(current)}
          candidates={current.candidates}
          onSubmit={(keep) => {
            submitConversionReview(current.vaultId, keep);
            done();
          }}
          onLater={done}
        />
      );
    case "key-changed":
      return (
        <ConfirmDialog
          title={`${nameOf(current.change.userId)}'s security key changed`}
          tone="danger"
          confirmLabel="Approve"
          cancelLabel="Not now"
          onConfirm={async () => {
            const ok = await currentVaultKeySession()?.approveChangedKey(current.vaultId, current.change);
            toast(ok ? "New security key approved." : "Could not approve that key.", ok ? "success" : "error");
            done();
          }}
          onCancel={done}
        >
          <p>
            Their code is now <strong>{current.change.fingerprint}</strong>. Approve only if you have confirmed
            this code with them directly.
          </p>
        </ConfirmDialog>
      );
  }
}
