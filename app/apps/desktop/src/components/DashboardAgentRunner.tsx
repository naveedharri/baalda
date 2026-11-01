// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  appendAgentLog, cancelDashboardAgent, detectInstalledAgents, runDashboardAgent,
  type InstalledAgent,
} from "../lib/dashboard/agent";
import { DASHBOARD_AGENT_LAUNCH, type DashboardAgentLaunch } from "../lib/dashboard/agentLaunch";
import { toast } from "../lib/toast";
import "./DashboardAgentRunner.css";
import claudeLogo from "../assets/agents/claude-color.svg";
import codexLogo from "../assets/agents/codex.svg";

function useInstalledAgents() {
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void detectInstalledAgents().then((value) => { if (alive) setAgents(value); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);
  return { agents, error };
}

function AgentGlyph({ agent }: { agent: string | null }) {
  return <img className={`agent-brand agent-brand-${agent}`} src={agent === "claude" ? claudeLogo : codexLogo} alt="" aria-hidden="true" />;
}

/** Trusted app chrome only: never expose this component through the page bridge. */
export function DashboardAgentRunner({ path, expectedEpoch, launchTarget, showLaunchers = true, rightPanelOpen = false, onOpen }: { path: string | null; expectedEpoch: number; launchTarget?: HTMLElement | null; showLaunchers?: boolean; rightPanelOpen?: boolean; onOpen?: () => void }) {
  const { agents, error: detectionError } = useInstalledAgents();
  const [selectedAgent, setSelectedAgent] = useState<InstalledAgent["agent"] | null>(null);
  const [open, setOpen] = useState(false);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const installed = agents?.find((a) => a.agent === selectedAgent);
  const agentName = selectedAgent === "claude" ? "Claude" : "Codex";
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState("");
  const [history, setHistory] = useState<Array<{ request: string; response: string }>>([]);
  const [submitted, setSubmitted] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "stopping" | "success" | "stopped" | "error">("idle");
  const lastText = useRef("");
  const stopping = useRef(false);
  const followOutput = useRef(true);
  const runId = useRef<string | null>(null);
  const alive = useRef(true);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const launchButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (runId.current) void cancelDashboardAgent(runId.current).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const previousRun = runId.current;
    runId.current = null;
    if (previousRun) void cancelDashboardAgent(previousRun).catch(() => {});
    setSelectedAgent(null); setOpen(false); setSessionPath(null); setRunning(false); setPrompt(""); setLog(""); setHistory([]); setSubmitted(""); setStatus(""); setPhase("idle");
  }, [expectedEpoch]);
  useEffect(() => { if (open) (running ? dialog.current : promptInput.current ?? dialog.current)?.focus(); }, [open]);
  useEffect(() => { if (rightPanelOpen) setOpen(false); }, [rightPanelOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || dialog.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".dashboard-agent-launch")) return;
      setOpen(false);
    };
    // Window blur covers other apps as well as focus moving into an iframe.
    const dismiss = () => setOpen(false);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Native focus events also cover WebViews that retain DOM focus on app blur.
    void Promise.resolve().then(() => getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!disposed && !payload) dismiss();
    })).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => { /* Browser previews use DOM blur instead. */ });
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", dismiss);
      disposed = true;
      unlisten?.();
    };
  }, [open]);
  useEffect(() => { if (output.current && followOutput.current) output.current.scrollTop = output.current.scrollHeight; }, [log]);

  useEffect(() => {
    const launch = (event: Event) => {
      const request = (event as CustomEvent<DashboardAgentLaunch>).detail;
      if (!request || request.expectedEpoch !== expectedEpoch || !request.path
        || !["claude", "codex"].includes(request.agent)) return;
      onOpen?.();
      launchButton.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
      if (runId.current) {
        if (request.agent !== selectedAgent || request.path !== sessionPath) {
          toast("An update is already running. Finish or stop it before starting another.", "neutral");
        }
        setOpen(true);
        return;
      }
      if (request.agent !== selectedAgent || request.path !== sessionPath) {
        setSelectedAgent(request.agent); setSessionPath(request.path);
        setPrompt(""); setLog(""); setHistory([]); setSubmitted(""); setStatus(""); setPhase("idle");
      }
      setOpen(true);
    };
    window.addEventListener(DASHBOARD_AGENT_LAUNCH, launch);
    return () => window.removeEventListener(DASHBOARD_AGENT_LAUNCH, launch);
  }, [expectedEpoch, selectedAgent, sessionPath, onOpen]);

  const close = () => {
    setOpen(false);
    const trigger = launchButton.current?.isConnected ? launchButton.current
      : launchTarget?.querySelector<HTMLButtonElement>(`button[data-agent="${selectedAgent}"]`);
    trigger?.focus();
  };
  const stop = async () => {
    const id = runId.current;
    if (!id) return;
    stopping.current = true;
    setPhase("stopping");
    setStatus(`Stopping ${agentName}…`);
    try { await cancelDashboardAgent(id); }
    catch {
      if (!alive.current || runId.current !== id) return;
      stopping.current = false; setPhase("running");
      setStatus("Could not request cancellation. The run will stop after its time limit.");
    }
  };
  const start = async () => {
    if (!selectedAgent || !sessionPath || !installed?.runnable || runId.current || !prompt.trim()) return;
    const previous = submitted ? [...history, { request: submitted, response: log }].slice(-6) : history;
    setHistory(previous); setSubmitted(prompt.trim()); setPrompt("");
    const context = previous.length ? `Previous conversation about this dashboard (context only):\n${previous.map((turn) => `User: ${turn.request}\nAssistant: ${turn.response}`).join("\n\n").slice(-16000)}\n\nCurrent request:\n${prompt}` : prompt;
    const id = crypto.randomUUID(); runId.current = id;
    lastText.current = ""; stopping.current = false; followOutput.current = true;
    setRunning(true); setPhase("running"); setLog(""); setStatus(`Starting ${agentName}…`);
    try {
      await runDashboardAgent({ agent: selectedAgent, prompt: context, dashboardPath: sessionPath, expectedEpoch, runId: id }, (event) => {
        if (!alive.current || runId.current !== id) {
          if (event.type === "started") void cancelDashboardAgent(id).catch(() => {});
          return;
        }
        if (event.type === "text" && event.text.trim() && event.text.trim() !== lastText.current) {
          lastText.current = event.text.trim();
          setLog((previous) => appendAgentLog(previous, event.text.trim()));
        }
        if (event.type === "status" && !stopping.current) setStatus(event.text);
        if (event.type === "started" && !stopping.current) setStatus(`${agentName} is updating your dashboard…`);
        if (event.type === "finished") {
          setPhase(event.cancelled ? "stopped" : event.success ? "success" : "error");
          setStatus(event.cancelled ? "Stopped. Changes already written remain in the vault." : event.success ? "Finished. Your dashboard reloads as files change." : `${agentName} could not finish. Check the output below and its sign-in or account limits.`);
        }
      });
    } catch (error) {
      if (alive.current && runId.current === id) { setPhase("error"); setStatus(String(error)); }
    } finally {
      if (alive.current && runId.current === id) { setRunning(false); runId.current = null; }
    }
  };

  const launchButtons = (["claude", "codex"] as const).filter((agent) => path || (agent === selectedAgent && sessionPath)).map((agent) => <button key={agent} type="button" data-agent={agent} className={`ghost-pill sm dashboard-agent-launch${agent === selectedAgent && phase !== "idle" ? ` agent-launch-${phase}` : ""}`} aria-label={`Update with ${agent === "claude" ? "Claude" : "Codex"}${agent === selectedAgent && phase !== "idle" ? `: ${phase === "success" ? "completed" : phase === "error" ? "failed" : phase}` : ""}`} title={agent === selectedAgent && sessionPath ? `${agent === "claude" ? "Claude" : "Codex"} · ${sessionPath}${phase !== "idle" ? ` · ${phase}` : ""}` : `Update with ${agent === "claude" ? "Claude" : "Codex"}`}
      disabled={running && agent !== selectedAgent}
      onClick={(event) => {
        onOpen?.();
        launchButton.current = event.currentTarget;
        if (agent !== selectedAgent || !sessionPath) {
          if (!path || running) return;
          setSelectedAgent(agent); setSessionPath(path); setPrompt(""); setLog(""); setHistory([]); setSubmitted(""); setStatus(""); setPhase("idle");
        }
        setOpen(true);
      }}>
      <AgentGlyph agent={agent} /><span className="dashboard-agent-launch-prefix">Update with </span>{agent === "claude" ? "Claude" : "Codex"}
      {agent === selectedAgent && phase !== "idle" && <span className="dashboard-agent-launch-status"><i aria-hidden="true" />{phase === "running" ? "Working" : phase === "stopping" ? "Stopping" : phase === "success" ? "Done" : phase === "stopped" ? "Stopped" : "Failed"}</span>}
    </button>);
  return <>
    {!open && selectedAgent && phase !== "idle" && <span className="dashboard-agent-announcement" role="status">{agentName}: {status}</span>}
    {showLaunchers && (launchTarget === undefined ? launchButtons : launchTarget ? createPortal(launchButtons, launchTarget) : null)}
    {open && !rightPanelOpen && createPortal(
      <div className={`dashboard-agent-backdrop provider-${selectedAgent}`} onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="false" aria-labelledby="dashboard-agent-title" className="dashboard-agent-dialog"
          onKeyDownCapture={(event) => {
            if ((event.metaKey || event.ctrlKey) && ["n", "w", "f", "k", "p", "g", "h"].includes(event.key.toLowerCase())) {
              event.preventDefault(); event.stopPropagation();
            }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }

          }}>
          <div className="dashboard-agent-heading">
            <span className="dashboard-agent-avatar"><AgentGlyph agent={selectedAgent} /></span>
            <div className="dashboard-agent-heading-copy">
              <h2 id="dashboard-agent-title">Update with {agentName}</h2>
              <span className="dashboard-agent-path" title={sessionPath ?? undefined}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 3H5v18h14V8zm0 0v5h5" /></svg>{sessionPath?.split("/").pop()}</span>
            </div>
            <button type="button" className="icon-btn" onClick={close} aria-label="Close agent dialog" title={running ? "Hide chat (update continues)" : "Close"}>×</button>
          </div>
          <section className={`dashboard-agent-progress phase-${phase}`} aria-label="Update progress">
            <div className="dashboard-agent-status" role="status">
              <span className="dashboard-agent-status-pill"><span className="dashboard-agent-status-icon" aria-hidden="true" />{phase === "running" ? "Working" : phase === "stopping" ? "Stopping" : phase === "success" ? "Complete" : phase === "stopped" ? "Stopped" : phase === "error" ? "Needs attention" : installed?.runnable ? "Ready" : agents === null && !detectionError ? "Checking" : "Setup required"}</span>
              <span key={status} className="dashboard-agent-status-text">{status || (installed?.runnable ? "Changes appear live in your dashboard." : "Connect your installed agent to get started.")}</span>
            </div>
            <div ref={output} className="dashboard-agent-output" aria-label="Recent agent output"
              onScroll={() => { const el = output.current; if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
              {history.map((turn, index) => <div className="dashboard-chat-turn" key={index}><div className="dashboard-chat-user">{turn.request}</div><div className="dashboard-agent-message">{turn.response.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div></div>)}
              {submitted && <div className="dashboard-chat-user">{submitted}</div>}
              {log ? <div className="dashboard-agent-message"><span className="dashboard-agent-message-author"><span className="dashboard-agent-mini-avatar"><AgentGlyph agent={selectedAgent} /></span>{agentName}</span><div>{log.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div></div>
                : <div className="dashboard-agent-output-empty">
                  <span className="dashboard-agent-empty-glyph"><AgentGlyph agent={selectedAgent} /></span>
                  <strong>{phase === "idle" ? installed?.runnable ? "Make this dashboard yours" : `Set up ${agentName}` : running ? `${agentName} is on it` : phase === "success" ? "Your update is complete" : phase === "stopped" ? "Update stopped" : "The update couldn't finish"}</strong>
                  <p>{phase === "idle" ? installed?.runnable ? "Describe a change below. Your agent uses your vault’s context to update this dashboard." : detectionError ? "Could not check installed agents. Restart Baalda and try again." : agents === null ? "Checking your installed agents…" : installed?.detail ?? `Install ${agentName} and sign in from your terminal, then restart Baalda.` : running ? "Its response will appear here as it works." : "No written response was returned."}</p>
                  {running && <span className="dashboard-agent-thinking" aria-hidden="true"><i /><i /><i /></span>}
                </div>}
            </div>
          </section>
          {installed?.runnable && <div className={`dashboard-agent-composer${running ? " is-running" : ""}`}>
            <label htmlFor="dashboard-agent-prompt">{running ? "Your next message" : "What would you like to change?"}</label>
            <textarea id="dashboard-agent-prompt" ref={promptInput} rows={3} maxLength={8000} value={prompt}
              placeholder="Ask for a change…"
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }}
              onChange={(event) => setPrompt(event.target.value)} />
            <div className="dashboard-agent-actions">
              {!running && path && path !== sessionPath ? <button type="button" className="dashboard-agent-retarget" onClick={() => { setSessionPath(path); setPrompt(""); setLog(""); setHistory([]); setSubmitted(""); setStatus(""); setPhase("idle"); }}>Use current dashboard</button> : <span>{running ? "Updates continue when you close chat." : `Your ${agentName} account`}</span>}
              {running ? <button type="button" className="dashboard-agent-stop" disabled={phase === "stopping"} onClick={() => void stop()}>{phase === "stopping" ? "Stopping…" : "Stop"}</button> : <button type="button" className="primary" disabled={!prompt.trim()} onClick={() => void start()}>Run {agentName}</button>}
            </div>
          </div>}
        </div>
      </div>, document.body,
    )}
  </>;
}

/** Account Settings → About. Detection is cached until Baalda restarts. */
export function InstalledAgentsStatus() {
  const { agents, error } = useInstalledAgents();
  return <div className="installed-agents-status">
    <h3>Installed agents</h3>
    {error ? <p>Detection is unavailable in this preview.</p> : agents === null ? <p>Checking installed clients…</p> : !agents.length ? <p>No supported CLI detected. Install Claude or Codex and sign in from your terminal, then restart Baalda.</p> : agents.map((agent) =>
      <div key={agent.agent} className="installed-agent-row">
        <strong>{agent.agent === "codex" ? "Codex" : "Claude"}</strong>
        <span>{agent.version} · {agent.signedIn ? "Signed in" : "Sign-in not confirmed"}</span>
        <p>{agent.detail}</p>
      </div>,
    )}
    <p className="dashboard-agent-description">Detection refreshes when Baalda restarts. Dashboard updates use the selected CLI and its signed-in account.</p>
  </div>;
}

/** Account Settings → About, the Installed agents row's list (profile-row style). */
export function InstalledAgentsList() {
  const { agents, error } = useInstalledAgents();
  if (error) return <p className="muted">Detection is unavailable in this preview.</p>;
  if (agents === null) return <p className="muted">Checking installed clients…</p>;
  if (!agents.length) {
    return <p className="muted">No supported CLI found. Install Claude or Codex, sign in from your terminal, then restart Baalda.</p>;
  }
  return <ul className="about-agents">
    {agents.map((agent) => <li key={agent.agent} className="about-agent">
      <span className="about-agent-glyph" aria-hidden="true"><AgentGlyph agent={agent.agent} /></span>
      <span className="about-agent-text">
        <b>{agent.agent === "codex" ? "Codex" : "Claude"} <span className="about-agent-version">{agent.version}</span></b>
        <small title={agent.detail}>{agent.detail}</small>
      </span>
      <span className={`about-agent-tag${agent.signedIn ? "" : " is-off"}`}>{agent.signedIn ? "Signed in" : "Not signed in"}</span>
    </li>)}
  </ul>;
}
