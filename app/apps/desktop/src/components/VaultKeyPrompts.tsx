// Client-held vault keys (W3): the prompts the key session raises, one at a
// time, on the shared ConfirmDialog shell and the app toast. No bespoke styles.
//
// - "Approve this device from your other computer" while linking.
// - "A new device is signing in as you" on an existing device.
// - "<person>'s security key changed": the one human override of a pin.
// - "Gave <person> the vault key" toast with the key's short fingerprint.

import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { memberDisplayName } from "../lib/vaultKeys/names";
import { currentVaultKeySession, onVaultKeyEvent } from "../lib/vaultKeys/runtime";
import type { PendingDeviceView, SealedFor } from "../lib/vaultKeys/session";

type Prompt =
  | { kind: "awaiting-device"; code: string }
  | { kind: "approve-device"; device: PendingDeviceView }
  | { kind: "key-changed"; vaultId: string; change: SealedFor & { publicKey: string } };

const promptKey = (p: Prompt) =>
  p.kind === "approve-device"
    ? `d:${p.device.deviceId}`
    : p.kind === "key-changed"
      ? `k:${p.vaultId}:${p.change.userId}:${p.change.fingerprint}`
      : `a:${p.code}`;

const nameOf = (userId: string) => memberDisplayName(useStore.getState().members, userId);

/**
 * "A new computer is signing in as you": approved only by TYPING the code the
 * new computer shows. The code is never displayed here, so a device the person
 * did not start (a row a server or database writer added with its own key)
 * cannot be approved by clicking through.
 */
export function ApproveDevicePrompt({ device, done }: { device: PendingDeviceView; done: () => void }) {
  const [typed, setTyped] = useState("");
  const ready = typed.replace(/[\s-]/g, "").length === 8;
  return (
    <ConfirmDialog
      title="A new computer is signing in as you"
      tone="accent"
      confirmLabel="Approve"
      cancelLabel="Deny"
      confirmDisabled={!ready}
      onConfirm={async () => {
        const ok = await currentVaultKeySession()?.approveDevice(device, typed);
        toast(ok ? "Computer approved." : "That code does not match. Nothing was approved.", ok ? "success" : "error");
        done();
      }}
      onCancel={() => {
        void currentVaultKeySession()?.denyDevice(device.deviceId);
        done();
      }}
    >
      <p>
        If you are setting up Baalda on another computer, type the code it shows. If you are not, choose Deny.
      </p>
      <input
        type="text"
        aria-label="Code shown on the new computer"
        placeholder="abcd 1234"
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
    </ConfirmDialog>
  );
}

export function VaultKeyPrompts() {
  const [queue, setQueue] = useState<Prompt[]>([]);
  useStore((s) => s.members); // re-render when the roster arrives

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
      } else if (e.kind === "pending-devices") {
        for (const device of e.devices) push({ kind: "approve-device", device });
      } else if (e.kind === "serviced") {
        for (const s of e.result.sealed) toast(`Gave ${nameOf(s.userId)} the vault key · ${s.fingerprint}`);
        for (const change of e.result.keyChanged) push({ kind: "key-changed", vaultId: e.vaultId, change });
      }
    });
  }, []);

  const current = queue[0];
  const done = () => setQueue((q) => q.slice(1));
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
        </ConfirmDialog>
      );
    case "approve-device":
      return <ApproveDevicePrompt key={current.device.deviceId} device={current.device} done={done} />;
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
