# Changelog

Alle nennenswerten Änderungen an lodestone werden hier dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
und das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

Die Einträge der jeweils installierten Version werden nach einem Update
automatisch in der App unter „Was ist neu" angezeigt.

## [Unreleased]

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
