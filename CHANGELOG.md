# Changelog

Alle nennenswerten Änderungen an lodestone werden hier dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
und das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

Die Einträge der jeweils installierten Version werden nach einem Update
automatisch in der App unter „Was ist neu" angezeigt.

## [1.0.0] - 2026-06-15

### Security

- **Sign-in tokens now live in your operating system's keychain** (the macOS
  Keychain, the Windows Credential Manager, or the Linux Secret Service) instead
  of a plaintext file. Tokens saved by older versions are migrated into the
  keychain automatically the first time an account is used. If no keychain is
  reachable, lodestone falls back to a file with owner-only permissions, so it
  keeps working on headless setups.

### Added

- **A redesigned interface.** lodestone got a full visual refresh: a cleaner,
  flat, typographic look with a consistent icon set, clearer per-account status
  (a coloured dot plus label for connected, connecting, and error), a tidier
  account list, and a proper toggle for the avatars setting.
- **More accessible throughout.** Visible keyboard focus rings, dialog roles and
  labels, Escape to close any dialog, labelled icon buttons, and respect for the
  system "reduce motion" setting.
- **Avatars can be turned off.** A new setting controls whether Minecraft head
  avatars are loaded at all. With them on, each head is fetched once and cached
  locally, so the list works offline afterwards and a UUID leaves your machine at
  most once. With them off, nothing is requested from any third party.
- **See a server before you connect.** The server field now pings the address as
  you type and shows whether the server is reachable, along with its version,
  player count, MOTD, and icon. A wrong address or a version mismatch is obvious
  before you start instead of after several failed attempts. Servers you have
  used recently appear as a quick-pick list under the field.
- **Reorder accounts by dragging.** Grab the handle on the left of a row to lift
  it out of the list and drop it anywhere; the new order is saved.

### Changed

- Internal state locking was hardened so a single unexpected error can no longer
  cascade and bring the whole app down.
- The app version now has a single source of truth, removing the version drift
  that could publish a build under the wrong number.
- The frontend was split into focused modules (state, API, icons, and one module
  per view), which makes the UI easier to maintain and extend.
- **Starting several accounts now spaces the connections out** instead of firing
  them all at once, which avoids tripping a server's join throttle or anti-bot
  checks when many accounts connect from one IP. Disconnecting everyone also
  cancels any connections still queued.
- Removed a couple of unused interface strings left over from before the
  whole-app resource readout.

### Fixed

- **Disconnect now reliably stops a bot.** Disconnecting could previously leave
  the bot running in the background; it now stops for good.
- **No more silent reconnects.** A stopped bot no longer rejoins the server on
  its own a few seconds later. The engine's built-in auto-reconnect was
  reconnecting behind the app's back; lodestone now fully controls reconnection,
  so the status you see matches what's really happening.
- **Clear error on servers it can't stay on.** If a bot connects but keeps
  getting dropped right after joining, lodestone now stops with an explanation
  instead of reconnecting forever.

## [0.4.1] - 2026-06-15

### Changed

- **No more Node.js requirement.** The Minecraft engine was rewritten from the
  Node/mineflayer sidecar to [azalea](https://github.com/azalea-rs/azalea), a
  pure-Rust headless client built into the app. Installing and running lodestone
  no longer needs Node.js (`LODESTONE_NODE` is gone), and the bots run inside the
  app instead of as separate processes.
- **Resource readout is now a whole-app total.** Because the bots share one
  process, CPU and memory are reported for the app as a whole rather than per
  account. Per-account status and uptime are unchanged.

### Note

- Accounts must sign in again once after updating: the token cache format
  changed with the new engine.

### Fixed

- Update Cargo.toml to change Rust edition from 2026 to 2021

## [0.4.0] - 2026-06-15

### Changed

- **No more Node.js requirement.** The Minecraft engine was rewritten from the
  Node/mineflayer sidecar to [azalea](https://github.com/azalea-rs/azalea), a
  pure-Rust headless client built into the app. Installing and running lodestone
  no longer needs Node.js (`LODESTONE_NODE` is gone), and the bots run inside the
  app instead of as separate processes.
- **Resource readout is now a whole-app total.** Because the bots share one
  process, CPU and memory are reported for the app as a whole rather than per
  account. Per-account status and uptime are unchanged.

### Note

- Accounts must sign in again once after updating: the token cache format
  changed with the new engine.

## [0.3.1] - 2026-06-14

### Fixed

- The Windows and Linux release builds failed to compile because a macOS-only
  window event was used on every platform. The dock-icon restore behaviour is
  now macOS-only, so all platforms build again.

## [0.3.0] - 2026-06-14

### Added

- **System tray.** lodestone now lives in the menu bar / tray. The tray menu
  shows how many bots are online and lets you reopen the window, start the
  selected accounts, disconnect everyone, or quit, without touching the main
  window. The tooltip reflects the live online count.
- **Account avatars.** Every account now shows its Minecraft head, so the list
  is much easier to scan at a glance.
- **Re-sign-in prompt.** If a running account's Microsoft session expires,
  lodestone reopens the device-code dialog for exactly that account instead of
  silently failing to reconnect. Cancelling stops the account.
- **Confirmation before removing an account**, so a stray click can no longer
  delete a sign-in by accident.

### Changed

- **Closing the window keeps lodestone running in the tray** instead of quitting,
  so your accounts stay connected in the background. Use the tray's *Quit* entry
  to exit completely.

### Fixed

- Bot status messages (kick reasons, connection failures, engine-start errors)
  now follow the selected interface language instead of always showing in
  German.

## [0.2.1] - 2026-06-14

### Behoben

- Fertige Builds bringen den Bot-Motor jetzt selbst mit (das Sidecar samt
  `node_modules` wird mitgeliefert) und finden Node.js auch bei einer
  Installation über nvm oder Homebrew. Vorher schlug der Start als gebündelte
  App mit „Sidecar-Start fehlgeschlagen" fehl.

## [0.2.0] - 2026-06-14

### Hinzugefügt

- Mehrsprachige Oberfläche (Deutsch und Englisch), umschaltbar im
  Einstellungs-Fenster.
- Neue Sprachen lassen sich über einfache JSON-Dateien im Ordner `locales`
  ergänzen, ganz ohne Code-Änderung.
- Einstellungs-Fenster mit Sprachwahl und manueller Update-Suche.

## [0.1.0] - 2026-06-14

Erste Veröffentlichung. 🎉

### Accounts & Verbindung

- Mehrere Microsoft-Accounts per Geräte-Code-Anmeldung hinzufügen. Einmal
  anmelden, danach übernimmt lodestone das Token-Handling.
- Eine Server-Adresse für alle Accounts (`host` oder `host:port`, SRV wird aufgelöst).
- Accounts per Checkbox auswählen und einzeln oder gesammelt verbinden/trennen.
- Headless: Die Bots laufen ohne Spielfenster mit minimalem Ressourcenverbrauch.
- Automatischer Reconnect bei unerwartetem Disconnect und leichtes Anti-AFK
  gegen Inaktivitäts-Kicks.

### Überblick

- Live-Status je Account (Getrennt / Verbinde / Verbunden) inkl. Verbindungsdauer.
- Ressourcen-Monitor: echte CPU- und RAM-Auslastung pro Account sowie als Gesamtsumme.

### Updates

- Eingebautes Auto-Update: lodestone prüft auf neue Versionen, lädt sie signiert
  herunter und installiert sie mit einem Klick.
- „Was ist neu" zeigt nach jedem Update die Änderungen der neuen Version direkt
  in der App.
