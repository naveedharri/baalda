import { useEffect, useRef, useState } from "react";
import { DEFAULT_SERVER_URL } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  type AuthStep,
  decideAuthStep,
  impliedServerChoice,
  normalizeServerUrl,
  serverHost,
} from "../lib/auth/serverChoice";
import { readServerChoice, writeServerChoice } from "../lib/prefs";
import { passwordResetFailureMessage } from "../lib/resetFlow";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { serverFailureMessage } from "./serverFailureMessage";
import { Spinner } from "./Spinner";

/** Google's four-color "G" mark for the OAuth button. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.02-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/** Cloud mark for the managed-service card. */
function CloudGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18.99h10.5Z" />
    </svg>
  );
}

/** Rack-server mark for the self-hosted card. */
function ServerGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

/** Trailing chevron on a card; rotates when the card is expanded. */
function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * Focused sign-in / sign-up modal; closes itself once a session lands. When a
 * caller needs to act on a *successful* sign-in (vs. a cancel), it passes
 * `onSignedIn` — fired instead of `onClose` when the session arrives, so the
 * two outcomes stay distinguishable.
 *
 * `initialMode` picks which tab opens first. It defaults to sign-in, but the
 * welcome screen's "Join a team" route opens on sign-up: someone holding a
 * teammate's join code is usually here for the first time.
 *
 * THREE STEPS, not one. Before this dialog will take a password it wants to
 * know which server the account belongs to, because the alternative — one
 * server, with a collapsed "Server settings" disclosure under the form — meant
 * self-hosting teams' members reliably signed up on the managed instance and
 * nobody noticed until the admin couldn't find them (#91):
 *
 *   choose-server → form            (first run on this device)
 *   confirm-link  → form            (an invite link is offering a server)
 *   form                            (the question is already answered)
 *
 * The form step then names its server in a caption, with a way back, so the
 * answer is visible at the moment it matters rather than buried in Settings.
 */
export function AuthDialog({
  onClose,
  onSignedIn,
  initialMode = "sign-in",
}: {
  onClose: () => void;
  onSignedIn?: () => void;
  initialMode?: "sign-in" | "sign-up";
}) {
  const authStatus = useStore((s) => s.authStatus);
  const authError = useStore((s) => s.authError);
  const serverUrl = useStore((s) => s.serverUrl);
  const pendingServerLink = useStore((s) => s.pendingServerLink);
  // A team invitation brought this card up. It changes what the card SAYS
  // rather than what it does: an invitee arriving from a link has no idea why a
  // password prompt appeared unless it names the vault and who invited them.
  const invitePrompt = useStore((s) => s.invitePrompt);

  // "reset" is a third mode, not a separate dialog: it needs the same server
  // context, the same error slot and the same close behaviour, and someone who
  // remembers their password mid-way has to be able to step back to sign-in.
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "reset">(
    // An invitee usually has no account yet, so the invite card opens on
    // sign-up whatever the caller asked for.
    invitePrompt ? "sign-up" : initialMode,
  );
  const [name, setName] = useState("");
  // Dev-only prefill of the local test account; production builds ship empty fields.
  const [email, setEmail] = useState(
    invitePrompt?.email ?? (import.meta.env.DEV ? "test@context.local" : ""),
  );
  const [password, setPassword] = useState(import.meta.env.DEV ? "Context-Test-2026!" : "");
  const [busy, setBusy] = useState(false);
  // Password reset: its own busy/error/sent state, because the outcome is not a
  // session — the form is replaced by a confirmation and the person leaves for
  // their inbox.
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  // Google sign-in runs in the system browser and the app just waits for the
  // loopback handoff (up to a 3-min timeout). Its own busy flag lets us show a
  // "waiting for your browser" state instead of a silently disabled button.
  const [googleBusy, setGoogleBusy] = useState(false);
  // Google is only offered when the server is configured for it; ask on open
  // (and whenever the server changes) so a self-host without creds hides it.
  const [googleAvailable, setGoogleAvailable] = useState(false);
  // Same probe, same fail-closed rule: a server that cannot send email must not
  // offer "Forgot password?", or the link is a promise nothing keeps.
  const [resetAvailable, setResetAvailable] = useState(false);

  // ---- server step ---------------------------------------------------------

  const [step, setStep] = useState<AuthStep>(() =>
    decideAuthStep({
      choice: readServerChoice(),
      serverUrl,
      pendingServerLink,
    }),
  );
  // Revealed by the "Your own server" card rather than shown alongside it: an
  // input sitting under two options reads as belonging to both.
  const [ownOpen, setOwnOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  // Inline, never a toast: `<Toasts />` is only mounted in the vault-open
  // branch of App, so anything raised from the welcome screen's sign-in would
  // never render at all.
  const [serverError, setServerError] = useState<string | null>(null);

  /** Where to go once the server question is settled. */
  const stepAfterServer = (): AuthStep =>
    decideAuthStep({
      choice: readServerChoice(),
      serverUrl: useStore.getState().serverUrl,
      pendingServerLink: null,
    });

  // Devices that pointed at their own server through the OLD disclosure have no
  // persisted answer, but they plainly gave one. Record it so they are never
  // asked (and so a dismissed card can't default them to managed).
  useEffect(() => {
    if (readServerChoice()) return;
    const implied = impliedServerChoice(serverUrl);
    if (implied) writeServerChoice(implied);
    // Mount only, and deliberately not keyed on `serverUrl`: this is a one-time
    // repair of a pre-#91 device, not a reaction to the user changing servers
    // from inside this dialog (which writes the choice itself).
  }, []);

  // A link can arrive while this dialog is already open. It outranks whatever
  // step we were on, because it needs an explicit yes before it may be used.
  useEffect(() => {
    if (pendingServerLink) setStep("confirm-link");
  }, [pendingServerLink]);

  // An invitation can likewise land on an already-open card (the person was
  // mid-sign-in when they clicked the link). Adopt its address and open on
  // sign-up, same as if it had raised the card itself.
  useEffect(() => {
    if (!invitePrompt) return;
    setMode("sign-up");
    setEmail(invitePrompt.email);
  }, [invitePrompt?.id]);

  const chooseManaged = async () => {
    setServerError(null);
    writeServerChoice("managed");
    // DEFAULT_SERVER_URL, never the production constant: a dev build refuses a
    // persisted production URL (`resolveServerUrl`), so hard-coding it here
    // would "save" and then snap back to localhost with no explanation.
    if (serverUrl !== DEFAULT_SERVER_URL) {
      await useStore.getState().setServerUrl(DEFAULT_SERVER_URL);
    }
    setStep("form");
  };

  /**
   * Adopt a server address, but only after it answers. Checking first is the
   * difference between "wrong URL" being one inline sentence here and being a
   * `TypeError: Load failed` on the sign-in button three screens later.
   */
  const connectTo = async (raw: string) => {
    const url = normalizeServerUrl(raw);
    if (!url) {
      setServerError("That doesn't look like a server address — try https://notes.example.com");
      return;
    }
    setServerError(null);
    try {
      await authManager.api.health(url);
    } catch (e) {
      setServerError(serverFailureMessage(e, url));
      return;
    }
    writeServerChoice("custom");
    await useStore.getState().setServerUrl(url);
    useStore.getState().clearServerLink();
    setStep("form");
  };

  useEffect(() => {
    // A live session means this dialog is done — EXCEPT while a connect offer is
    // still awaiting an answer. Someone already signed in to one server can be
    // handed a link to another (that is the normal case for a teammate who
    // signed up on the managed instance by mistake), and closing the card out
    // from under them would apply nothing and explain nothing.
    if (step === "confirm-link") return;
    if (authStatus === "signed-in") {
      if (onSignedIn) onSignedIn();
      else onClose();
    }
  }, [authStatus, step, onClose, onSignedIn]);

  useEffect(() => {
    let cancelled = false;
    authManager.api
      .getAuthMethods()
      .then((m) => {
        if (cancelled) return;
        setGoogleAvailable(m.google);
        setResetAvailable(m.passwordReset);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "sign-in") {
        try {
          await useStore.getState().signIn(email.trim(), password);
        } catch (err) {
          // Dev convenience: the prefilled test account self-provisions on a
          // fresh database instead of dead-ending on "User not found".
          if (import.meta.env.DEV && email.trim() === "test@context.local") {
            await useStore.getState().signUp("Test User", email.trim(), password);
          } else {
            throw err;
          }
        }
      } else {
        await useStore.getState().signUp(name.trim(), email.trim(), password);
      }
      setPassword("");
    } catch {
      /* error surfaced via authError */
    } finally {
      setBusy(false);
    }
  };

  /**
   * Ask for a reset email and say what happened. The server resolves only when
   * the provider accepted the message; "no account on this server" and "the
   * provider refused it" come back as distinct errors, because both were being
   * hidden behind a neutral "check your inbox" that nothing ever arrived for.
   */
  const requestReset = async () => {
    const addr = email.trim();
    if (!addr) return;
    setResetError(null);
    try {
      await authManager.api.requestPasswordReset(addr);
      setResetSent(addr);
    } catch (e) {
      setResetError(passwordResetFailureMessage(e, { email: addr, serverHost: serverHost(serverUrl) }));
    }
  };

  /** Back to sign-in from the reset form or its confirmation. */
  const backToSignIn = () => {
    setResetSent(null);
    setResetError(null);
    setMode("sign-in");
  };

  // Each Google attempt gets a generation number. Cancelling (or starting a new
  // attempt) bumps it, so when an abandoned flow finally rejects — the loopback
  // listener waits out its ~3-min timeout — we can drop that stale result instead
  // of flashing a "timed out" error at someone who already moved on.
  const googleFlow = useRef(0);

  const googleSignIn = async () => {
    const flow = ++googleFlow.current;
    useStore.setState({ authError: null });
    setGoogleBusy(true);
    try {
      await useStore.getState().signInWithGoogle();
    } catch (e) {
      if (flow === googleFlow.current) {
        useStore.setState({ authError: e instanceof Error ? e.message : String(e) });
      }
      // else: cancelled or superseded — the user isn't waiting on this anymore.
    } finally {
      if (flow === googleFlow.current) setGoogleBusy(false);
    }
  };

  // Stop waiting on the browser and return to the form so the user can retry or
  // sign in with email instead. The abandoned loopback listener harmlessly times
  // out on its own; its late result is ignored via the generation check above.
  const cancelGoogleSignIn = () => {
    googleFlow.current++;
    setGoogleBusy(false);
    useStore.setState({ authError: null });
  };

  const title =
    step === "choose-server"
      ? "Where do your notes live?"
      : step === "confirm-link"
        ? `Connect to ${serverHost(pendingServerLink ?? serverUrl)}?`
        : mode === "reset"
          ? "Reset your password"
          : mode === "sign-in"
            ? "Welcome back"
            : "Create your account";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal auth-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {step === "choose-server" ? (
          <div className="server-choice">
            <p className="server-choice-lede">
              Your account and your team live on one server. Pick the managed
              service, or your team's own.
            </p>
            {/* Two cards, one class: a self-hosting team's members were signing
                up on the managed service because it was the only option with
                any visual weight at all. */}
            <button
              type="button"
              className="server-option"
              onClick={() => void chooseManaged()}
            >
              <span className="server-option-head">
                <span className="server-option-icon">
                  <CloudGlyph />
                </span>
                <span className="server-option-text">
                  <span className="server-option-title">Baalda managed service</span>
                  <span className="server-option-hint">
                    Hosted for you at {serverHost(DEFAULT_SERVER_URL)}
                  </span>
                </span>
                <span className="server-option-chevron">
                  <ChevronGlyph />
                </span>
              </span>
            </button>
            {/* A div, not a button: once open, this card holds the URL input
                and the Connect button, and interactive content can't nest
                inside a <button>. The header row stays the clickable part. */}
            <div className={`server-option${ownOpen ? " active" : ""}`}>
              <button
                type="button"
                className="server-option-head"
                aria-expanded={ownOpen}
                onClick={() => {
                  setOwnOpen(true);
                  setServerError(null);
                }}
              >
                <span className="server-option-icon">
                  <ServerGlyph />
                </span>
                <span className="server-option-text">
                  <span className="server-option-title">Your own server</span>
                  <span className="server-option-hint">
                    Self-hosted — enter the address your team gave you
                  </span>
                </span>
                <span className="server-option-chevron">
                  <ChevronGlyph />
                </span>
              </button>
              {ownOpen && (
                <div className="server-option-body">
                  <div className="row server-connect-row">
                    <input
                      autoFocus
                      value={urlDraft}
                      onChange={(e) => setUrlDraft(e.target.value)}
                      placeholder="https://notes.example.com"
                      spellCheck={false}
                      autoCapitalize="off"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void connectTo(urlDraft);
                        }
                      }}
                    />
                    <AsyncButton
                      type="button"
                      className="primary"
                      disabled={urlDraft.trim() === ""}
                      onClick={() => connectTo(urlDraft)}
                    >
                      Connect
                    </AsyncButton>
                  </div>
                  {serverError && <div className="auth-error">{serverError}</div>}
                </div>
              )}
            </div>
          </div>
        ) : step === "confirm-link" ? (
          <div className="server-choice">
            <p className="server-choice-lede">
              Your account and notes for this device will live on this server.
            </p>
            <code className="server-link-url">{pendingServerLink}</code>
            <div className="row server-connect-row">
              <AsyncButton
                type="button"
                className="primary"
                onClick={() => connectTo(pendingServerLink ?? "")}
              >
                Connect
              </AsyncButton>
              <button
                type="button"
                className="ghost-pill sm"
                onClick={() => {
                  useStore.getState().clearServerLink();
                  setServerError(null);
                  setStep(stepAfterServer());
                }}
              >
                Not now
              </button>
            </div>
            {serverError && <div className="auth-error">{serverError}</div>}
          </div>
        ) : (
          <>
            {/* Why this card is on screen. Without it an invitation link opens
                an unexplained password prompt, and the one thing the person
                needs to know — use the invited address — is unsaid. */}
            {invitePrompt && (
              <p className="auth-invite-lede">
                <strong>{invitePrompt.inviterName ?? "A teammate"}</strong> invited you to
                join <strong>{invitePrompt.organizationName}</strong>. Sign in — or create an
                account — with <strong>{invitePrompt.email}</strong> to accept.
              </p>
            )}
            {mode !== "reset" && (
              <div className="segmented">
                <button
                  className={mode === "sign-in" ? "active" : ""}
                  onClick={() => setMode("sign-in")}
                  type="button"
                >
                  Sign in
                </button>
                <button
                  className={mode === "sign-up" ? "active" : ""}
                  onClick={() => setMode("sign-up")}
                  type="button"
                >
                  Sign up
                </button>
              </div>
            )}

            {mode !== "reset" && googleAvailable && (
              <>
                <button
                  type="button"
                  className="oauth-btn google"
                  onClick={() => void googleSignIn()}
                  disabled={busy || googleBusy}
                  aria-busy={googleBusy}
                >
                  <GoogleGlyph />
                  <span>
                    {googleBusy ? "Waiting for your browser…" : "Continue with Google"}
                  </span>
                  {googleBusy && <Spinner size="xs" tone="neutral" />}
                </button>
                {googleBusy && (
                  <p className="auth-hint">
                    <button type="button" className="link-btn" onClick={cancelGoogleSignIn}>
                      Cancel
                    </button>
                  </p>
                )}
                <div className="auth-divider">
                  <span>or</span>
                </div>
              </>
            )}

            {mode === "reset" ? (
              resetSent ? (
                // Shown only after the server confirmed the provider took the
                // message, so this sentence is a fact rather than a hope.
                <div className="auth-reset-done">
                  <p>
                    Reset link sent to <strong>{resetSent}</strong>. Check your inbox (and
                    spam) — the link is valid for one hour. Setting a new password there
                    brings you back here to sign in.
                  </p>
                  <button type="button" className="link-btn" onClick={backToSignIn}>
                    Back to sign in
                  </button>
                </div>
              ) : (
                <form
                  className="auth-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void requestReset();
                  }}
                >
                  <p className="auth-reset-lede">
                    Enter your email and we'll send a link to choose a new password.
                  </p>
                  <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    autoFocus
                    required
                  />
                  {/* `type="button"`, not submit: a submit button fires its
                      own onClick AND the form's onSubmit, which would ask for
                      two reset emails per click. The form's onSubmit is still
                      there for the Enter key. */}
                  <AsyncButton
                    type="button"
                    className="primary"
                    disabled={email.trim() === ""}
                    onClick={requestReset}
                  >
                    Email me a reset link
                  </AsyncButton>
                  <button type="button" className="link-btn" onClick={backToSignIn}>
                    Back to sign in
                  </button>
                </form>
              )
            ) : (
              <form onSubmit={submit} className="auth-form">
                {mode === "sign-up" && (
                  <input
                    placeholder="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    required
                  />
                )}
                <input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus
                  required
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  minLength={8}
                  required
                />
                {mode === "sign-in" && resetAvailable && (
                  <p className="auth-forgot">
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setResetError(null);
                        setResetSent(null);
                        setMode("reset");
                      }}
                    >
                      Forgot password?
                    </button>
                  </p>
                )}
                <button
                  className={`primary${busy ? " is-busy" : ""}`}
                  type="submit"
                  disabled={busy || googleBusy}
                  aria-busy={busy || undefined}
                >
                  <span className="async-btn-label">
                    {mode === "sign-in" ? "Sign in" : "Create account"}
                  </span>
                  {busy && <Spinner size="xs" tone="on-accent" />}
                </button>
              </form>
            )}
            {resetError && <div className="auth-error">{resetError}</div>}
            {/* The invitation is bound to ONE address. Said, not enforced: the
                person may legitimately hold an account under another email, and
                the server's mismatch error explains that case properly. */}
            {invitePrompt &&
              mode !== "reset" &&
              email.trim() !== "" &&
              email.trim().toLowerCase() !== invitePrompt.email.toLowerCase() && (
                <p className="auth-hint">
                  This invitation was sent to {invitePrompt.email}. Use that address, or it
                  can't be accepted.
                </p>
              )}

            {/* Which server this form is about to post to. An account is
                per-server, so on a team that self-hosts this line is the
                difference between joining your team and starting a private
                vault on someone else's instance. */}
            <p className="auth-server-note">
              <span>
                {mode === "reset"
                  ? "Resetting your password on "
                  : mode === "sign-in"
                    ? "Signing in to "
                    : "Creating your account on "}
                <strong>{serverHost(serverUrl)}</strong>
              </span>
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setUrlDraft("");
                  setOwnOpen(false);
                  setServerError(null);
                  setStep("choose-server");
                }}
              >
                Change
              </button>
            </p>

            {/* Gated on the mode: a sign-in failure still sitting in the store
                would otherwise render under the reset form as if the reset had
                failed. */}
            {mode !== "reset" && authError && <div className="auth-error">{authError}</div>}
            {/* The one trap this form can't detect: an account created THROUGH
                Google has no password at all, so email sign-in answers "Invalid
                email or password" and sign-up answers "already exists" — a dead end
                unless someone says the words. Shown only on that failure, and only
                when Google is actually offered. */}
            {/* Sign-up for an address that already has an account: the server
                refuses (and sends nothing), but "User already exists" alone
                leaves the person retyping. Offer the two exits. */}
            {authError != null && mode === "sign-up" && /already exists/i.test(authError) && (
              <p className="auth-hint">
                An account with this email already exists.{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    useStore.setState({ authError: null });
                    setMode("sign-in");
                  }}
                >
                  Sign in instead
                </button>
                {resetAvailable && (
                  <>
                    {" "}
                    or{" "}
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        useStore.setState({ authError: null });
                        setResetError(null);
                        setResetSent(null);
                        setMode("reset");
                      }}
                    >
                      reset your password
                    </button>
                  </>
                )}
                .
              </p>
            )}
            {authError != null &&
              googleAvailable &&
              mode === "sign-in" &&
              /invalid email or password/i.test(authError) && (
                <p className="auth-hint">
                  First joined with Google? That account has no password — use
                  “Continue with Google” above
                  {resetAvailable
                    ? ", or use “Forgot password?” to set one."
                    : "."}
                </p>
              )}
          </>
        )}
      </div>
    </div>
  );
}
