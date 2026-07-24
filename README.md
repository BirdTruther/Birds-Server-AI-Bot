# Birds-Server-AI-Bot

Multi-platform Discord + Twitch bot with Escape from Tarkov integration, CS2 integration, Gemini AI, voice music, and a live web dashboard.

**[Commands →](COMMANDS.md)** | **[Setup & Deployment →](SETUP.md)**

---

## What It Does

- **AI chat** — Mention the bot or reply to it. Supports text, image understanding, and image generation via Gemini.
- **Tarkov** — Item prices, ammo rankings, trader timers, map/boss info, player stats.
- **CS2** — Skin prices, float values, player stats, map callouts, case simulator.
- **Music** — YouTube voice playback via `yt-dlp` + `ffmpeg`. No API key required.
- **Twitch** — Connects to Twitch IRC and relays messages to Discord.
- **Dashboard** — Live web UI at `http://localhost:3001` for logs, persona switching, and Cultist tracking.

---

## Stack

| Layer | What |
|---|---|
| Runtime | Node.js ≥ 20.18.1 |
| Discord | discord.js 14 + @discordjs/voice 0.19.2 |
| AI | Google Gemini 2.5 Flash via `@ai-sdk/google` |
| Database | SQLite via `better-sqlite3` |
| Dashboard | Express + vanilla HTML |
| Music | `yt-dlp` + `ffmpeg` (system binaries) |
| Twitch | `tmi.js` |

---

## Module Layout

```
index.js                    # Entry point — Discord client, slash registration, event routing
dashboard-server.js         # Express API + dashboard frontend
music.js                    # Music slash command handler (ACTIVE)
music-player.js             # Voice engine — yt-dlp, ffmpeg, DAVE E2EE (ACTIVE)
music-player.deprecated.js  # Previous rewrite — reference only, not loaded at runtime
memory.js                   # SQLite conversation context
database.js                 # SQLite schema, log tables
logger.js                   # Structured logging to console + dashboard stream
personas.js                 # AI personality definitions
persona-manager.js          # Persona state and switching logic
commands/
  utility.js                # /ask, /image, /meme, /code, /clearmemory, /persona, /personas
  admin.js                  # /pzrestart (Birds Server specific)
  cs2.js                    # All CS2 commands
  tarkov.js                 # All Tarkov commands
services/
  ai.js                     # Gemini text generation + vision
  image.js                  # Gemini image generation + rate limiting
  twitch.js                 # Twitch IRC — self-initializing on require
public/
  dashboard.html            # Dashboard frontend
```

---

## Legal

[Terms of Service](TERMS_OF_SERVICE.md) · [Privacy Policy](PRIVACY_POLICY.md) · [License](LICENSE)

Developed by BirdTruther for the Birds Server community.
