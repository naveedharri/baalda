// Account Settings → Profile: "Your security code". The code teammates are
// asked to confirm in "<name>'s security key changed" or when this person
// links a new computer. Read-only; hidden unless vault keys are on and this
// computer holds the account key (`ownSecurityCodeView`).

import { useEffect, useState } from "react";
import { accountKeyStateNow, onVaultKeyEvent, ownSecurityCode } from "../lib/vaultKeys/runtime";
import { ownSecurityCodeView, SECURITY_CODE_HINT } from "../lib/vaultKeys/sectionView";
import { copyText } from "../lib/clipboard";

/**
 * The row itself (pure, for tests): a Profile settings row, the code as four
 * read-out blocks (it is read aloud, never typed) plus Copy. Not an input, so
 * it no longer looks editable.
 */
export function SecurityCodeRow({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="profile-row">
      <div className="profile-row-label">
        <span className="profile-row-title">Your security code</span>
        <span className="profile-row-hint">{SECURITY_CODE_HINT}</span>
      </div>
      <div className="profile-row-control profile-code-row">
        <span className="profile-code" role="text" aria-label={`Security code ${code}`}>
          {code.split(" ").map((part, i) => (
            <span key={i} aria-hidden="true">
              {part}
            </span>
          ))}
        </span>
        <button
          type="button"
          className="secondary sm"
          onClick={() =>
            void copyText(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
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
