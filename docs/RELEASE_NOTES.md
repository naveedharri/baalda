<!--
  User-facing release notes. This file IS the GitHub release body and the in-app
  "What's New" modal, so write it for the person who just got the update.

  The rule, and the release workflow depends on it:

  - One `## <version>` section per release, newest first, matching the version in
    `app/apps/desktop/src-tauri/tauri.conf.json`.
  - 2–5 points per section. Combine related changes into themes ("Sync light:
    …", "Health page: …", "Editor: …") — never one bullet per commit.
  - One or two sentences per point, ~200 characters at most. Plain language, no
    file names, no issue numbers.
  - `.github/workflows/release.yml` ships ONLY the section whose heading matches
    the version being released (falling back to the topmost section), and strips
    this comment. Old sections are history, not release copy — they must never
    reappear under a new version.
  - Every staging PR adds or edits ONLY the section for the version it will ship
    in. If that section does not exist yet, create it at the top.
-->

## 0.1.62

- Linux: Baalda no longer re-indexes your vault non-stop while it sits idle, which was keeping a core busy and writing to disk constantly.

## 0.1.61

- Baalda now updates itself: it checks, downloads, installs and restarts at a quiet moment, and only shows the "Update required" screen if that fails. After a restart, What's New lists just the handful of things that changed in the version you got.
- Vault Settings has a new Health page: a verdict on your vault, a row per unsynced note with fixes you can press, fifteen checks over your files, and a year of activity as a grid. Warnings can be ignored.
- The sync light tells the truth: no "Syncing" flash when you open or switch notes, no light stuck on Syncing after launch, and no grey dots or folder counters while you are offline.
- Signing in is steadier: a banner warns you across the note when you are signed out, Windows and Linux stay signed in between launches, and edits made outside Baalda really do reach the server.
- Fixed a crash that emptied the whole window when you opened a locked or view-only note and then clicked another; the editor is now walled off so a failure there cannot take the app down. Baalda also opens sized to your screen, notes use the full width by default, Mermaid diagrams render in place, and the loading bars appear the moment you click a note.

## 0.1.59

- Baalda now connects to your vault almost as soon as it opens: connecting and checking the vault happen together, so the sync light settles in about a second instead of five.
- The light at the top now describes your vault's connection rather than whichever note you have open, so it stops flickering every time you click a file.
- Fixed notes that kept syncing again after they were already synced, and made reconnection near-instant when the connection drops.

## 0.1.58

- Private now means private for everyone. It used to leave owners, admins and authors reading everything, so pressing it in your own vault appeared to do nothing. Sharing again brings it all back.
- Vault Settings → Access has an Entire vault control that is really applied: it clears the individual settings underneath, tells you how many first, and keeps the people you shared with by name.
- Read-only vaults show the padlock on every folder and note, the server refuses every kind of change, and Baalda checks with the server before it removes anything from your disk.
- Fixed a bug that could make a note balloon by folding the same paragraph in twice while it synced in the background — one note reached 16 MB. The server now caps a note's total size.
- Content width is a slider from a narrow column to full width, settings rows have room to breathe, and opening a note no longer makes the window flash.

## 0.1.57

- A note's name now sits at the top of the note and is simply its file name. Click it to rename the file, and the tab, the sidebar and every list follow. New notes start blank.
- Properties at the top of a note are a panel you can fill in, with real types for text, lists, numbers, checkboxes, dates and tags. YAML Baalda cannot read is shown as source and never rewritten.
- The editor reveals markdown one marker at a time, so a finished note reads as a page. Callouts, highlights, comments, tags, wiki links and syntax-highlighted code blocks all render.
- Tables are editable in place: click a cell and type, Tab and Enter move between cells, and right-clicking inserts or deletes rows and columns. It never flips back to markdown pipes.
- Open notes moved into one row of tabs at the top, sections fold away and come back when you reopen a note, typing a tag suggests the ones you already use, and text sits in a readable column.

## 0.1.56

- Baalda opens straight into your vault: the sidebar appears right away while signing in, syncing and indexing carry on behind it. Launch is faster and the app installs smaller.
- You can now leave a vault you don't own from Vault Settings → Vaults, and moving a Pro subscription to another vault opens a dialog that shows each eligible vault and explains what changes.
