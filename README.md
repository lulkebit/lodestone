<p align="center">
  <img src="src/assets/logo.png" alt="lodestone" width="64" height="64" />
</p>

# lodestone — Headless Minecraft AFK Manager

Eine schlanke Desktop-App, um mehrere Minecraft-Accounts **headless** (ohne
Spielfenster, minimal CPU/RAM) gleichzeitig auf einen Server zu bringen und
dort eingeloggt zu halten — inkl. Microsoft-Login, Live-Status und Disconnect.

Ziel-Minecraftversion: **1.21.11** (Protokoll 774).

## Features

- **Microsoft-Login pro Account** über den Device-Code-Flow. Tokens werden
  lokal gecacht → einmal anmelden, danach kein erneuter Login nötig.
- **Checkbox-Auswahl**, welche Accounts gestartet werden.
- **Eine Server-Adresse** für alle Accounts (`host` oder `host:port`,
  SRV-Records werden aufgelöst).
- **Headless** — die Bots haben kein Render-Fenster, nur die Netzwerk-/
  Protokoll-Schicht läuft.
- **Live-Status** je Account: Getrennt / Verbinde / Verbunden + **Uptime**,
  sowie **Verbinden/Trennen** einzeln oder für alle.
- **Ressourcen-Monitor**: echte **CPU/RAM pro Account** (jeder Bot läuft in
  einem eigenen Prozess) plus **Gesamt**-Summe (CPU, RAM, aktive Bots).
- Leichtes **Anti-AFK** (gelegentliches Umschauen/Armschwingen), damit Server
  einen nicht wegen Inaktivität kicken.
- **Auto-Reconnect** mit exponentiellem Backoff (5→60 s) bei unerwartetem
  Disconnect; gibt nur auf, wenn die Erstverbindung 8× in Folge scheitert
  (z. B. Ban/Whitelist). Der Status zeigt „Reconnect #N".

## Architektur

```
┌─────────────────────────────┐
│ Tauri-Fenster (WKWebView)    │  Frontend: src/ (Vanilla HTML/CSS/JS)
│  └ invoke() / event listen   │
├─────────────────────────────┤
│ Rust-Backend (src-tauri/)    │  Config-Persistenz + Prozess-Management
│  • store.rs   Accounts/Server│
│  • engine.rs  spawnt Prozesse│  ←── stdout JSON je Prozess ──┐
│  • lib.rs     Tauri-Commands │                               │
└─────────────────────────────┘                               │
                                                               ▼
   Ein Prozess pro Bot (echte CPU/RAM)      kurzlebig je Login
   ┌──────────────────────────────────┐    ┌────────────────────────┐
   │ sidecar/bot-worker.mjs  (× N)     │    │ sidecar/login.mjs       │
   │  • mineflayer  → MC-Bot, headless │    │  • prismarine-auth      │
   │  • self-reported cpu/rss alle 2 s │    │    → MS-Device-Code      │
   └──────────────────────────────────┘    └────────────────────────┘
        (gemeinsame Helfer: sidecar/shared.mjs)
```

Warum ein Node-Sidecar? Die reine Rust-Bibliothek (azalea) unterstützt 1.21.11
nur in einer Version, die in Pre-Release-Dependency-Konflikten feststeckt.
**Mineflayer** ist der zuverlässige Industriestandard für headless MC-Bots mit
garantiertem 1.21.11-Support. Die Tauri-Shell bleibt leichtgewichtig (nativer
WebView statt Chromium), Node läuft als schlanker Hintergrundprozess.

## Voraussetzungen

- **Node.js** (getestet mit v22) — wird zur Laufzeit für den Sidecar gebraucht.
- **Rust** (stable) + Tauri-Systemvoraussetzungen.

## Starten (Entwicklung)

```bash
npm install            # Frontend-/Sidecar-Abhängigkeiten (mineflayer, prismarine-auth, Tauri-CLI)
npm run tauri dev      # baut das Rust-Backend und öffnet das Fenster
```

## Bedienung

1. **Account hinzufügen** → ein Code + Link erscheinen. Seite öffnen, Code
   eingeben, mit Microsoft anmelden. Das Fenster schließt sich automatisch.
2. **Server** eintragen (z. B. `mc.example.net` oder `192.168.0.10:25565`).
3. Accounts per **Checkbox** auswählen.
4. **Ausgewählte starten** — oder einzeln „Verbinden". Status & Uptime laufen
   live mit; „Trennen" / „Alle trennen" beendet die Verbindungen.

## Daten & Speicherorte

- Config (Accounts, Auswahl, Server-Adresse):
  `~/Library/Application Support/com.lodestone.app/config.json`
- Auth-Token-Cache (prismarine-auth):
  `~/Library/Application Support/com.lodestone.app/auth-cache/`

Es werden **keine Passwörter** gespeichert — nur die von Microsoft
ausgestellten, erneuerbaren Tokens.

## Bekannte Einschränkungen

- **Produktions-Bundle** (`npm run tauri build`): Der Node-Sidecar und seine
  `node_modules` werden aktuell **nicht** mitgebündelt, und `node` muss im PATH
  liegen. Für `tauri dev` funktioniert alles. Zum Verteilen müsste man den
  Sidecar als Resource bündeln (oder zu einer Single-Binary packen, z. B. via
  `node --experimental-sea-config` / `pkg`) und ggf. den Node-Pfad über die
  Umgebungsvariable `LODESTONE_NODE` setzen.

## Konfiguration

- `LODESTONE_NODE` — absoluter Pfad zur `node`-Binary, falls sie nicht im PATH ist.
