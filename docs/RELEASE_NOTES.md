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

## 0.1.69

- Improvements and bug fixes: syncing is more reliable when you reorganise or edit your vault from outside Baalda, and your notes stay exactly as you wrote them.
- Vault access settings now behave the way you expect for owners and admins, and Baalda explains clearly when something can't sync.
- Editing polish: copying from a note and selecting text in code blocks work smoothly again, and Version History keeps a copy before any large deletion.

## 0.1.68

- Clearer sync status: the indicator at the top now simply tells you when your vault is synced or syncing, without false alarms.
- A simpler Health page: see what's on this computer and on the Remote Vault at a glance, with anything that needs you in one tidy list.
- Smoother teamwork: shared files and notes stay in step between teammates more reliably.
- Improvements and bug fixes, plus security updates to the libraries Baalda uses.

## 0.1.67

- Sidebar sorting: sort by Name (Z–A) so your latest daily note sits on top, and give any folder its own sort from its right-click menu.
- Improvements and bug fixes: syncing and editing shared notes with your team is more reliable, so everyone's changes come through cleanly and your notes stay exactly as you wrote them.

## 0.1.66

- Sync no longer gets stuck retrying items you do not have access to: folders and files that were made private after they reached your computer stay safely on your computer and stop being re-sent in the background.
- Notes that never finished uploading are picked up more reliably, even in very large vaults.
- Sign-in and AI connections are more robust: one busy client can no longer slow down everyone's sign-in, and scripts using an old AI token are asked to wait instead of retrying endlessly.

## 0.1.65

- Files that stayed "syncing" forever now repair themselves: if a file was wrongly removed from the server while it was still on your computer, Baalda registers and uploads it again on its own.
- Health page: files on this computer that are not on the Remote Vault can now be selected and retried or deleted in bulk.
- On plans without file sync, Baalda now explains that files stay on this computer instead of retrying them over and over.

## 0.1.64

- Access is much faster on large vaults and teams: seeing a person's access, ticking several people and viewing the whole vault now load in one quick step instead of one folder at a time.
- When only some people are read-only on a folder, Access keeps showing the team's setting and names who is held back, instead of calling the folder restricted for everyone.
- Baalda Assistant shows one clear "Connect a provider" step when no AI key is added yet.

## 0.1.63

- More files open, embed and search: Office docs, CSV, audio, video, code and archives. Notes sync on every plan, embedded attachments stay free, and standalone file sync is Pro. On first launch Baalda scans your vault and uploads what your plan allows.
- Large vaults join and sync much faster in batches, edits from disk and from collaborators are both kept, and unchanged empty notes stop re-uploading after a restart. Self-hosters: update the server before the desktop.
- Access shows each person's permissions in the file tree, and selecting a folder includes its contents. People who join a vault from now on start with no access until you share or change the new-member default in Access.
- Vault Health leads with vault totals, a device-versus-server comparison and advanced diagnostics. AI (Beta) adds Baalda Assistant, which proposes repairs you approve with your own OpenRouter key: Pro on Cloud, free for self-hosters.
- Dark mode is a neutral charcoal, sign-in is centred, and Remember password lives in your OS keychain. Copying a note carries its images, a vault can be made local only while keeping its files, and icons, tabs and previews are tidier.

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
