# Changelog

All notable changes to obsidian-couchsync.

## Unreleased

### Fixed

- **A long pull is no longer cut off while it is still applying changes.**
  Receiving a large deletion from another device (thousands of files)
  could take one to two and a half minutes per batch of 100 changes. The
  catchup counted each batch from the moment it started, so a batch longer
  than 60 seconds ended with "Catchup timed out (no progress for 60s)" right
  after it finished, and the session started over. The health check could
  likewise take a long batch for a stalled pull and reconnect. Both now
  measure progress by each change the pull processes rather than by whole
  batches, so a slow batch keeps going and only a pull that stops
  processing changes is cut off.
- **Take Remote no longer replaces a version newer than the one shown.**
  When this device's version changed while a conflict dialog was open (a
  newer version was pulled, or an edit in the vault was synced), Take Remote
  still wrote the remote version the dialog showed, over the newer one. In a
  conflict found in the vault, it wrote the version the dialog showed over
  the vault's change. Take Remote now writes nothing in that case, as Keep
  Local does: the conflict is offered again with the current versions, or
  not at all when the current version already includes the remote one. This
  holds for Take all remote in the dialog for many conflicts too.
- **A conflict is not offered again after it was resolved.** When the same
  version of another device arrived again while the conflict dialog was
  open, Keep Local was followed by the same conflict once more. Choosing
  Keep Local again then left this device's clock ahead of a version it did
  not send, and the other device's next change showed up as a false
  conflict. A version that arrives while the dialog is open is now compared
  with the version kept: it is offered only when it is still a conflict, as
  a newer version from the other device is. A conflict kept for later
  between a deletion here and an edit on another device is likewise
  dropped once this device's version already includes that edit.
- **A pull no longer writes over a change in the vault that has not been
  synced.** When a file had been edited or deleted in the vault since this
  device last synced it, a newer version pulled from another device replaced
  the edit, or brought the deleted file back, without asking. This happened
  when the pull arrived before the edit was pushed, and also while a conflict
  about that edit was still waiting for an answer. The same happened to a
  file this device had never synced — one made here and not yet pushed, or
  one that came into the filters when they were widened — when another
  device had a file at the same path. The pull now leaves the file as it is
  and keeps the pulled version in the local database; the conflict dialog
  then shows both, and the chosen one is written. If another version is
  pulled while that dialog is open, Keep Local writes nothing and the
  dialog asks again with the newer version, instead of replacing it unseen.
  A never-synced file with
  the same content as the pulled version is not a conflict: the device only
  records it as synced. Files the filters keep out are not offered. Clone
  still replaces the files at the same path, as its confirmation says.
- **An edit or deletion right after choosing Keep Local is synced.** After
  Keep Local in a conflict with another device's version, the device still
  compared the file with the version from before the conflict. An edit made
  before the next sync check was not sent, and the check then showed a
  conflict with this device's own earlier version; a deletion was not sent
  either. Keep Local now records the kept version as the vault's synced
  state. When the vault does not hold the kept version yet, it is written
  to the vault, unless the file was changed there since the last sync: then
  the conflict dialog shows that change. Keep Local of a local deletion
  works the same way. If the local version changed while the dialog was
  open, Keep Local writes nothing and the dialog asks again with the
  current version; before, the version the dialog showed replaced it.
- **A pull no longer replaces what was just typed in an open note.**
  Obsidian saves typing about two seconds later; a version pulled in that
  time replaced the editor's text, and the typing was lost. A pulled
  version, or a pulled deletion, now leaves the note and its editor as they
  are while any open editor on it holds text not yet saved. Once the editor
  saves, the conflict dialog shows the saved text and the pulled version.
  If the typing was undone before a save, the pulled version is written at
  the next sync check. A file with Windows line breaks (CRLF) or a BOM is
  not taken for unsaved typing. An IME composition that commits text is
  handled the same way.
- **A version pulled into an open note with Windows line breaks (CRLF) is
  no longer doubled.** The pulled text was set into the open editor as well
  as written to the file, and Obsidian took that for typing: it merged the
  change into the new file a second time, so each changed line appeared
  twice, and saved the result with LF line breaks (a BOM was dropped too).
  The pulled version is now written to the file only, and Obsidian shows
  it in the open note the way it shows any change made outside the editor;
  the cursor stays where it was. If something is typed just as the version
  arrives, Obsidian merges the typing into it and saves; that save is now
  sent to the other devices at once, where before a save within 5 seconds
  of a pull was held back until the next sync check.
- **The confirmation of Delete local vault database says what happens to
  the vault's files.** It said that unpushed edits would be lost. Edits in
  the vault's files are kept: after the restart, a file whose content
  differs from the remote's version is offered as a conflict, and a file the
  remote does not have is sent to it. What is lost is a deletion or rename
  not yet sent: the deleted file, or the file under its old name, comes back
  from the remote.
- **A conflict on a binary file, such as an image or a PDF, is asked about
  like one on a note.** The device kept its own version without asking, so
  the vault's copy of an attachment could replace a newer one from another
  device. The conflict dialog now shows the file, says that the two versions
  cannot be compared, and gives each version's size; the user keeps one, or
  chooses later. In the dialog for many conflicts, clicking a binary file
  shows the same.
- **A new install no longer shows the notice that config sync filtering was
  upgraded.** The notice is for settings that had the old path list to
  convert; a first start, with no settings saved, was taken for one.
- **The mobile status indicator stays visible while the on-screen keyboard
  is open.** It kept its distance from the bottom of the screen, behind the
  keyboard. It now rises by the keyboard's height, never below the top of
  Obsidian's editing toolbar nor above the system's status bar, and goes back
  down when the keyboard closes.
- **Vault Init and Clone failures are always reported, and a failure before
  anything is changed leaves the setup as it was.** A Clone that failed while
  reading `vault:meta` or unlocking the vault (an unreachable server, a
  wrong passphrase) showed nothing — no notice, no log line. Init and Clone
  now show their notice from the first step and word every failure with its
  cause and fix. Both first check that the server answers and prepare
  everything that needs no change (the metadata, the key); only then do they
  stop live sync and mark the setup unfinished. Before, Init did that before
  checking the passphrase, so a missing passphrase disabled Live Sync
  although nothing had been touched. A second Init or Clone while one runs,
  and a run while the server rejects the credentials, are refused.
- **A device stops syncing with a vault database that another device's Init
  re-created.** A device still set up against the old database kept its live
  sync running and could pull the new database's documents into its own
  vault, or push its documents into the new one — encrypted with the old key,
  which no other device can read. Each Init now writes a new generation id
  into `vault:meta`, first, right after re-creating the database. Every
  device remembers the `vault:meta` its last Init or Clone was set up with
  and compares it when sync starts, and during live sync whenever the pull
  sees `vault:meta` change, a document that does not decrypt, or the
  database's sequence go backwards. On a difference, sync pauses before
  anything of the new database is applied, and Vault Sync (Step 3) says to
  run Clone. Existing setups need no action: a device set up before this
  release takes the server's `vault:meta` as its own the first time sync
  starts. Init and Config Create also wait until the re-created database
  answers, instead of failing when CouchDB was still removing the old one.
- **A same-size rewrite right after a sync is no longer missed.** To skip
  reading unchanged files, the startup scan and reconcile trust a file whose
  modification time and size match what was recorded when it last synced.
  On a filesystem that records modification times coarsely (2 s on FAT32,
  1 s on HFS+ and ext3, some network shares), a file rewritten with the same
  size just after it was recorded kept the same time, so the rewrite was
  neither pushed nor overwritten by a pulled version. A modification time
  less than 3 seconds older than the moment of recording is no longer
  trusted: such a file is read again on the next check, and recorded once
  its time is old enough.
- **Clone of an encrypted vault works when Step 1 has encryption off.** Step 1
  says the remote's encryption is detected on Clone, but the pull applied the
  decrypt layer only when Step 1's switch was on, so such a Clone failed
  ("cannot decompress still-encrypted body"). Clone now pulls with the
  cloned vault's encryption, like its compression, and saves both only when
  it succeeds.
- **A quarantined file recovers when its chunks reach the server again.**
  A file whose chunks were missing here and on the server stayed missing
  after another device pushed the chunks, because a reconcile that saw no
  change in the local database skipped it. The same held for a file whose
  restore was skipped while offline and for a file cloned without its
  chunks. Such files are now recorded with the pulled files that could not
  be written yet, and both live sync and every reconcile retry that record,
  without rescanning the vault.
- **Init encrypts the new vault with the Step 1 passphrase.** When the vault
  key was already unlocked in the session, Init kept the previous
  `vault:meta`'s salt and key, so a passphrase changed in Step 1 was ignored
  and sync paused with a passphrase mismatch on the next start. Init now
  builds `vault:meta` from Step 1 alone, with a fresh salt, as Config Create
  does. Other devices Clone the new vault as before.
- **Clone asks for the passphrase the way Config Join does.** When the Step 1
  passphrase is missing or does not unlock the vault, Clone asks for it,
  saying which of the two it is; a wrong answer keeps the prompt open with an
  error. Cancelling ends with "Clone cancelled — nothing was changed." The
  prompt that live sync shows when an encrypted vault has no stored
  passphrase also stays open on a wrong answer.
- **Vault Sync's Step 3 shows what last went wrong.** The status line now
  says why sync paused on encryption (e.g. "Last encryption check: Sync
  paused — another device turned vault encryption on. …") instead of "Choose
  how to initialize this vault.", and shows the last failed Init or Clone.
  The pause reason is saved with the setup state, so it is still shown
  after Obsidian restarts, until the encryption check passes or an Init or
  Clone succeeds. Rejected credentials are shown while requests are on hold
  and no longer after a Test clears the hold. The open settings tab redraws
  when Init or Clone starts and ends and when sync pauses. While Init or
  Clone runs, Init, Clone and Live Sync are disabled, and Step 2 Apply, the
  Step 1 switches and the CouchDB tab's Apply are refused.
- **Clone no longer needs a Check first.** After reopening the settings or
  restarting Obsidian, Clone said "Database is empty — use Init" and stayed
  disabled until Step 2's Check was pressed again, although the notice of a
  paused sync only says to run Clone. Clone now reads the database itself
  before it changes anything: it is enabled without a Check, and refuses an
  empty database with "The database is empty — use Init to push your
  vault." What Check, Clone and Init last found in each database is kept
  until Obsidian restarts, so checking another name does not drop the
  applied database's. That finding no longer disables Clone either: a device
  that found the database empty kept Clone disabled after another device's
  Init filled it, until Check was pressed again. For a database found empty,
  Clone's description now points to Init, and Clone reads the database
  again when pressed. Init reads its database back and Clone records what
  it read, so the document count shown after either is current.
- **Init and Clone count the files they send or write.** "Clone — N files
  written." counted every file document in the database, including files
  deleted on another device and files this device's filters keep out, so it
  could say 10 for a vault that received 2. It now counts only the files
  written to the vault, and Clone's "Writing N vault files..." only the
  files the filters let in. Init's "N files, M docs pushed" no longer counts
  files the filters keep out or that exceed the size limit, and its
  "Scanning (n/N)" counts only the files the filters let in. A reconcile's
  "N pushed" in the log counts only the files it recorded for sending.
- **Live sync no longer re-sends chunks the server already holds.** The first
  live sync after an Init or Clone wrote every chunk to the server again as
  a new revision of the same content, which advanced the database's
  sequence and woke every other device's pull. A chunk the server holds is
  now skipped.
- **More failures are worded with their cause and fix.** Step 2's Check (in
  Vault Sync and Config Sync), the CouchDB tab's Test and database delete,
  Verify's Repair, the chunk repair and its retry, and the Maintenance
  actions (legacy config cleanup, deleting the local vault, config and log
  databases, log export and clear) now report through the same notice as
  Init and Clone. A chunk repair or retry that fails no longer leaves its
  progress notice on screen, and deleting the local vault database is
  refused while Init or Clone runs. Deleting a server database without
  admin rights says so instead of pausing sync for rejected credentials.

- **Clone no longer aborts on a single transient network failure.** A Clone
  issues thousands of read requests (paginated `_all_docs` plus one GET per
  chunk attachment); one dropped request (`Failed to fetch`, a request
  timeout, a 5xx) failed the whole Clone, and a re-run started over from an
  empty local DB. Vault one-shot operations (Clone, repair, chunk
  consistency) now retry each idempotent read with Fibonacci backoff (up to
  6 retries, ≈20s) before giving up with the original error. Auth, 404 and
  codec errors still fail immediately. Writes are never retried (a re-send
  after an unknown outcome would conflict), and live sync is unchanged — its
  session already owns retry.
- **A stalled response body is classified as a timeout.** `CouchDB body
  stale (no data for …ms)` was reported as an unknown error; it is now a
  timeout, so the one-shot retry above covers it and live sync labels it
  accordingly.
- **A config database set after startup can now be pulled.** When the config
  database name was applied after Obsidian had started (or changed while it
  was running), Pull did nothing — no notice, no log line — and after a
  reload it failed with "refusing to build config client … Re-run Config
  Init". Following that advice wiped the config shared by every device. The
  config database's local store, sync cursors and encryption key now belong
  to the server and database name and are rebuilt on Apply (in either the
  CouchDB or the Config Sync tab), so the change takes effect without a
  reload and nothing of the previous database is used against the new one.
  Both Apply buttons are disabled while a config operation runs, and a change
  refused then saves nothing — so Create's confirmation, Create itself and
  the filter tree always use the server and database the settings name —
  switching servers back and forth no longer skips changes or writes the
  other server's config. The config key no longer depends on Vault Sync
  being connected.
- **Config sync failures are always reported, with the cause and the fix.**
  Every config Push, Pull, Join and Create failure now shows a notice and a
  log line naming the cause (not joined, missing or wrong passphrase, the
  database re-created on another device, …) with its fix. A server that
  cannot be reached, a timeout, rejected credentials or a server error is
  worded the same way ("The server could not be reached — check the network
  connection and the server URI in the CouchDB tab.") instead of the bare
  `Failed to fetch`; the raw error follows in parentheses. Key and
  passphrase problems never suggest Create. Rejected credentials now point
  to the CouchDB tab (and its Test button), not Vault Sync.
- **Config Sync's Step 3 shows what last went wrong.** The status line
  follows this device's relation to the config database: rejected
  credentials, an unfinished Create, then the last Push, Pull, Join, Create
  or check that failed (e.g. "Last Join: The passphrase this device has does
  not unlock …"), then "Not joined yet", then ready — so a failed Join says
  why even before this device has joined. A failed Push, Pull, Join or
  Create stays until one of them succeeds — the filter tree's read-only
  check succeeding does not clear it. A result about a database root this
  device no longer uses is not shown. The filter tree's
  listing of the server counts as a check; when it cannot list the server it
  says "Showing this device's config only — see Step 3." It does not contact
  the server while a config operation runs, before this device has joined,
  or while a Create is unfinished.
- **Notices of one-shot operations read once.** Init, Clone, Verify, the
  chunk report and every config operation now end with
  `CouchSync: <operation> failed — <cause and fix>` or
  `<operation> cancelled`, instead of
  `CouchSync: CouchSync: Config Pull — Config Pull failed: …`. Vault Init,
  Clone and Verify failures use the same wording as config sync, and a
  failed Verify is reported as a failure. A cancelled operation is logged as
  a warning, not an error.
- **Every notice and console line carries the `CouchSync:` prefix once.**
  Many notices and log lines read `CouchSync: CouchSync: …`, while notices
  shown directly from the settings tabs and some console lines had no prefix
  at all. The prefix is now added once where a line leaves the plugin (the
  notice and the console); the Log View keeps the bare text. The startup
  line reads `CouchSync: Starting v… — built …, commit …`. A completed
  operation's notice no longer repeats its name, e.g.
  `Verify — 3 discrepancy(ies)` instead of
  `Verify — Verify: 3 discrepancy(ies)`.
- **A config Pull with nothing new no longer rewrites every config file.**
  Each Pull wrote every config file it receives, even when the disk already
  matched, so all of them got a new modification time. Obsidian re-reads
  `app.json`, `appearance.json` and plugins' `data.json` on that, which could
  undo a setting just changed in the settings window. Pull now writes only
  the files whose content changes. When there are none, Pull & Reload does
  not reload Obsidian and its one notice says
  `No config files changed; no reload needed.`
- **A config Pull no longer undoes edits that were not pushed yet.** A Pull
  wrote the last synced version of every config file over the disk, so a
  setting changed on this device but not pushed went back to its old value,
  with no warning. See "Config Pull merges" below.
- **A config Push no longer overwrites what other devices changed.** Push
  sent whole files, so a desktop pushing `app.json` put back an old value of
  a key only the phone had changed, after a confirmation that did not say
  which keys. See "Config Push sends this device's changes" below.
- **Changing a codec setting no longer stops config sync.** Push and Pull
  now use the encryption and compression of the config database this device
  created or joined. Step 1 in Config Sync is what the next Create builds a
  database with; when it differs from the current database the tab says so,
  and sync carries on. Before, toggling Step 1 — or a Vault Clone that
  changed the vault codec Step 1 inherits — stopped config sync as "codec
  changed" and suggested Create.
- **An encrypted config database that becomes unencrypted is refused.** If
  a device joined a config database encrypted and its `config:meta` is now
  plaintext, sync stops and asks to verify the server; it is not treated as
  an ordinary re-creation. Join asks for confirmation before adopting an
  unencrypted database or an older cipher version for a database this device
  knew as encrypted.
- **Re-creating a plaintext config database is detected.** `config:meta` now
  carries a random generation id minted by every Create, so a device notices
  that another device re-created the database — encrypted or not — and asks
  it to Join again instead of mixing in stale data. Metas written by older
  builds have no generation id and are compared as before.
- **Clearing the config passphrase is no longer a codec change.** It used to
  be reported as a codec change that recommended Create; it is now reported
  as a missing passphrase.
- **A config Pull no longer stops a vault Init or Clone half-way.** A Pull
  that writes files reloads Obsidian, which stopped an Init or Clone running
  at the time: an Init left the server's vault database sent only in part,
  and every other device stopped on it. Pull & Reload, Pull & Overwrite and
  Share again are now refused while an Init or Clone runs, and Init and
  Clone while one of them runs; the notice says which one to wait for, and
  the buttons are disabled until it ends. After a Pull that reloads, Init,
  Clone, Config Create and Join stay refused until Obsidian has restarted. Push
  and Join still run beside an Init or Clone.

### Changed

- **Vault Init and Clone ask before they change anything.** Init deletes the
  vault database on the server and creates it again; Clone rebuilds this
  device's local vault database from the server and writes the server's
  files into the vault. Both used to start on the button press. Each now
  first checks what it can (the server answers, the passphrase, a database
  that is not empty), then shows what it is about to do: the database name,
  how many documents it holds and the encryption and compression of the
  vault. Init also says that every other device must Clone again, and that
  a device that notices the re-created database stops its live sync until
  then. The dialog opens with the focus on Cancel. Cancel changes nothing:
  live sync keeps running and the setup state stays as it was. Clone asks
  for a missing passphrase before this dialog.
- **Config Sync's buttons are disabled while a config operation runs.**
  Config operations never ran at the same time: a second one was refused
  with a notice. But while one ran, including while its confirmation
  (the Push list, Pull & Overwrite's or Share again's) was open, the other
  buttons stayed enabled, and the Filter could be changed under it. Now
  Create, Join, Push, Pull & Reload, Pull & Overwrite, Share again, the
  Filter and Apply are disabled until it ends, as Init and Clone are in
  Vault Sync. Create's confirmation is now part of the operation too, so
  no other config operation can start while it is open.
- **Config Pull merges.** Pull compares each config file the server changed
  with the version this device last took in and with the disk. In
  `app.json`, `appearance.json`, `hotkeys.json`, the other `.obsidian/*.json`
  files and plugins' `data.json`, every key is compared on its own: a key
  only the server changed takes the server's value, a key only this device
  changed keeps this device's value. `community-plugins.json` is merged as a
  set of plugin ids. Other files (snippets, themes, plugin code) and files
  that are not valid JSON are compared as a whole. Where both sides changed
  the same key (or file) differently, this device's value stays; the notice
  counts such files and the log names each file and key (never the value),
  and the next Push sends this device's value. Without a version taken in
  before (after Join), the server's values win and keys only this device
  has stay. Before writing, Pull copies the files it is about to overwrite
  to `backups/config/<date_time>/` in the plugin's folder and keeps the
  newest 10 of these backups; they are never pushed. Written files keep
  their indentation and key order. Pull & Reload shows one notice and
  reloads Obsidian only when it wrote a file. The notice's "Received" counts
  the changes this device did not have yet; its own pushed files are not
  counted.
- **Config Push sends this device's changes.** Push sends the config files
  that changed on this device since it last pushed or pulled them. A file
  whose server copy changed since this device last pulled, or whose server
  copy this device has not taken in, is not sent: the notice counts such
  files by that reason and asks to run Pull & Reload, then Push again (the
  log names each file with the same reason). The confirmation that offered to overwrite the server
  copy is gone. A file this device's Pull would not write is not sent
  either: a plugin's `data.json` on a device where the plugin is not
  installed, or a desktop-only plugin's files on mobile, stay this device's
  own.
- **Config Push lists its changes and lets you keep some on this device.**
  Before sending, Push lists every change: each key of a JSON settings
  file (each plugin enabled or disabled in `community-plugins.json`), or a
  whole file, with the shared value next to this device's. A plugin's
  `data.json` may hold API keys or tokens, so its values appear only after
  "Show values". Everything is checked; one button sends the checked
  items, and Cancel sends nothing. An unchecked key stays this device's
  own: later Pushes do not send it and Pulls do not change it, and neither
  reports it as a conflict. An unchecked file stops syncing on this device,
  as if turned off in the Filter. These choices are device settings and
  are not synced. A key is shared again in one of two ways. Checking it in
  a later Push list sends this device's value. "Share again" under "Kept on
  this device" in the Config Sync tab takes the shared value instead: it
  runs Pull & Reload, shows the shared value once the server is taken in,
  and on confirmation writes that value
  for the key (removes the key, or disables the plugin, where the shared
  config has none) while every other key and file is pulled as usual. When
  the disk already has the shared value, it only stops keeping the key and
  does not reload. A Push whose only changes are keys kept on this device
  shows no list.
- **Pull & Overwrite makes this device's config the shared config.** A new
  button in the Config Sync tab, next to Pull & Reload. It does not merge:
  every selected file the server has is written as the server has it,
  selected files the server does not have are deleted, and keys kept on
  this device take the shared value and are shared again. Files the Filter
  leaves out, a plugin's files where the plugin is not installed, a
  desktop-only plugin's files on mobile, the workspace layout and the
  CouchSync plugin's own folder are not touched; per-file choices in the
  Filter stay. A confirmation lists the files it deletes and writes; Cancel
  changes nothing. The files are backed up to `backups/config/` first, as
  with Pull & Reload, and Obsidian reloads. When the server has no config
  for this device's selection, nothing is deleted. Pull & Reload and Pull &
  Overwrite stop a community plugin before writing or deleting its files,
  so it cannot save its settings over them before the reload.
- **Coming back to a config database merges as after a Join.** When another
  config database's Pull wrote this vault's config since this database was
  last used, the next Push or Pull here no longer treats those values as
  this device's changes, which Push would have sent. Pull takes this
  database's values (keys only this device has stay, and the files are
  backed up first); Push holds the files until that Pull. Switching to
  another database and back without a Pull there changes nothing.
- **Config Init is renamed Create, and Join is new.** Config Sync's Step 3
  now has Create (first device: reset the config database with a new root,
  then Push) and Join (every other device: sync with the existing
  database's encryption and compression and unlock it with its passphrase;
  the server is not changed, then Pull). Push and Pull on a device that has
  not joined stop and ask it to Join. Join does not change the Step 1
  settings.
  Create first checks that the server answers; a server that cannot be
  read fails Create before it asks. Its confirmation shows how many
  documents the server holds and whether `config:meta` exists, the
  encryption, compression and cipher version it will build (highlighted
  when that is weaker than the database's current one, e.g. encrypted →
  unencrypted), and that every other device must Join again.
- **The config passphrase belongs to the database you Create or Join.**
  Create and Join keep the passphrase of an encrypted config database with
  that database (per server and database name, in settings). Push and Pull
  unlock it with that value alone, so neither Step 1, turning Vault Sync
  encryption off nor a new vault passphrase stops config sync, and two config
  databases with different passphrases each keep their own. A plaintext
  database keeps none.
- **Step 1's passphrase is only what the next Create encrypts with.** Left
  empty, it inherits the Vault Sync passphrase. It is shown only while Step 1
  encryption is on, and Create and Join do not write to it. An encrypting
  Create with no passphrase at all stops before anything is deleted and
  points to Step 1.
- **Join asks for the passphrase only when it has none that works.** It
  tries the passphrase it kept for the database, then Step 1's, then the
  Vault Sync passphrase, and asks only when none unlocks the database. The
  prompt says whether no passphrase was set or none matched, checks the
  answer, and stays open on a wrong one. Cancelling it ends the Join with
  "Join cancelled — nothing was changed."

### Migration

- **Config sync state moves to the new merge by itself.** The first config
  Push or Pull after updating compares each file this device knows with the
  server copy once. Edits that were never pushed are kept as this device's
  changes: where the server also changed the same file since, the keys that
  differ keep this device's value and are reported like a conflict. If a
  plugin was installed after the last Pull, its default settings look like
  this device's changes; the first Push lists them (keys the shared version
  lacks are marked "new key"), so they can be left out.
- **Existing devices Join once.** Whether a device has joined a config
  database, and with which codec, is now recorded inside that database's
  local store, which is also renamed to include the server. The previous
  record cannot be carried over, so after updating every device's first
  config Push or Pull asks it to Join. Join does not change the server, any
  config file or the Step 1 settings, and the next Pull downloads the config
  again. The cipher-version floor and an interrupted Create are kept in
  settings, per server and database. Join tries the Step 1 and Vault Sync
  passphrases first, so a device whose config passphrase is already in
  Step 1 is not asked for it. The previous local config store of the
  config database applied now (`couchsync-<vault>-config-<db>`) is deleted on
  start; stores of config database names used earlier stay on disk.

## 0.29.0

Three structural changes: a first-principles redesign of config sync that
closes a plaintext-config code-execution surface, a content-truthful
convergence rule that ends a class of silent non-propagation, and a
two-timescale reconnect probe that fixes slow mobile resume recovery.

### Security

- **Config sync now filters by meaning-unit with a send/receive policy that
  structurally excludes executable code on receive.** The old
  `configSyncPaths` string list governed only the receive side; a
  compromised or malicious remote could push plugin/JS code that a
  receiving device wrote into `.obsidian` and Obsidian then executed. The
  new policy classifies each config path into a meaning-unit and projects
  it through two gates — `receiveDecision = sendDecision && gates`, with the
  receive projection a strict subset of send. Install-state (plugin
  `main.js`/`manifest.json`/`styles.css`, any `.js`/`.mjs`/`.cjs`) defaults
  off and is hard-locked off in both directions by `blockPluginCode`, which
  migration forces on. A desktop-only platform gate (judged against the
  local on-disk manifest, never a remote-supplied one) keeps desktop-only
  units off mobile. Path classification is case-strict on the safe side, so
  case/prefix/depth tricks cannot promote code into a default-on unit.

### Reliability

- **Content-truthful convergence — no more silent equal-vclock overwrites.**
  A converge/skip decision now requires the vclock, the chunk list, AND the
  deleted flag to all match; a vclock tie with differing content surfaces as
  a true-divergent conflict instead of being dropped. Applied symmetrically
  across vault and config, pull and push, behind a single shared
  chunk-equality comparator. The seq-regression self-heal threads a
  `recreateAuthority` signal into the classifier so a remote-recreate
  re-pull (e.g. an encryption Init that rotates the HMAC key and changes
  chunk ids for identical content) resolves an exact vclock tie to
  take-remote instead of flooding false concurrent conflicts.
- **Config setup is split into Init and Push.** Init wipes structure and
  pins `config:meta` only (no content seed); Push is the filter-governed
  seed. A checkpoint `load()` fix (meta-absent now resets the cursor to 0,
  symmetric with the vault side) stops an Init-then-push from skipping the
  seed. The settings tab reflects the new flow (Setup: Init / Sync: Filter →
  Push → Pull & Reload) and the filter tree shows the local ∪ remote unit
  set with provenance.

- **App-resume recovery no longer stalls on a suspend-killed socket
  (measured ~16s → ~3.5s worst case on iPad).** `verifyReachable` issued one
  `info()` through the session's keep-alive socket, which iOS tears down
  during background suspend; that fetch hung the full 15s reachability
  budget while the network was healthy (a fresh probe ~1s later returned in
  tens of ms). The probe now separates the total budget from a 3s
  per-attempt timeout: a stuck probe is abandoned and a fresh fetch
  re-issued within budget, with 1s spacing to avoid a busy loop. Healthy
  probes (observed ≤2s) are unaffected. Server-answered failures bail
  immediately and 401s are now classified correctly.

### Migration

- Existing `configSyncPaths` settings migrate to the new policy on the safe
  side (`blockPluginCode` forced on), with a one-time notice. A legacy empty
  `configSyncPaths` (which meant "receive nothing") maps to the default
  policy with portable settings on, so a previously-dormant receiver begins
  syncing portable (non-executable, gated) config on the next manual Pull.
  No schema change to vault documents; no re-Init required.

## 0.28.4

An efficiency release built from a measured investigation on three real
devices. The headline: the reconciler's fast-path had been structurally
dead — every reconcile (every mobile foreground resume) re-read and
re-hashed the entire vault, measured at 4.1 s for a 287-file vault on
Android. After this release the same reconcile takes milliseconds, the
idle write churn is gone, and push traffic shrinks ~25% on encrypted
vaults. No schema change, no re-Init required.

### Performance

- **Reconcile fast-path actually fires now (measured 4 059 ms → 13–18 ms on
  Android, back-to-back).** The "did the DB change?" check compared against
  `_update_seq`, a counter bumped by EVERY write — including the push loop's
  own no-op checkpoint commit every 2 s poll and each catchup's identical
  cursor re-write. The check now uses a docs-only change signature
  (`{maxDocSeq, docCount}`) that bookkeeping writes cannot move, and
  checkpoint commits that provably change nothing write nothing (killing
  ~30 no-op IndexedDB transactions per minute of idle mobile flash wear).
- **Slow-path scans no longer re-hash unchanged files (measured 4 159 ms →
  62 ms full-vault on Android).** The integration baseline now records the
  disk mtime observed at integration; an exact `(mtime, size)` stat match
  reuses the stored chunk fingerprint instead of re-reading and re-hashing
  the file. The trust model is the same one the vault-wide mtime threshold
  has always used; destructive-judgment paths still hash for real.
- **Push request bodies are gzip-compressed (~25% less upload on encrypted
  vaults).** Chunk uploads ride inside JSON as base64 (+33% on the wire);
  transport-level gzip recovers nearly all of it (measured ×1.33 → ×1.005),
  mirroring the pull direction where the server compresses responses.
  Requires `content-encoding` in the CouchDB `cors.headers` allow-list —
  without it the client logs once and falls back to uncompressed
  automatically (see below).

### Fixed

- **A server that rejects compressed requests cannot stall push.** Found
  live during release verification: `Content-Encoding` is not a
  CORS-safelisted header, so it triggers a preflight that a default CouchDB
  CORS config rejects — fetch fails before any HTTP exchange. A compressed
  request failing at the network layer (or with HTTP 415) is now retried
  uncompressed once and compression latches off for the session; if the
  uncompressed probe also fails the latch is restored, so a genuine outage
  can't permanently disable compression.

A connection-recovery overhaul plus the trust-boundary and retry-cadence
fixes surfaced by a production-log review across four real devices. The
headline: on mobile, sync could silently stay dead after the app launched
during a brief network blip, and every wake from a long sleep popped a
spurious "Server unreachable" notice even though sync recovered a second
later. Both are gone. All fixes ship as one release; no schema change, no
re-Init required.

### Fixed

- **Sync no longer stays permanently dead when the app loads during a network
  blip (mobile cold-start).** The encryption-agreement check ran as an
  unsupervised gate before sync started; if its first network call failed
  (common right after a tablet/phone wakes, before the network stack is
  ready) it gave up with no retry, leaving sync silently off until a manual
  reload. Two mobile devices hit this in production. The check is now a single
  supervised step inside the sync session, so a transient failure retries and
  auto-recovers the moment the network returns.
- **No more spurious "Server unreachable" notifications on resume.** A request
  frozen by a background suspend aborts on wake; that abort was misread as the
  server being down, firing a Notice and bouncing a healthy session through an
  error state. Suspend-frozen aborts are now told apart from genuine timeouts
  (by elapsed wall-clock) and handled silently, and only user-actionable
  errors raise a Notice now — transient blips show in the status bar only.
- **A malicious or compromised server can no longer write outside the vault.**
  Paths from remote documents were applied without validation; on a
  plaintext vault a crafted id (`../…`, absolute, drive-letter, backslash)
  could escape the vault sandbox on write *or* delete. All remote-applied
  paths are now validated at the write boundary, independent of encryption.
- **Pull now honours the same max-file-size ceiling as push.** An oversized
  document from another device (or a hostile server) is skipped instead of
  being assembled wholesale in memory.
- **Push no longer busy-spins on `404` / transient encryption errors.** Those
  paths retried with no delay until the 10 s escalation tore the session down;
  they now back off like the pull loop, saving mobile battery and bandwidth.
- **A stalled reconnect can no longer hang forever.** A health-check watchdog
  re-kicks recovery if it ever finds the engine stuck with nothing in flight,
  while leaving genuinely terminal states (auth, migration, encryption pause)
  alone.

### Added

- **Device specs in the log-export frontmatter.** Exports now record CPU core
  count, JS-heap usage/limit, RAM, CPU model, and architecture (best-effort,
  platform-dependent) to help diagnose memory-pressure and OOM-class issues.
  The `os` field also reports a real value on mobile (e.g. `android 17`) — it
  was previously always `unknown` off the desktop.

## 0.28.2

Five structural fixes from a log-driven bug hunt across two real-device
incident logs. Two of them had been silently losing data propagation in
production: a deleted-then-recreated note that could never sync again, and
deletions that never reached other devices and resurrected there.

### Fixed

- **Recreating a deleted note no longer wedges it permanently (Invariant 7:
  deletion is an integration event).** Deleting a file erased its integration
  baseline (`lastSynced`), destroying the causal record "this device
  integrated that deletion". Recreating the same path then made the push
  guard classify the old tombstone as an unintegrated remote edit — push
  skipped forever, pull already converged, reconcile re-entered the same
  guard: no exit (the 2026-06-03 `2026-W24.md` incident, 4 days stuck).
  Deletion now *establishes* a deleted baseline instead of erasing it, the
  classifier gained a deleted axis (a tombstone's retained chunks no longer
  masquerade as live content), and recreate-after-delete pushes cleanly with
  no modal. Devices already wedged self-heal through a new
  recreate-vs-deletion conflict prompt on their next reconcile. Three sibling
  bugs fell to the same axis: recreating with *identical* content no longer
  short-circuits into a dead tombstone, a tombstone can no longer
  silent-merge-resurrect against a live doc sharing its retained chunks, and
  a pull-applied deletion no longer leaves a stale alive baseline that turned
  a later legitimate recreate into a false conflict.
- **Deletions can no longer be permanently skipped by the push cursor (lost-
  update race).** `changes()` read its cursor bound (`_update_seq`) in a
  separate transaction from the row query; a write committing in between was
  covered by the cursor but never enumerated. Edits self-heal on the next
  keystroke — a skipped *tombstone* never gets another vault event, so the
  deletion silently stopped propagating and the file resurrected on every
  other device (the 2026-06-03 `search1.jpeg` incident: 2 of 15 batch-deleted
  images lost their tombstone push). The cursor now derives from the rows
  actually enumerated, making the race structurally impossible. A one-time
  **push-backfill sweep** at session start (also wired into "Verify
  consistency and repair") re-enqueues docs already stranded behind the
  cursor — it found and repaired 4 stranded tombstones on the dev vault
  alone.
- **Case-only and NFC/NFD renames no longer revert forever.** `Note.md →
  note.md` desugared into create+delete: the create minted a fresh vclock
  (discarding the file's causal history) and clobbered the shared
  case-folded baseline, the delete's divergent guard then misfired (no
  tombstone), and reconcile picked the *old* doc as canonical — physically
  reverting the rename on every retry. Rename is now a single atomic
  write transaction: the new doc inherits the old causality and strictly
  dominates the old path's tombstone (strictness is load-bearing — equal
  clocks would converge to fleet-wide deletion on case-insensitive
  receivers), and the shared-PathKey baseline keeps exactly the alive entry.
- **Editing near emoji no longer silently loses history.** diff-match-patch
  splits diffs at UTF-16 code-unit boundaries, so edits around emoji that
  share a surrogate half (🍅→🍆) produced lone-surrogate segments whose
  serialization throws `URIError: URI malformed` — the capture was dropped,
  and the stale snapshot reproduced the same failure on every subsequent
  edit of that file (13 consecutive losses in one incident log). Diff
  boundaries are now snapped to code-point boundaries before serialization
  (patch format unchanged, old history remains readable), and history
  bookkeeping advances even when a capture fails, so one lost diff can no
  longer cascade. Conflict-history recording is non-throwing for the same
  reason — a failed diff no longer ghost-re-presents an already-resolved
  conflict.
- **Pulled tombstones no longer fetch their dead content's chunks.** A
  tombstone retains the chunks of the content it deleted; applying a
  deletion never reads them, but the pull path fetched them anyway — wasted
  bandwidth that the next chunk GC dropped again.

## 0.28.1

Faster mobile-resume recovery. On returning to the foreground, a mobile
device probes the server to revive the sync socket; if the OS hasn't
restored the network stack yet, that probe fails fast and the engine
correctly enters `error` — but the *first* retry was landing at 5s instead
of the intended fast head, delaying recovery (and the flush of local edits)
on every resume.

### Fixed

- **First reconnect retry now fires at 1s, not 5s.** `enterError` recorded
  the failure *before* reading the backoff delay, so the first retry consumed
  `delays[1]` and skipped the fast head entirely. Scheduling now reads the
  current step's delay before advancing, so the first retry lands at the
  table head as intended. The `error` state is still surfaced (accurate
  status reporting); only the recovery latency changed (~5184ms → ~1032ms,
  measured on an Android emulator with the network cut at resume).

### Changed

- **Retry backoff is now a Fibonacci cadence: 1s, 1s, 2s, 3s, 5s, 8s, 13s,
  21s** (was 2s, 5s, 10s, 20s, 30s). Tuned for mobile data safety — a gentle
  early ramp keeps transient-blip recovery near-instant while still backing
  off for a genuinely unreachable server.

## 0.28.0

A first-principles redesign of the conflict subsystem, prompted by a
multi-device data-loss incident: a device that had been offline, then
re-cloned, re-pushed its just-cloned files and stamped its own vector-clock
component onto remote-authored content. The source device's next edits then
classified as *concurrent* instead of *remote-edit*, surfacing ~190 conflict
modals; closing them (×) defaulted to **keep-local**, which pushed the stale
local copies back over the remote. The fix returns to three structural
principles rather than spot-patching the symptoms.

### Fixed

- **A re-clone no longer stamps this device's vclock onto pulled content
  (root cause).** `dbToFile`'s "content already on disk" fast-path returned
  success without recording an integration baseline (`lastSynced`), so a
  re-clone left those paths with no baseline and the next reconcile re-pushed
  them under this device's id — turning the original author's later edits into
  false *concurrent* conflicts. The fast-path now establishes `lastSynced`
  from the FileDoc's vclock (Invariant 3: chunks-equal ⇒ the FileDoc is the
  vclock authority), so a cloned file is never re-pushed and the author's edits
  fast-forward as a clean take-remote. Single sink `establishBaseline()` now
  backs the normal write path, the fast-path, and `adoptDocVclock`.
- **Closing a conflict no longer overwrites the remote with a stale local
  copy.** A conflict modal closed with × / Esc / click-outside now **defers**
  (keeps the conflict for later, changes nothing) instead of defaulting to
  keep-local-and-push. `ConflictChoice` gains an explicit `defer`, and the
  modal adds a "Later" button.
- **Deferred conflicts are durable.** Edit-vs-edit concurrency is now persisted
  in the same transaction as the pull cursor advance (Invariant B), alongside
  the existing delete-vs-edit records, and re-presented next session by
  re-fetching and re-validating the remote revision. Without this, deferring an
  edit-vs-edit conflict would silently lose the remote edit once the cursor
  moved past it.

### Changed

- **Many conflicts are presented as one batch modal instead of a stack.**
  Conflicts are now aggregated and drained serially — never more than one modal
  open at once (the stacked semi-opaque overlays previously turned the screen
  black at ~10+ conflicts). A burst of ≥10 conflicts shows a single batch modal
  offering *keep all local* / *take all remote* (gated behind a confirm) /
  *decide individually* / *defer all*; fewer than 10 are shown one at a time.

No wire-format or schema change. The only persisted-shape addition is a new
`edit-vs-edit` pending-conflict kind (local `_sync/` meta, not replicated;
older builds defensively ignore unknown kinds). Verified on Dev / Dev2 /
Android: normal sync unaffected, the batch modal renders a single overlay,
closing a real concurrent conflict leaves the remote intact and re-presents it
next session, and a re-clone followed by a source edit fast-forwards with no
conflict.

## 0.27.3

### Fixed

- **Folder-structure sync: three structural gaps closed (H-1/H-2/M-1/M-2).** A
  multi-agent review surfaced four findings rooted in three gaps. Case D now
  decides a vault-missing/DB-alive path on the `lastSynced` integration
  baseline first (manifest demoted to a fallback), fixing a silent un-delete
  that re-propagated (H-1, data-loss). Case F's collision tiebreak now derives
  the canonical from device-invariant data instead of vclock key order (H-2).
  `IVaultIO` gained `getFolders` + `abstractType` so the folder namespace is
  handled (file/folder path collisions no longer throw on create; M-1/M-2).

## 0.27.2

A post-release review of v0.27.0/v0.27.1 (a multi-agent pass with adversarial
verification) found no high-severity defects but two medium gaps plus a cluster
of smaller ones. As in v0.26/v0.27 these are not independent bugs but the same
recurring shape — *a config-side path that diverged from its vault-side mirror,
or an invariant enforced on one side of a boundary but not the other* — so they
are closed here as a return to three structural principles rather than spot
fixes. No wire-format or schema change and no re-initialisation of existing
vaults; the only persisted-shape addition is a `configCodecApplied` fingerprint
(absent on existing installs, which therefore keep their current behaviour).

### Fixed

- **Changing a config codec setting no longer silently desyncs live config
  sync.** Toggling config encryption / passphrase / compression only takes
  effect on the next Config Init & Push, but until then live push/pull kept
  running under the new setting against a database built with the old one — worst
  case, turning encryption *off* cleared the provider while the server still held
  encrypted documents, so pulls failed until a full re-Init. A successful Config
  Init now records the codec it applied, and live push/pull/write refuse to run
  when the live codec has drifted from it, with a clear "re-run Config Init &
  Push" message — symmetric with the existing half-built-DB (`configSettingUp`)
  guard, and with vault sync, where a codec change has always demanded a
  re-init rather than a live switch.
- **An interrupted Config Init no longer leaves the shared remote without its
  crypto root.** Init destroyed and recreated the remote config database before
  building the `config:meta` crypto root, so a failure in between left peers
  looking at an existing-but-meta-less database, and a key-derivation failure
  could wipe the remote for nothing. The crypto root is now derived first (a pure
  computation — a failure there touches neither database) and `config:meta` is
  pushed as the very first write after the database is recreated, shrinking the
  window in which the remote exists without an authoritative descriptor to a
  single request. A mid-flight failure still leaves the initiating device
  fail-closed (`configSettingUp`), unchanged.
- **The config pull's "remote recreated elsewhere" self-heal is now durable and
  bounded.** The cursor reset was applied in memory only, so a crash before the
  next batch committed left the stale cursor on disk and re-triggered a full
  re-pull every session; it is now persisted in its own transaction. A second
  seq regression within one run (an unstable or hostile server reporting a
  last_seq below the cursor) is now treated as terminal instead of looping up to
  the batch cap.
- **A structurally malformed config chunk no longer aborts the whole document's
  chunk fetch.** Config pull classified only a hash mismatch as corrupt, while
  vault pull also treats a malformed envelope as corrupt (skip + warn, route to
  repair); the two boundaries now share one `fetchMissingChunks` implementation,
  so a corrupt chunk is handled identically and a malformed config chunk is
  skipped rather than rethrown.

### Security

- **Config Init's encrypted document push is fail-closed.** It previously fell
  back to the raw (plaintext) client when the encrypting-client hook was absent;
  production always wired it, but the fail-open default was asymmetric with the
  fail-closed `wrapConfigClient` / `wrapVaultClient`. An encrypted Init now
  requires the encrypting client and refuses to push plaintext bodies into an
  encrypted config database.

### Internal

- The config codec resolution (the per-field `?? ` / `||` inherit rules) is now
  defined once in `resolveConfigCodec`, removing the scattered inline copies that
  let a mis-paired operator silently break inheritance. The dead
  `reinitForEncryptionChange` (zero callers, and a latent hazard that ran outside
  the operation runner) is removed; the sole config rebuild path is `init()`.

## 0.27.1

Hotfix for v0.27.0: the **first encrypted Config Init was impossible**. Config
Init builds its database (destroy → recreate → reachability probe) *before* it
derives the config crypto provider, but it routed those DB-level ops through the
wrapped client, whose fail-closed guard throws when encryption is enabled and no
provider is unlocked yet — so Init failed with "refusing to build config client
(provisioning incomplete)" before it could create the provider. Config Init and
reinit now run their DB-level ops (destroy / ensureDb / reachability probe) on a
raw, un-wrapped client; the encrypted document push still uses the wrapped
client, by which point the provider exists. Verified on Dev with the provider
cleared (first-Init simulation).

## 0.27.0

Two themes. First, a post-release review of v0.26.1 (a multi-agent pass with
adversarial verification) surfaced ten confirmed issues; they are not
independent bugs but the same recurring shape — *a boundary where an invariant
was enforced on one side but not the other* — closed here as a return to a few
structural principles rather than spot fixes. Second, **config sync gains its
own independent codec settings** (see Added). No wire-format or schema change
and no re-initialisation of existing vaults; the only persisted-shape additions
are a `configSettingUp` flag and the (already-present, now UI-exposed) config
codec overrides — all defaulting to inherit/false, so an untouched install is
unchanged.

### Added

- **Config sync codec is configurable independently of Vault Sync.** The Config
  Sync tab's Step 1 now exposes an E2E-encryption toggle, an optional separate
  passphrase, and a gzip toggle for the config database. Each value falls back
  to the corresponding Vault Sync setting when left unset (no migration — an
  untouched install keeps inheriting), so you can e.g. encrypt the vault while
  keeping config plaintext on a trusted server, or encrypt config under a
  different passphrase. Changes take effect on the next Config Init & Push,
  which now also ratchets the config cipherVersion floor immediately so a
  downgrade is refused without waiting for the next reload.
  Bringing this to real use surfaced three latent defects that had silently
  made config encryption non-functional — all fixed and verified on a live
  two-device fleet:
  - **config Init encrypted documents under a different key than `config:meta`**:
    the push reused the client captured *before* the freshly-derived crypto
    provider was installed, so every config doc was undecryptable on all
    devices. The push now uses a client wrapped with the post-derivation provider.
  - **an empty config passphrase field did not inherit the vault passphrase**
    (`??` treated `""` as an explicit empty value); it now falls through (`||`).
  - **config pull had no seq-regression guard**: after a config Init recreated
    the remote DB, other devices' pull cursors sat above the reset seq and
    silently pulled nothing. Config pull now detects this (like vault pull) and
    self-heals by resetting the cursor and re-pulling from scratch.

### Security

- **An encryption downgrade is refused on every pull path, synchronously.** A
  cipherVersion floor violation (an unsealed body in a v3 vault) is a
  non-retriable policy violation: it now maps to a terminal error in the single
  `classifyError` classifier, so the longpoll path halts immediately instead of
  treating it as a transient error with a 10-second grace window. The catchup
  path already halted — the two paths are now symmetric. A transient decrypt
  failure (key not yet distributed) still backs off and retries. (#enc-1)

### Fixed

- **Remote hard-deletions are now applied durably.** A CouchDB tombstone was
  applied to the vault outside the commit transaction, so a crash between the
  vault delete and the local-tombstone write could lose the file permanently
  with no recovery on restart. Hard-deletions now flow through the same
  `accepted → pending-deletion → drain` path as soft-deletions: committed
  atomically with the cursor advance and retried on apply failure. (#del-1, #del-2)
- **A pull-delete with an unreadable unpushed-edit probe now fails safe-side.**
  The probe's I/O error was swallowed into "no unpushed edits" (= apply the
  deletion); it now surfaces a conflict instead, honouring the "when unsure,
  treat it as a conflict" rule. The error-prone query bus this relied on was
  removed in favour of a direct, safe-wrapped function call. (#err-10)
- **The reconciler no longer persists its manifest/cursor during teardown.** The
  trailing persist was the one DB write not gated on the disposal barrier, so it
  could race `localDb.close()` on unload (DatabaseClosedError). (#err-7)
- **Config Init is now atomic.** It records a `configSettingUp` flag before
  wiping the local config DB and clears it only on success, mirroring vault
  setup (Invariant C); config push/pull/write refuse to run against a config DB
  left half-built by an interrupted init. (#err-9)
- **A persistent push conflict now surfaces the real remote content.** When a
  race-stale entry escalated to a conflict, the modal was handed the local
  document as the "remote" side, showing identical content on both panes; it now
  uses the remote document fetched in the same cycle, or defers to the next
  cycle when fresh remote state isn't available. (#sync-001)
- **Redundant pushes are avoided** for a document whose vector clock advanced
  but whose chunks are byte-identical to the remote (e.g. after a pull-side
  clock merge). (#sync-005)
- A config concurrent-pull notice is fire-and-forget but now logs a rejection
  instead of leaving an unhandled promise. (#err-1)

### Changed

- **Exported diagnostic logs sync again.** v0.26.1 hard-coded a
  `couchsync_log_*.md` exclusion in the sync filter; that special-casing
  contradicted the design rule that sync membership is decided only by the
  user's `syncFilter` / `syncIgnore` (and dotfile) rules, not by built-in
  filename patterns. Choosing an unencrypted vault means trusting the server, so
  the plaintext-exposure concern that motivated the exclusion does not apply, and
  it has been removed.

## 0.26.1

A follow-up integrated review of the v0.26.0 release surfaced 19 confirmed
issues; this patch closes all of them. There is **no wire-format or schema
change and no re-initialisation** — every fix is either consuming state the
vault already records or extending an existing invariant to the boundary where
it was missing. The whole set was verified on a real three-device fleet
(desktop ×2 + Android) against a live cipherVersion-3 vault, plus the Docker
e2e harness (1179 unit + 14 e2e tests).

The theme continues v0.26.0's: *trust decisions belong to the client's known
policy, never to data the untrusted server supplies*, and *every invariant is
enforced symmetrically on both sides of a boundary*.

### Security

- **A re-initialised cipherVersion-3 vault now refuses an encryption
  downgrade.** v0.26.0 sealed file/config bodies into an authenticated `encBody`,
  but the decoder still dispatched on whichever fields the server sent: if a
  curious server dropped `encBody` and served the older path-only (or a plaintext)
  body, the client accepted it unauthenticated — re-opening exactly the vclock
  rollback / chunk-substitution / deleted-resurrection attacks `encBody` was meant
  to close. The decoder now enforces a per-vault cipherVersion **policy floor**:
  in a v3 vault every file/config document must be a sealed `encBody`, and the
  legacy/plaintext paths are rejected. The floor is anchored in client-local state
  on first unlock (trust-on-first-use) and the server cannot lower it by rewriting
  the (server-writable) `vault:meta` — a remote meta below the recorded floor is
  refused before any data flows. Vaults still on cipherVersion 2 keep reading the
  legacy format until they re-init.
- **The config-DB client is now fail-closed**, symmetric with the vault client:
  it refuses to build a plaintext stack when config encryption is enabled but the
  crypto provider has not unlocked, instead of silently writing unencrypted config
  bodies into an encrypted database.
- **The plugin's own `data.json` is excluded from config replication by its real
  install path** (from the manifest) rather than a hardcoded folder name, so a
  renamed install (e.g. a BRAT side-load) no longer risks pushing the plaintext
  CouchDB password and passphrase to the config server.
- **Exported diagnostic logs are no longer synced.** `couchsync_log_*.md` exports
  carry device/OS metadata and internal paths; they are now excluded from vault
  sync so they don't reach the server as plaintext on an unencrypted vault.
- `SECURITY.md` was corrected: rollback of a document to a *genuine prior*
  `encBody` is detected on established devices by the vector-clock classifier, not
  by authentication, and is **not** detected on a fresh Clone (which has no local
  baseline) — the inherent trust-on-first-use window.

### Fixed

- **A malformed chunk no longer loops forever in live sync.** A corrupt chunk was
  classified identically at the Clone/repair boundary but the live-sync boundary
  caught only a hash mismatch, not a structurally malformed envelope — so a
  tampered/bit-rotted chunk retried indefinitely instead of being quarantined.
  Both boundaries now share one classifier.
- **A failed deletion is retried instead of silently un-applying.** A clean remote
  deletion applies the vault delete after the durable commit; if that delete threw
  or the process was killed mid-pull, the deletion was lost (a database tombstone
  with the file still on disk) and never retried. It is now recorded for durable
  re-application, the same net the content-apply path already had.
- **A concurrent remote edit is no longer dropped when the local copy is deleted.**
  The mirror of the v0.26.0 delete-vs-edit fix: a local deletion racing a remote
  edit is now persisted and re-presented after a restart, instead of the remote
  edit being lost once the local deletion had pushed.
- **A pulled deletion over a legacy baseline now surfaces a conflict instead of
  silently overwriting a divergent local edit**, by falling back to the stored
  document as the comparison baseline.
- **Chunk repair re-validates local references before deleting a local chunk**,
  closing the same scan-then-delete race the remote side already guarded against.

### Internal

- Codec error types moved to a dependency-free module so the sync pipeline no
  longer compile-depends on the encryption decorator.
- `ConfigSync`'s optional wiring is now a single options object rather than a long
  positional argument list.

## 0.26.0

Closes the four highest-severity findings from a full integrated review of the
v0.25.x data layer. They are fixed as the symmetric completion of two
invariants the codebase already relied on elsewhere — *everything read from the
(untrusted) remote is authenticated at a single boundary before it is trusted*,
and *no unresolved decision is lost when the pull cursor advances*. Each was
reproduced first (in a Docker e2e harness and on a real three-device fleet), and
the migration to the new encrypted-body format was rehearsed end to end on real
devices — which also surfaced and fixed two bugs that only appear under live
reconnect churn.

### ⚠️ Breaking — encrypted vaults must be re-initialised

The on-the-wire format for encrypted **file and config documents** changed
(`cipherVersion` 3, the new "encBody" scheme). A v0.26.0 client can still *read*
the previous format, but it only ever *writes* the new one, so a vault must not
be left running a mix of old and new clients.

**Encrypted vaults require a one-time destructive re-init:** stop sync on every
device → run **Init** on one device → **Clone** on the rest (the same procedure
used for past encryption changes; the passphrase is unchanged). The re-init also
clears any orphaned documents left by earlier re-inits. **Plaintext
(unencrypted) vaults are unaffected** and need no migration.

### Security

- **File and config document bodies are now authenticated and confidential.**
  Previously only the path was encrypted; the chunk list, vector clock, size and
  timestamps rode in the clear, and the AES-GCM ciphertext was not bound to the
  document id. A malicious or man-in-the-middle CouchDB could therefore reorder
  or substitute chunk references, swap a body onto another document, or roll back
  a vector clock undetected — and could read the vault's structure. Now the whole
  body is compressed-then-encrypted into a single `encBody` field, GCM-bound to
  the document id (the id is the additional authenticated data). Any tampering or
  id-swap fails authentication and the document is rejected; the server can no
  longer see which chunks a file is built from or its history. (Compression
  precedes encryption, so long chunk-id arrays still pack down — no size
  regression.)
- **Pulled chunks are verified on every path.** Live sync already re-hashed each
  pulled chunk against its content-addressed id, but the Clone (full-resync) and
  repair paths did not — so an untrusted server could substitute or roll back a
  chunk body during a Clone and the corruption landed silently. The hasher is now
  threaded through every fetch boundary; a chunk whose bytes don't match its id
  (or whose id algorithm can't be verified) is skipped and routed to repair
  instead of being trusted.

### Fixed

- **A remote deletion no longer silently un-deletes a locally edited file.** When
  a pulled deletion collided with an unpushed local edit, the conflict was shown
  only as an in-memory modal while the pull cursor advanced past it — so a missed
  or dismissed modal, or a restart, lost the deletion intent and the surviving
  edit quietly resurrected the file on the next push. The conflict is now recorded
  durably in the same transaction as the cursor advance and re-presented after a
  restart, exactly like the existing pending-apply recovery.
- **Chunk repair can no longer delete a chunk that was re-referenced after the
  scan.** The repair plan was derived from a possibly-stale consistency report;
  a chunk that another device re-referenced between the scan and the click was
  tombstoned anyway, breaking the referencing file. Repair now re-validates the
  live reference set immediately before deleting and re-analyses at click time.

### Hardening

- KDF parameters (PBKDF2 600k / SHA-256 / 16-byte salt) are now pinned by a
  regression test so a strength reduction can't slip in unnoticed, and
  `SECURITY.md` documents the new integrity / metadata-confidentiality
  guarantees alongside the residual offline-bruteforce and `data.json`-plaintext
  caveats.
- Duplicate conflict modals no longer stack when a long-lived unresolved
  conflict is re-emitted by successive sync sessions or reconnects (a guard in
  the conflict orchestrator), and a re-init of an already-encrypted vault now
  stamps the correct `cipherVersion`.

## 0.25.3

Hardens the data layer against the failure modes seen in the v0.25.0–0.25.2
migration logs, established as three architectural invariants rather than
point patches. All were reproduced on a real device before fixing, and the
e2e suite was overhauled to drive the real sync pipeline so these paths are
guarded going forward.

### Fixed

- **A chunk present but without content no longer crashes reconcile.** A
  content-less chunk doc used to slip past the "missing chunk" guard and blow
  up chunk reassembly with an opaque `cannot read 'length' of undefined`,
  failing every file in a reconcile pass. A chunk is now treated as available
  only when it has real content; an incomplete one is re-fetched, or surfaces
  the same clean "Missing N chunk(s)" error as an absent one (vault + config).
- **Broken files no longer ping-pong forever.** A file whose chunks are gone
  on both this device and the server (e.g. a synced log file whose chunks were
  GC'd mid-migration) used to be retried every reconcile — spamming errors and
  fighting chunk-repair. It is now **quarantined**: retry is suppressed and the
  file is surfaced once, with no data loss (another device may still hold the
  chunk), and it **recovers automatically** if the chunk reappears.
- **An interrupted Clone can no longer bring up a broken sync session.** A
  Clone that failed mid-way (e.g. a dropped connection) left the codec stack
  half-built — compression on, encryption off — and a reconnect would open a
  session on it, failing every chunk fetch with "cannot decompress
  still-encrypted body". A vault sync session now starts only when the vault is
  fully provisioned, and the client refuses to build an encrypt-less stack for
  an encrypted vault.
- **Quieter, safer shutdown.** Reconcile work no longer runs against a
  closing database during unload (no more `DatabaseClosedError` noise), and
  that error class is now correctly recognized.

### Added

- **Startup version banner in the log.** Every session's log now opens with
  `CouchSync v<version> starting — built <time>, commit <hash>`, so a log
  attached to a report self-identifies the exact build.

Internal: e2e tests now drive the real push/pull pipeline (attachments, codec,
catchup/longpoll, Init/Clone) against real CouchDB instead of hand-rolled
requests; added Init/Clone and at-rest encrypt+gzip verification, a
broken-file quarantine regression, and a `npm run bench` codec benchmark.

## 0.25.2

Makes the maintenance/diagnostic tooling work on **encrypted** vaults. The
chunk-consistency report and chunk-repair were written against the pre-v2,
pre-encryption data model (raw client, chunk content in the doc body,
plaintext ids) and were never updated for data-layer-v2.

### Fixed

- **Chunk consistency report was permanently stuck on encrypted vaults.**
  It talked to the remote with a raw (non-decrypting) client, so remote
  file-doc ids (`file:<hmac>`) never matched local plaintext ids and the
  convergence gate always reported "not converged" — the report and its
  repair never ran. It now uses the codec (encryption/compression) data
  client, so remote docs are seen with their restored plaintext ids.
- **Chunk-repair could corrupt an encrypted vault or pull empty chunks.**
  Via the raw client, repair-push wrote *plaintext* chunk bodies into an
  encrypted vault, and repair-pull fetched only doc bodies — which in v2
  carry no chunk content (it rides in the `c` attachment). Repair now runs
  through the codec client (push encrypts, ids translate) and reconstructs
  pulled chunk content from attachments, reusing the same primitive as
  clone/live-pull.
- **Remote enumeration could mis-page on large encrypted vaults.** The
  report's bespoke pager continued on the decrypted (plaintext) `row.id`;
  under encryption the remote is ordered by the `file:<hmac>` storage key,
  so paging jumped to the wrong place after the first batch. It now reuses
  the canonical `paginateAllDocs` helper, which continues on the raw
  `row.key`.

Internal: `VaultRemoteOps` now exposes `makeDataClient()` (codec-wrapped)
for data-plane diagnostics/maintenance; `makeClient()` is documented as
raw/admin-only (db create/destroy, connection test, `vault:meta`). Other
maintenance commands (verify-and-repair, chunk GC, log export, DB reset)
were audited and were already encryption-safe.

## 0.25.1

Fixes two issues surfaced during v0.24.2 → v0.25.0 migration, each by
re-establishing an invariant that the data-layer-v2 rewrite left implicit.

### Fixed

- **Pull-side "Missing N chunk(s)" / permanent ghost files (esp. exported
  logs).** The v2 push split file docs and chunk attachments into two
  parallel `bulkDocs` requests, so a file doc could become visible on the
  remote `_changes` feed before its chunks were durable — a peer then
  pulled the file, found chunks missing, and (because the pull checkpoint
  had already advanced) never retried, leaving the file silently absent.
  Large, write-once files like exported logs were the most exposed.
  - *Push order contract:* `pushDocs` now uses an ordered two-phase
    transport — chunks are committed first, then only the files whose
    chunks all landed; a file referencing a chunk that failed to push is
    withheld and retried.
  - *Pull durability:* a missing-chunk apply failure no longer advances
    the checkpoint past the file unrecorded. The file is recorded in a
    persistent pending-apply set (mirror of the push-side unpushed set)
    and re-applied every pull cycle — including on the idle longpoll —
    until its chunks become durable.

- **Live Sync could be started after a failed Init/Clone, against a
  half-built database.** Init/Clone destroy the local DB at the start but
  only advanced state to `setupDone` on success, so a failure during a
  re-run left the prior `setupDone`/`syncing` state — and an enabled Live
  Sync toggle. Setup is now atomic: it drops to a non-syncable
  `settingUp` state (persisted before the destructive step) and only
  reaches `setupDone` on confirmed success; a failure keeps Init/Clone
  available to retry but Live Sync disabled. Clone's encryption and
  compression settings are now committed only on success (compression
  runs from an in-memory override during the clone), so a failed clone
  leaves persisted settings untouched.

## 0.25.0 — data-layer-v2

Comprehensive rewrite of the data layer: chunk content moves into
CouchDB attachments, the codec axes (encryption, compression) become
independent toggles, four named modes are first-class, and every byte
persisted to the wire is self-describing so future format evolution can
proceed per-artifact without a full dual-reader migration.

This release is the technical foundation for a future v1.0 publication.
The version line stays in the 0.x family until the project is opened
publicly; the breaking changes below still apply (destructive migration
required from any earlier 0.x build).

### Breaking

- **Chunk hash boundary changed from base64 string to binary
  Uint8Array.** Doc identity (`chunk:<alg>:<hash>`) differs from any
  v0.x vault. There is no automated dual-reader path; migration is
  destructive (recreate the remote DB and re-Init from one device,
  Clone from the rest — see Migration below).
- **Chunk ids carry an explicit hash-algorithm tag** —
  `chunk:x64:<16-hex>` instead of `chunk:<16-hex>`. The default
  algorithm (`x64`, xxhash64 over plain bytes) is unchanged; a future
  switch to e.g. blake3 will mint `chunk:b3:...` ids alongside the
  existing cohort without ambiguity (invariant 14).
- **`ChunkDoc.data` (legacy base64 payload) removed entirely.**
  The canonical chunk payload now lives only in the CouchDB
  attachment `_attachments.c`; the local doc holds the binary
  `content` field as well so the push pipeline can re-wrap it
  without re-reading from vault. Drops the ~1.75× local-DB inflation
  that v0.24.x carried during the v2 transition.
- **`ChunkDoc.schemaVersion` (and FileDoc / ConfigDoc) is now a
  required field.** The 4 writer paths (chunker, sync-engine,
  vault-sync, config-sync) already stamped it; the type now matches
  the writer-side contract so a missing stamp is a compile error
  (invariant 11).
- **Encryption envelope format changed.** Legacy
  `base64(IV):base64(cipher)` (string fields) and `IV || cipher`
  (attachment binary) are gone. Both forms now carry a 1-byte codec
  header (`[bits][IV?][body]`), wrapped in base64 for the one remaining
  encrypted string field (`encryptedPath`) or written binary-direct for
  attachments. The header declares encrypted / compressed bits so a
  single byte sequence on the wire is decodable without consulting
  `vault:meta` (invariants 12, 13). See `SECURITY.md#envelope-format`.
- **`ConfigDoc` no longer carries an in-doc `data` payload.** Config
  files are chunked exactly like vault files — `ConfigDoc.chunks` is an
  ordered list of `chunk:<alg>:<hash>` ids and the body rides as chunk
  attachments. `CONFIG_SCHEMA_VERSION` is `3` (independent of the
  FileDoc/ChunkDoc v2 line so config can evolve separately). Encryption
  now touches only the `_id`/`encryptedPath` and the chunk attachment
  bodies — never an in-doc string blob.
- **`encryption:meta` document and `src/db/encryption-meta.ts`
  removed.** Already superseded by `vault:meta` in the previous
  release window; the migration shim (`LegacyEncryptionMetaDoc`) stays
  in `vault-meta.ts` for the Init-time legacy detection prompt.
- **`crypto.encrypt()` / `crypto.decrypt()` / `encryptPath()` /
  `decryptPath()` (string envelope API) physically removed from
  `CryptoProvider`.** Replaced by `encryptBytesIv()` / `decryptBytesIv()`
  primitives plus `envelope.ts:encryptString()` / `decryptString()`
  composition. Eliminates the possibility of accidentally re-emitting
  the legacy unversioned envelope.
- **`DiffRecord.source` (history rows) is now a required field.**
  The "undefined = local" back-compat hack from v0.21.x is gone;
  writers always stamp `source: "local" | "sync"` explicitly.
- **Each local Dexie DB carries a `_meta.schemaVersion = 1` row**
  (vault docs, vault meta, config docs, config meta, history, log).
  Stamped on first open via `ensureSchemaVersion()`; mismatch on a
  later open throws a degraded-state error so a build/data desync
  surfaces before any content read (invariant 15).

### Added

- **`src/db/envelope.ts` — unified codec envelope** module. Single
  `encodeEnvelope()` / `decodeEnvelope()` pair handles every
  persisted byte sequence (attachments + encrypted strings).
  `encryptString()` / `decryptString()` helpers compose the
  CryptoProvider primitive with the envelope so the only way to
  produce an encrypted string in this codebase is via the
  self-describing format.
- **Four codec modes**: `raw`, `gzip`, `encrypt`, `gzip-encrypt`,
  selectable independently at Init time. `gzip-encrypt` is the
  recommended default for untrusted servers.
- **CompressingCouchClient decorator** — gzip attachment bodies on
  push, gunzip on pull. Compression layer is outside encryption so
  the push path is plain → gzip → encrypt → wire.
- **CryptoProvider binary I/O**: `encryptBytesIv()` returns
  `{ iv, cipher }` and `decryptBytesIv(iv, cipher)` reverses it. The
  attachment encryptor packs these into the codec envelope
  (`[bits][IV][cipher]`), so raw cipher bytes never travel outside the
  self-describing format.
- **Pull pipeline reads chunks via attachment GET**, not `_changes`.
  Chunk rows in `_changes` are now dropped; `ensureChunks` fetches
  the binary payload directly. Catchup `_changes` feed shrinks
  ~100× on chunk-heavy batches.
- **Push pipeline routes chunks through `bulkDocsWithAttachments`**
  with the canonical binary attached; file docs continue via plain
  `_bulk_docs`. Files and chunks push in parallel via
  `Promise.all`.
- **`schemaVersion: 2` stamped on all writer-produced docs**, with
  a `CURRENT_SCHEMA_VERSION` constant and `SchemaVersion` literal
  type so future bumps are explicit.
- **Settings: `compressionEnabled` toggle** (default on) wired through
  the composition root. Disabled after Init / setup (server is
  source-of-record).
- **`SECURITY.md`** (repository root) — threat model and mode-selection
  guide for end users.
- **Test matrix**: `tests/sync-mode-matrix.test.ts` runs the
  attachment round-trip suite across all four codec modes via
  `describe.each` so regressions in any mode surface immediately.

### Internal

- Decorator stack composition: `CompressingCouchClient(EncryptingCouchClient(CouchClient))`,
  with each layer aware only of its own concern. Decorators now
  contract on envelope-formatted bytes at every boundary: each one
  parses the incoming envelope, transforms the body, ORs its bit
  (`compressed`=0x02 for Compressing, `encrypted`=0x01 for
  Encrypting), and re-encodes.
- New `Invariants 7-15`: decorator boundary, chunk attachment
  integrity, binary hash input, composition order, schemaVersion
  presence (writer-side enforcement via required type field),
  attachment envelope universality, encrypted-string envelope
  versioning, chunk-id algorithm self-declaration, local schema
  version traceability.
- `splitForPush` (`remote-couch.ts`) and `push-pipeline.ts` both
  envelope-wrap the chunk body before handing it to
  `bulkDocsWithAttachments`. The wire format `[codec][IV?][body]`
  is established at the boundary; decorators only modify it.
- `vault:meta` retains `kdfVersion` / `cipherVersion` /
  `compression.version` but is now explicitly the "capability
  declaration" of the vault, never consulted for per-blob decode
  (which is fully self-describing via the envelope header).
- **Init/Clone bulk paths paginated** to match steady-state robustness.
  `pullAll` streams `_all_docs` over keyset continuation
  (`DEFAULT_BATCH_SIZE` per request), fetching each batch's chunk
  attachments and committing it in its own write tx; `pushAll`
  enumerates ids via `listIds` and pushes one page at a time. Keys-mode
  `allDocs` is batched on the same boundary as `bulkGet`/`bulkDocs`.
  Bounds per-request HTTP payload (survivable under the 30 s mobile
  timeout) and peak memory (a large vault's chunk bodies are never all
  resident at once).
- **Init/Clone factory unification** — `VaultRemoteOps.setClientWrapper`
  (mutable setter) removed. The codec stack (`compress(encrypt(raw))`)
  is now built by a single private `wrapRemoteClient` closure on the
  plugin instance, reused by SyncEngine's live loop, VaultRemoteOps,
  and ConfigSync. Fixes a pre-existing bug where Init/Clone wrapped
  only with `EncryptingCouchClient` and silently dropped compression
  — visible only after the envelope header landed in v0.25.0 (wire
  byte was `0x01` instead of the expected `0x03`).
- **Chunk-id algorithm tag corrected for encrypted vaults** — the
  chunker takes a `ChunkHasher { alg, hash }` bundle instead of a
  bare hash function, so the tag stamped into `chunk:<alg>:<hash>`
  reflects the actually-used algorithm. Encrypted vaults now emit
  `chunk:hmac:<64-hex>` (HMAC-SHA256 of plain bytes) rather than
  mis-tagging as `chunk:x64:<64-hex>`. `ChunkHashAlg` gains the
  `hmac` variant and `ID_RANGE.chunk.hmac` joins `chunk.x64` for
  per-algorithm range queries.
- **ConfigDoc chunk-ification completed** (`CONFIG_SCHEMA_VERSION = 3`).
  Config files split into content-addressed chunks via the same
  `chunker` + `ChunkHasher` path as vault files; `config-sync` assembles
  them on write (`getChunks` / `assembleChunks`). Config thus inherits
  the full codec stack (gzip + encrypt + attachment storage) and the
  `config:meta` doc stays codec-free so a fresh-Clone device can read it
  before unlocking.

### Performance (dev vault baseline — 279 files, 900 docs, encrypted+gzipped baseline)

`_changes` feed during catchup: ~10 MB → ~50 KB (chunks no longer
inlined). The four-codec Init wall-clock breakdown, all 4 modes
re-measured on dev vault after the Init/Clone factory unification
landed (gzip actually applies during Init now — pre-fix the wire
header was `0x01` regardless of `compressionEnabled`):

| Mode | Init wall-clock | Δ vs raw | Notes |
|---|---|---|---|
| `raw` | 7.67 s | — | base case |
| `gzip` | 9.16 s | +19 % | gzip CPU overhead on a fast LAN |
| `encrypt` | 9.35 s | +22 % | AES-GCM dominates; no compression |
| `encrypt`+`gzip` | 8.97 s | +17 % | gzip shrinks the cipher input; smaller wire offsets some of the gzip CPU cost vs gzip-only |

Clone wall-clock (Dev2, full pull): **4.65 s** in `encrypt`+`gzip`
mode.

Initial-push 108 MB local-DB load (data + content double-storage) is
**eliminated** — ChunkDoc.data removal slimmed every chunk row to its
canonical binary `content` only.

### Migration

**Destructive — no automated upgrade from v0.x.** Doc identity changed
(binary chunk hashes), so old and new vaults cannot interoperate. To
migrate: stop sync on every device, recreate the remote DB, run **Init**
on one device (choosing the codec mode — encryption/compression are set
at Init), then **Clone** on the rest. Encrypted vaults require the same
passphrase on every device. See `SECURITY.md` for mode selection.

---

## Pre-1.0 history

See git log for v0.x development history. v0.24.x was the last
pre-data-layer-v2 release line.
