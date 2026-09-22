// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { loadRememberedPassword } from "./rememberedPassword";

/** Scope the buffer too: changing server/account must never submit the old secret. */
export function useRememberedPassword(server: string, email: string, mode: string, step: string, enabled: boolean) {
  const context = JSON.stringify([server, email, mode, step]);
  const [buffer, setBuffer] = useState({ context, value: "" });
  const edit = useRef(0);
  const typedContext = useRef<string | null>(null);
  const setPassword = (value: string) => {
    edit.current++;
    typedContext.current = context;
    setBuffer({ context, value });
  };
  useEffect(() => {
    typedContext.current = null;
    setBuffer({ context, value: "" });
  }, [context]);
  useEffect(() => {
    let cancelled = false;
    const revision = edit.current;
    if (!enabled && typedContext.current !== context) setBuffer({ context, value: "" });
    if (enabled && mode === "sign-in" && step === "form" && typedContext.current !== context) {
      void loadRememberedPassword(server, email).then((value) => {
        if (!cancelled && edit.current === revision) setBuffer({ context, value });
      }).catch(() => { /* Locked/unavailable keychain: allow manual sign-in. */ });
    }
    return () => { cancelled = true; };
  }, [context, enabled, server, email, mode, step]);
  return [buffer.context === context ? buffer.value : "", setPassword] as const;
}
