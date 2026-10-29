// Client-held vault keys (W3): the prompts the key session raises, one at a
// time, on the shared ConfirmDialog shell and the app toast. No bespoke styles.
//
// - "Save your vault key" after this device keys a vault (re-type 3 words).
// - "Approve this device from your other computer" while linking.
// - "A new device is signing in as you" on an existing device.
// - "<person>'s security key changed": the one human override of a pin.
// - "Gave <person> the vault key" toast with the key's short fingerprint.

import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { confirmWordsMatch, pickConfirmPositions } from "../lib/vaultKeys/confirmWords";
import { currentVaultKeySession, onVaultKeyEvent } from "../lib/vaultKeys/runtime";
import type { PendingDeviceView, SealedFor } from "../lib/vaultKeys/session";

type Prompt =
  | { kind: "save-key"; vaultId: string; words: string }
  | { kind: "awaiting-device"; code: string }
  | { kind: "approve-device"; device: PendingDeviceView }
  | { kind: "key-changed"; vaultId: string; change: SealedFor & { publicKey: string } };

const promptKey = (p: Prompt) =>
  p.kind === "approve-device"
    ? `d:${p.device.deviceId}`
    : p.kind === "key-changed"
      ? `k:${p.vaultId}:${p.change.userId}:${p.change.fingerprint}`
      : p.kind === "save-key"
        ? `s:${p.vaultId}`
        : `a:${p.code}`;

export function VaultKeyPrompts() {
  const [queue, setQueue] = useState<Prompt[]>([]);

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
      } else if (e.kind === "vault" && e.state.state === "ready" && e.state.created) {
        const words = currentVaultKeySession()?.revealVaultKey(e.vaultId);
        if (words) push({ kind: "save-key", vaultId: e.vaultId, words });
      } else if (e.kind === "pending-devices") {
        for (const device of e.devices) push({ kind: "approve-device", device });
      } else if (e.kind === "serviced") {
        for (const s of e.result.sealed) toast(`Gave ${s.userId} the vault key · ${s.fingerprint}`);
        for (const change of e.result.keyChanged) push({ kind: "key-changed", vaultId: e.vaultId, change });
      }
    });
  }, []);

  const current = queue[0];
  const done = () => setQueue((q) => q.slice(1));
  if (!current) return null;

  switch (current.kind) {
    case "save-key":
      return <SaveVaultKey words={current.words} onDone={done} />;
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
      return (
        <ConfirmDialog
          title="A new computer is signing in as you"
          tone="accent"
          confirmLabel="Approve"
          cancelLabel="Deny"
          onConfirm={async () => {
            const ok = await currentVaultKeySession()?.approveDevice(current.device);
            toast(ok ? "Computer approved." : "Could not approve that computer.", ok ? "success" : "error");
            done();
          }}
          onCancel={() => {
            void currentVaultKeySession()?.denyDevice(current.device.deviceId);
            done();
          }}
        >
          <p>
            Approve only if it is yours and shows this code: <strong>{current.device.code}</strong>
          </p>
        </ConfirmDialog>
      );
    case "key-changed":
      return (
        <ConfirmDialog
          title={`${current.change.userId}'s security key changed`}
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

function SaveVaultKey({ words, onDone }: { words: string; onDone: () => void }) {
  const positions = useMemo(() => pickConfirmPositions(), []);
  const [typed, setTyped] = useState<string[]>(() => positions.map(() => ""));
  const [confirming, setConfirming] = useState(false);
  const ok = confirmWordsMatch(words, positions, typed);

  if (!confirming) {
    return (
      <ConfirmDialog
        title="Save your vault key"
        tone="accent"
        confirmLabel="I've saved it"
        cancelLabel="Copy"
        onConfirm={() => setConfirming(true)}
        onCancel={() => {
          void navigator.clipboard?.writeText(words).then(() => toast("Vault key copied."));
        }}
      >
        <p>These 24 words are the key to this vault. Anyone with them can read it; without them a lost vault cannot be recovered.</p>
        <p>
          <code>{words}</code>
        </p>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      title="Check your vault key"
      tone="accent"
      confirmLabel="Done"
      cancelLabel="Back"
      confirmDisabled={!ok}
      onConfirm={onDone}
      onCancel={() => setConfirming(false)}
    >
      <p>Type these words from your saved key.</p>
      {positions.map((p, i) => (
        <label key={p}>
          Word {p + 1}
          <input
            value={typed[i]}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
          />
        </label>
      ))}
    </ConfirmDialog>
  );
}
