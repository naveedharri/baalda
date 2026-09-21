// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { MenuSelect } from "./MenuSelect";
import { keychainDelete, keychainGet, keychainSet } from "../lib/ipc";
import type { StewardProvider } from "../lib/housekeeper";

// OpenRouter catalog verified 2026-09-21; these chat models advertise structured output.
const MODEL_OPTIONS = [
  { value: "typesafe/jev-1.13", label: "Jev 1.13", hint: "TypeSafe · Default" },
  { value: "openai/gpt-6-astra", label: "GPT-6 Astra", hint: "OpenAI" },
  { value: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1", hint: "Anthropic" },
  { value: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", hint: "Google" },
  { value: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", hint: "DeepSeek" },
  { value: "qwen/qwen3.8-max-0902", label: "Qwen3.8 Max", hint: "Qwen" },
  { value: "x-ai/grok-4.6", label: "Grok 4.6", hint: "xAI" },
  { value: "custom", label: "Other model", hint: "Use an OpenRouter model ID" },
];

export function StewardProviderSettings({ identity, onChange, onReady, onSaved }: { identity: string; onChange: (provider: StewardProvider | null) => void; onReady?: (hasKey: boolean) => void; onSaved?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const preferencesKey = `steward:preferences:${identity}`;
  const [preferences] = useState(() => {
    try { return JSON.parse(localStorage.getItem(preferencesKey) ?? "null") as { enabled?: boolean; model?: string; custom?: boolean } | null; }
    catch { return null; }
  });
  const [enabled, setEnabled] = useState(preferences?.enabled !== false);
  const [model, setModel] = useState(typeof preferences?.model === "string" ? preferences.model : "typesafe/jev-1.13");
  const [custom, setCustom] = useState(preferences?.custom === true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    // Preferences contain no credentials. The API key is only kept in the OS keychain.
    try { localStorage.setItem(preferencesKey, JSON.stringify({ enabled, model, custom })); } catch { /* Storage may be unavailable. */ }
  }, [preferencesKey, enabled, model, custom]);
  const service = `steward:openrouter:${identity}`;
  useEffect(() => {
    let live = true;
    void keychainGet(service).then(value => { if (live) { setSaved(value); onReady?.(Boolean(value)); } }).catch(() => { if (live) { setMessage("Could not read the OS keychain. Try saving your key again."); onReady?.(false); } });
    return () => { live = false; };
  }, [service]);
  useEffect(() => {
    onChange(enabled && saved && model.trim() ? { name: "openrouter", apiKey: saved, model: model.trim(), mode: model.trim() === "typesafe/jev-1.13" ? "decisions" : "chat" } : null);
  }, [enabled, saved, model, custom, onChange]);
  const selected = MODEL_OPTIONS.find(option => option.value === model);
  return <div className="housekeeper-card steward-provider">
    <div className="steward-provider-heading"><div className="steward-provider-brand"><span className="steward-router-mark" aria-hidden="true">↗</span><div><h4>OpenRouter</h4>{!saved && <span className="housekeeper-detail">Connect your account</span>}</div></div>
    <label className="steward-toggle"><input type="checkbox" role="switch" aria-label="Enable OpenRouter" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span aria-hidden="true" /></label></div>
    {(!saved || editing) && <div className="steward-key-row"><label className="housekeeper-field"><span className="steward-sr-only">OpenRouter API key</span><input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={saved ? "Key saved securely" : "sk-or-…"} onChange={e => setKey(e.target.value)} /></label>
    <div className="housekeeper-actions">
      <button className="secondary" disabled={busy || !/^sk-or-[A-Za-z0-9_-]{10,250}$/.test(key.trim())} onClick={async () => {
        setBusy(true); setMessage("");
        try { await keychainSet(service, key.trim()); setSaved(key.trim()); setKey(""); setMessage("Key saved securely."); setEditing(false); onSaved?.(); }
        catch { setMessage("Could not save the key. Check OS keychain access and retry."); }
        finally { setBusy(false); }
      }}>Save key</button>
      <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Get a key ↗</a>
    </div>
    </div>}
    {saved && <div className="steward-key-status"><span className={`steward-connection-state${enabled ? " ready" : ""}`}><span aria-hidden="true" />{enabled ? "Key ready" : "Disabled"}</span><div><button className="secondary" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Change key"}</button>
      {saved && <button className="secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await keychainDelete(service); setSaved(null); setKey(""); setMessage("Key removed."); onReady?.(false); }
        catch { setMessage("Could not remove the saved key. Retry."); }
        finally { setBusy(false); }
      }}>Remove key</button>}
</div></div>}
    {message && <p role="status">{message}</p>}
    <div className="housekeeper-field"><span>Model</span>
      <MenuSelect direction="down" value={custom ? "custom" : model} ariaLabel="Model" triggerClassName="steward-model-trigger" menuClassName="steward-model-menu"
        options={MODEL_OPTIONS}
        triggerContent={<><span className="steward-model-icon" aria-hidden="true">✦</span><span className="steward-model-label"><strong>{custom ? model || "Other model" : selected?.label ?? model}</strong><small>{custom ? "OpenRouter" : selected?.hint.replace(" · Default", "")}</small></span>{model === "typesafe/jev-1.13" && <span className="housekeeper-badge">Default</span>}</>}
        onSelect={value => { setCustom(value === "custom"); setModel(value === "custom" ? "" : value); }} />
    </div>
    {custom && <label className="housekeeper-field">OpenRouter model ID<input value={model} placeholder="provider/model" onChange={e => setModel(e.target.value)} /><span className="housekeeper-detail">Choose a chat model supporting structured JSON output.</span></label>}
  </div>;
}
