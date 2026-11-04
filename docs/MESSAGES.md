# Messages to users

A server can show its users a short message in the desktop app: a popup, a banner or a toast.
Messages live in the server's database, so sending one needs no app release. Each message decides
who sees it, how it looks, when and how often it shows, and what its buttons do. The app only
follows those settings.

Nothing executable travels: the body is plain text, and buttons come from a fixed list of actions.

## Turning it on

Set `BAALDA_ADMIN_TOKEN` on the server to a random string of at least 32 characters, for example
`openssl rand -hex 32`. Unset (the default), the admin routes answer 404 and no one can create
messages. A wrong or missing token also gets 404.

Desktops fetch `GET /api/messages` at launch, every 10 minutes and whenever the server pushes a
"messages changed" hint over the vault channel, so a new message arrives within seconds. Apps that
predate messages ignore all of this.

## The script

From `app/apps/server`:

```bash
export BAALDA_SERVER_URL=https://your-server.example.com
export BAALDA_ADMIN_TOKEN=...            # the value set on the server

pnpm messages list                       # every message, archived ones included
pnpm messages create message.json        # a new message
pnpm messages update <id> message.json   # replace a message's settings (not archived ones)
pnpm messages archive <id>               # stop showing it; cannot be undone
pnpm messages stats <id>                 # shown / snoozed / dismissed / done / people
```

The script prints the server's JSON answer and never prints the token. It calls
`/api/admin/messages` with the header `x-baalda-admin-token`; any HTTP client can do the same.

## Message fields

Only `id`, `title` and `body` are required. Any other top-level field the server does not know is
refused (400 `invalid_message`).

| Field | Meaning | Default |
| --- | --- | --- |
| `id` | Lowercase letters, digits and `-`, 3 to 80 characters. Never reused. | required |
| `title` | 1 to 120 characters. | required |
| `body` | 1 to 2000 characters. A blank line starts a paragraph; `**bold**` and `https://` links work; nothing else is formatted. | required |
| `icon` | `key`, `lock`, `shield`, `info`, `sparkle`, `warning`, `bell`, `gift`. | none |
| `tone` | `info`, `important`, `warning`, `success`. | `info` |
| `display.kind` | `popup` (a dialog), `banner` (the notice line above the editor) or `toast`. | `popup` |
| `display.size` | Popup width: `small`, `medium`, `large`. | `medium` |
| `display.dismissible` | Whether Escape or a click outside also closes it. The × is always there; closing counts as a dismiss (see below). | `true` |
| `trigger.on` | `launch`, `vault-open` or `anytime`. | `anytime` |
| `trigger.delaySeconds` | Wait after the trigger, 0 to 600. | `0` |
| `frequency.mode` | `once`, `until-done` or `every` (see below). | `until-done` |
| `frequency.everyHours` | For `every`: hours between showings, 1 to 8760. | `24` |
| `frequency.maxShows` | Stop after this many showings, 1 to 1000. | no limit |
| `frequency.minHoursBetweenShows` | Never show again sooner than this, 1 to 8760. Also how long a dismiss hides an `until-done` message. | `24` |
| `priority` | -1000 to 1000. When several are pending, the highest shows first, one at a time. | `0` |
| `perVault` | `true`: one copy per matching vault, each with its own receipts, and `{vaultName}` in the copy. `false`: one per account. | `false` |
| `startsAt` / `endsAt` | ISO times; outside the window nobody sees it. | always |
| `audience` | Who it is for (below). | everyone |
| `condition` | A built-in rule (below). | none |
| `actions` | Up to 4 buttons (below). | none |

`{vaultName}` and `{name}` in `title` and `body` are filled in by the app.

### Audience

Every field is optional, and all the given ones must match.

| Field | Matches |
| --- | --- |
| `roles` | People with one of these roles (`owner`, `admin`, `member`) in at least one vault. |
| `userIds` | These accounts. |
| `emails` | These email addresses (case-insensitive). |
| `orgIds` | Members of these vaults. |
| `encryptedVaults` | `true`: only people in a vault that uses vault keys. |
| `minVersion` / `maxVersion` | The desktop's version is in this range. An app that does not report its version fails `minVersion`. Use `minVersion` when a message relies on an option older apps do not know. |
| `signedUpBefore` / `signedUpAfter` | ISO times, compared with the account's creation. |

### Conditions

A condition is a rule built into the server. An unknown condition matches nobody.

- `vault-key-not-saved`: one result per vault that uses vault keys, where this person is the
  owner and has not recorded saving the current key (by saving it to a file or confirming they
  saved it). A new key asks again. Use it with `perVault: true`. The app also skips it on a
  computer that cannot show the key.

### Actions

Each action has an `id` (unique in the message), a `label` (1 to 40 characters), a `kind`, an
optional `style` (`primary`, `secondary`, `quiet`, `danger`) and `then`: what happens to the
message after the click (`done`, `snooze` or `close`).

| `kind` | Does | Settings |
| --- | --- | --- |
| `dismiss` | Closes the message. | |
| `remind-later` | Hides it for a while. | `hours`, 1 to 720 (default 72) |
| `done` | Ends it for this person on every computer. | |
| `open-settings` | Opens a settings page. | `target`, e.g. `vault:general#security`, `account:about` |
| `open-url` | Opens a link in the browser. | `url`, must start with `https://` |
| `save-vault-key` | Runs "Save to file" for the vault key, then marks the message done. | |

An app skips a `kind` it does not know.

### How often it shows

What a person did is stored per account on the server, so it holds on every computer they use.

- **Done** ends the message for good.
- **Remind me later** (snooze) hides it until the action's `hours` pass.
- **Dismiss** (× or a `dismiss` action):
  - `once`: the message never shows again. It also stops after the first showing.
  - `until-done`: hidden for `minHoursBetweenShows`, then it comes back until it is done.
  - `every`: it comes back every `everyHours` until it is done.
- `maxShows` and `minHoursBetweenShows` apply on top of every mode.

## Examples

A reminder to owners to save their vault key, once per vault, until they do. It shows when the
vault finishes encrypting, then again an hour later for as long as the key is unsaved:

```json
{
  "id": "save-vault-key-2026-11",
  "condition": "vault-key-not-saved",
  "audience": { "minVersion": "0.1.111" },
  "perVault": true,
  "display": { "kind": "popup", "size": "medium", "dismissible": false },
  "trigger": { "on": "vault-open", "delaySeconds": 8 },
  "frequency": { "mode": "until-done", "minHoursBetweenShows": 1 },
  "priority": 100,
  "icon": "key",
  "tone": "important",
  "title": "Keep a copy of your vault key",
  "body": "{vaultName} is protected by a key that only your team's computers hold. If you ever lose access to them, this key is the only way to get your notes back.\n\nSave it somewhere safe, like your password manager.",
  "actions": [
    { "id": "save", "kind": "save-vault-key", "label": "Save to file", "style": "primary", "then": "done" },
    { "id": "open", "kind": "open-settings", "target": "vault:general#security", "label": "Show key", "then": "close" },
    { "id": "later", "kind": "remind-later", "hours": 1, "label": "Remind me later", "then": "snooze" },
    { "id": "already", "kind": "done", "label": "I already saved it", "style": "quiet", "then": "done" }
  ]
}
```

(Set `minVersion` to the first desktop release that has the `save-vault-key` action.)

A one-time announcement banner for everyone, for a week:

```json
{
  "id": "maintenance-2026-12-01",
  "display": { "kind": "banner" },
  "frequency": { "mode": "once" },
  "endsAt": "2026-12-01T06:00:00Z",
  "tone": "info",
  "title": "Planned maintenance on Sunday",
  "body": "Sync pauses for about 10 minutes on Sunday at 05:00 UTC. Your notes stay on your computer and sync again on their own.",
  "actions": [{ "id": "ok", "kind": "dismiss", "label": "Got it", "then": "done" }]
}
```
