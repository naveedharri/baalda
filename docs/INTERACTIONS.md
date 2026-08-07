---
type: reference
product: Baalda
date: 2026-08-07
tags: [baalda, design, ux, interactions]
---

# Interaction inventory & feedback rules

> Every action the desktop app can take, how long it takes, and what it shows
> while it does. Back to index: [[Baalda]].

Two things live here: the **rules** (how any asynchronous action reports for
itself) and the **inventory** (every action, audited against those rules). If you
add a control, add it to the table.

---

## The rules

Derived from the response-time thresholds people actually perceive
([Nielsen's three limits](https://www.nngroup.com/articles/response-times-3-important-limits/),
still the basis of modern guidance) and from Dan Saffer's
[four parts of a microinteraction](https://www.oreilly.com/library/view/microinteractions-full-color/9781491945926/)
— **trigger, rules, feedback, loops**. Features get people to the product;
details are why they stay.

1. **Acknowledge the trigger in the same frame.** Every button has a physical
   press state (`:active`). This is free, needs no state, and it is what makes a
   slow action feel *responsive* rather than *ignored* — the two are different
   properties and only the second is a bug.
2. **Label the wait only after ~140ms** (`SPINNER_DELAY` in
   `lib/useAsyncAction.ts`). Under ~100ms an action already feels instantaneous;
   a spinner that appears immediately flashes on and off and reads as a
   rendering fault. Actions that are usually fast therefore stay visually silent
   and only grow an indicator when they genuinely stall.
3. **Disable on the first click, not on the first spinner.** `useAsyncAction`
   keeps `pending` (true immediately, for the re-entrancy guard) separate from
   `showPending` (true after the delay, for rendering). Conflating them
   double-submits.
4. **Never change size mid-action.** A spinner sits *beside* a label whose width
   is already reserved. A control that grows under the cursor pulls a different
   control into the click.
5. **Optimism where the destination is known.** A vault switch renames the
   sidebar to the target vault immediately; clicking a note selects its row
   immediately. Showing the *old* state until the last round trip is what makes
   a working action look broken. If it fails, the state snaps back.
6. **Hold success long enough to be seen** (`DONE_HOLD`, 900ms). A tick that
   vanishes with the spinner was never feedback.
7. **Errors do not auto-dismiss.** A failure the user blinked past becomes
   "nothing happened" in a bug report. Successes and neutrals fade on their own.
8. **Every animation has a reduced-motion answer**, and the information survives
   the motion being switched off. Spinners *slow* rather than stop — a frozen
   ring says "hung", which is the one thing it must never say.

### Which surface

| Surface | For | Persistence |
| --- | --- | --- |
| Press state | acknowledging a click | instant |
| In-control spinner | this control is working | until it settles |
| Skeleton | content is arriving, roughly this shape | until content lands |
| Toast (`lib/toast.ts`) | an outcome you may miss twice | ~4.2s; errors sticky |
| Banner (`App.tsx`) | something needing a decision | until dismissed/resolved |
| Progress bar | a determinate transfer | until complete |

---

## Inventory

**Latency** is the realistic worst case, not the best. ✅ = reports for itself;
n/a = synchronous or sub-100ms by construction.

### Welcome screen — `components/VaultPicker.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| New vault | read vaults root | fast | n/a |
| Create vault | mkdir + open + seed ~20 notes | 1–3s | ✅ label + spinner |
| Open existing | native picker → open + reconcile | 1–5s | ✅ label + spinner |
| Recent vault row | full vault open (+ switch if remote) | 1–5s | ✅ per-row spinner, "Opening…" |
| Remove from recents | local list write | fast | n/a (row leaves) |
| Sign in (link) | opens the modal | instant | n/a |
| *post-sign-in landing* | resolve/create vault, folder, seed | 1–5s | ✅ "Opening your vault…" |

### Auth — `components/AccountMenu.tsx` (`AuthDialog`)

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Sign in / Create account | auth + roster + billing + land in a vault | 1–5s | ✅ label + spinner |
| Continue with Google | system browser + loopback | up to 3 min | ✅ "Waiting for your browser…" + spinner + Cancel |
| Save server URL | re-read session against a new host | 0.3–2s | ✅ spinner + tick |

### Vault switching & membership — `components/AccountMenu.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Switch vault (menu row) | 6+ round trips, then folder swap | 1–5s | ✅ sidebar renames to target + spinner; tree fades and stops taking clicks |
| Switch vault (settings) | same | 1–5s | ✅ per-button spinner + the above |
| Accept invitation | accept → switch → bind folder → reconcile | 1–5s | ✅ spinner |
| Join by code | join → switch → reconcile | 1–5s | ✅ existing busy state |
| New vault (menu) | create org → folder → seed | 1–3s | ✅ existing busy state |
| Remove from device | local teardown | 0.2–1s | ✅ spinner |
| Delete vault (permanent) | server delete + local teardown | 0.5–3s | ✅ spinner, behind a confirm |
| Delete local vault files | move folder to Trash | 0.2–2s | ✅ spinner, behind a confirm |
| Invite member | server write + roster refresh | 0.3–1s | ✅ existing busy state |
| Remove member | server write + ACL broadcast | 0.3–1s | ✅ spinner, behind a confirm |
| Copy join code | clipboard | instant | ✅ existing "Copied" |
| Manage subscription | billing portal + browser handoff | 1–4s | ✅ spinner |
| Create / revoke MCP token | server write | 0.3–1s | ✅ spinner |
| Import files / folder / Export vault | disk walk + registry | 1s–minutes | ✅ existing busy + counts |
| Change vaults root | native picker + config write | fast | n/a |
| Check for update | network | 0.5–3s | ✅ existing update state |
| Install & Restart | download installer, then relaunch | 5s–minutes | ✅ spinner + progress bar in the banner |

### Sidebar — `components/FileTree.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Open a note | meta read + server register | 0.05–2s | ✅ row pre-selects, glyph → spinner, editor skeleton |
| New note / New folder | atomic write + reindex | fast | n/a (row appears) |
| Rename (inline) | disk rename + registry | 0.1–1s | n/a — inline edit already commits visibly |
| Delete (single / bulk) | deepest-first disk + server | 0.2s–10s | ✅ bulk progress counter |
| Lock / Unlock selected | one round trip **per item** | 0.3s–10s | ✅ spinner replaces the padlock |
| Import files / folder | disk copy + registry | 1s–minutes | ✅ toast with counts |
| Export… | disk copy outside the vault | 0.2s–30s | ✅ toast (nothing in-app changes otherwise) |
| Share… | opens the dialog | instant | n/a |
| Set colour, reorder, drag-move | local + registry | fast | n/a |

### Editor & main — `components/Editor.tsx`, `App.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Note open (bridge + first sync) | SQLite hydrate + provider sync | 0.05–3s | ✅ skeleton in the prose column, delayed 180ms |
| Typing / autosave | debounced egest | n/a | ✅ existing "Auto-saved" |
| Push-to-talk | mic + relay | instant | ✅ existing talk states |
| Search | local FTS5 | fast | n/a |
| Graph view | in-memory sim | fast | n/a |
| Ping a peer | awareness field | instant | ✅ existing ping toast |

### Known gaps (deliberate, not oversights)

- **Rename** has no spinner. It is an inline edit that already commits visibly,
  and a spinner over a text field you just typed into is noise.
- **`useAsyncAction` has no unit test.** It is a React hook and the repo has no
  `@testing-library/react`; adding one for a 140-line hook was not worth a new
  dependency. Its two constants are exported and documented, and the pure pieces
  around it (`lib/toast.ts`, `lib/vault/landing.ts`) are covered.
- **Bulk lock/unlock has no per-item counter** the way bulk delete does. Same
  shape of work, so it should get one; the spinner is the floor, not the ceiling.
