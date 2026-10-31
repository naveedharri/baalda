// Account Settings → Profile: "Your security code". The code teammates are
// asked to confirm in "<name>'s security key changed" or when this person
// links a new computer. Read-only; hidden unless vault keys are on and this
// computer holds the account key (`ownSecurityCodeView`).

import { useEffect, useState } from "react";
import { accountKeyStateNow, onVaultKeyEvent, ownSecurityCode } from "../lib/vaultKeys/runtime";
import { ownSecurityCodeView, SECURITY_CODE_HINT } from "../lib/vaultKeys/sectionView";

/** The row itself (pure, for tests). */
export function SecurityCodeRow({ code }: { code: string }) {
  return (
    <label className="field">
      <span className="field-label">Your security code</span>
      <input value={code} readOnly />
      <span className="field-hint">{SECURITY_CODE_HINT}</span>
    </label>
  );
}

export function SecurityCodeField() {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void ownSecurityCode().then((c) => {
        if (live) setCode(ownSecurityCodeView(accountKeyStateNow(), c));
      });
    };
    refresh();
    const off = onVaultKeyEvent((e) => {
      if (e.kind === "account" || e.kind === "fresh-key") refresh();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return code ? <SecurityCodeRow code={code} /> : null;
}
