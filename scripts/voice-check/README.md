# Voice broadcast live check

Unit tests cover the framing, relay, ordering and playback logic (`pnpm test`).
What they can't cover is the part that only exists at runtime: a **real second
teammate** on a **real `/vault-sync` socket**, streaming **real audio** into a
running desktop app. That's what this is for.

It is a manual dev tool, not part of `pnpm test` — it needs a live server, a
seeded vault, and a human with speakers.

## Usage

Server must be running (`pnpm run dev` in `app/apps/server`), and the desktop app
must be **signed in with sync enabled** — otherwise it holds no vault channel and
will hear nothing no matter how well the feature works. That is the single most
common reason "it doesn't work".

```bash
# 1. Find your vault id
docker exec context-pg psql -U context -d context -c "select id, name from vaults;"

# 2. Seed two throwaway teammates into that vault (idempotent)
VAULT_ID=<uuid> node scripts/voice-check/seed.mjs

# 3. Confirm the app is actually on the channel, and see who else is
VAULT_ID=<uuid> node scripts/voice-check/listen.mjs

# 4. Broadcast as "Ada" — you should hear it and see the megaphone shake
VAULT_ID=<uuid> node scripts/voice-check/broadcast.mjs "Hello from Ada"
```

`listen.mjs` is the diagnostic that matters. It prints every peer on the vault
channel; if your desktop app isn't in that list, the app isn't connected and no
amount of debugging the audio path will help.

## What it proves

Running `broadcast.mjs` while the app is open exercises the whole receive path
end to end: Better Auth session → vault token → WS handshake with `caps` → relay
fan-out → server-stamped identity → chunk ordering → PCM decode → gapless
scheduling → the speaking indicator and the receiving animation.

It does **not** exercise capture (`getUserMedia`, the AudioWorklet, the
resampler) — it feeds a pre-rendered file. Holding the button yourself is the
only way to test that half.

## Cleanup

The seeded users are `ada@example.com` / `grace@example.com`, members of your
vault's organization. Remove them with:

```bash
docker exec context-pg psql -U context -d context \
  -c "delete from \"user\" where email in ('ada@example.com','grace@example.com');"
```
