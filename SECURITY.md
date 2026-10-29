# Security Policy

Baalda handles authentication, per-file access control, and real-time
sync, so we take security reports seriously. Thank you for helping keep
users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub
issues, discussions, or pull requests.**

Instead, use one of these private channels:

1. **GitHub Private Vulnerability Reporting** (preferred): go to the
   repository's **Security** tab → **Report a vulnerability**.
2. **Email**: `security@baalda.com` with the subject line
   `SECURITY: Baalda`.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected component (desktop app, sync server, MCP endpoint, auth, etc.)
  and version / commit.
- Any suggested remediation.

## What to expect

- We **acknowledge** your report within **3 business days**.
- We send an initial assessment (severity, whether we can reproduce it)
  within **10 business days**.
- We aim to ship a fix for **critical** issues within **30 days**, and for
  other confirmed issues as soon as practical, usually within 90 days.
- We keep you updated while we work on it and coordinate a disclosure
  date with you.
- With your permission, we're happy to **credit** you once a fix ships.

Please give us reasonable time to remediate before any public disclosure.

## Safe harbour

We will not pursue or support legal action against you for security
research that follows this policy in good faith. That means you:

- Only test against accounts and vaults you own, or have explicit
  permission to test.
- Do not access, change or delete other people's data beyond the minimum
  needed to show the issue, and stop and tell us as soon as you reach
  someone else's data.
- Do not degrade the service for other users (no load or denial-of-service
  testing, no spam).
- Give us reasonable time to fix the issue before telling anyone else.

If you're unsure whether something is allowed, ask us first at
`security@baalda.com`. If a third party takes legal action against you
for research done under this policy, we will make it known that your
actions were authorised by us.

## Scope

In scope, with particular interest in:

- Authentication and session handling (Better Auth, argon2id, bearer tokens).
- Per-file / per-folder permission resolution and the sync-token ACL gate.
- The MCP endpoint and token scoping.
- Public note links and the pages the server renders.
- Path-safety in the Rust core (`resolve_in_vault`, attachments).
- Sanitization of rendered HTML / live-preview and HTML dashboards.
- The desktop updater and release signing.

Out of scope:

- Misconfiguration of a self-hosted server by its operator (for example a
  weak `JWT_SECRET`, a database exposed to the internet, or no TLS). Bugs
  in the code that self-hosters run are in scope.
- Denial-of-service, load and rate-limit exhaustion testing.
- Social engineering, phishing, or physical attacks on staff or users.
- Reports from automated scanners without a demonstrated impact.
- Missing best-practice headers or settings with no exploitable impact.
- Issues that need a compromised device, OS account or keychain.

## Supported versions

Baalda is pre-1.0. Security fixes target the latest `main`. Pin to a
released tag for production and update promptly when fixes are published.
