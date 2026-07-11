# Birds-Server-AI-Bot

A multi-platform Discord and Twitch bot with Escape from Tarkov integration, CS2 integration, AI personality with image generation and understanding, real-time web dashboard, and full **Discord Slash Command** support.

---

## Commands

All commands are available as slash commands (`/`). Slash commands support Discord autocomplete — just type `/` in any channel.

### 🎮 Tarkov

| Command | Description | Arguments |
|---|---|---|
| `/price` | Item price lookup (flea market & traders) | `item` (required) |
| `/bestammo` | Best ammo by caliber ranked by penetration | `caliber` (required) |
| `/trader` | Trader reset times (EST) | — |
| `/map` | Map info and boss spawns | `map` (required) |
| `/player` | Player stats via EFT API | `name` (required) |

### 🔫 CS2

| Command | Description | Arguments |
|---|---|---|
| `/cs2price` | Current Steam Market price for any skin | `skin` (required) |
| `/cs2float` | Float value and pattern seed from inspect link | `link` (required) |
| `/cs2stats` | All-time player stats (requires public Steam profile) | `steam` (required) |
| `/cs2map` | Competitive callouts and tips for active duty maps | `map` (required) |
| `/cs2case` | Simulate case openings with real Valve drop odds | `case`, `count`, `cost` (all required) |

> `/cs2stats` requires a `STEAM_API_KEY` in your `.env`. Get one free at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).

### 🎵 Music

| Command | Description | Arguments |
|---|---|---|
| `/play` | Search YouTube and play in your voice channel | `query` (required) |
| `/skip` | Skip the current track | — |
| `/stop` | Stop playback, clear queue, leave channel | — |
| `/queue` | Show the current queue | — |
| `/pause` | Pause playback | — |
| `/resume` | Resume a paused track | — |
| `/nowplaying` | Show the currently playing track | — |

### 🤖 AI & General

| Command | Description | Arguments |
|---|---|---|
| `/ask` | Ask the AI a question | `question` (required) |
| `/image` | Generate an AI image with Gemini | `prompt` (required) |
| `/persona` | Switch the bot's personality | `name` (required) |
| `/personas` | List all available personas | — |
| `/clearmemory` | Clear AI conversation memory for this channel | — |
| `/meme` | Fetch a random meme | — |
| `/code` | Get the GitHub repo link | — |

### 🧟 Server Admin

| Command | Description | Notes |
|---|---|---|
| `/pzrestart` | Trigger Project Zomboid server restart | Birds Server specific — see [Removing /pzrestart](#removing-pzrestart) |

> **Slash command setup:** Commands are registered **guild-scoped** on startup using `DISCORD_GUILD_ID`. They appear instantly in your server (no propagation delay). To use in multiple servers, switch `Routes.applicationGuildCommands` to `Routes.applicationCommands` in `index.js`.

---

## Features

### 🎵 Music Playback

Full voice channel music powered by `yt-dlp` + `ffmpeg` — no API keys required. Searches YouTube by name or accepts direct URLs. Auto-leaves after 30 seconds of silence.

#### System Requirements

- **yt-dlp** system binary:
  ```bash
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  ```
- **ffmpeg**: `sudo apt install ffmpeg`
- **`@discordjs/voice` 0.19.2+** — required for Discord's DAVE E2EE voice protocol. Older versions fail with close code `4017`.

#### Troubleshooting: Bot Won't Join Voice

If you see this in logs:
```
[VOICE WS CLOSE] code=4017 reason=E2EE/DAVE protocol required
```
Run:
```bash
npm install @discordjs/voice@0.19.2
sudo systemctl restart discordbot
```

---

### 👁️ AI Image Understanding

The bot uses Gemini 2.5 Flash to analyze images sent in Discord.

- Mention the bot with an attached image and ask a question
- Reply to any bot message with an image attached
- Supports JPEG, PNG, GIF, WebP — multiple images per message

**Examples:**
- Upload a Tarkov screenshot → `@ThePatrick what map is this?`
- Upload a loadout → `@ThePatrick rate this build`
- Upload an error message → `@ThePatrick what's wrong here?`

---

### 🎨 AI Image Generation

Trigger with `/image`, or mention the bot with `generate`, `create`, or `draw` keywords.

- Powered by Gemini 2.5 Flash Image
- Rate limited to 3 images per user per 5 minutes
- Discord only — outputs PNG

---

### 🤖 Auto-Features

- **Tangia Auto-Join** — Automatically joins dungeon/boss fights when TangiaBot announces them
- **Cultist Hunting Tracker** — Real-time Cultist spawn monitoring with dual-server tracking
- **Rotating Presence** — Bot status cycles through themed Tarkov, CS2, and Twitch activities on a configurable timer

---

### 📊 Web Dashboard

Live dashboard at `http://localhost:3001`:

- **Bot Status** — Uptime, memory usage, health checks
- **Command Log** — Real-time log of all commands with platform indicators and full message/response history
- **Persona Switcher** — Change bot personality on the fly
- **Cultist Tracker** — Live Tarkov time with spawn window notifications

---

### 🧟 Project Zomboid Server Restart

> ⚠️ **Birds Server specific.** If you forked this and don't run a PZ server, remove this command.

`/pzrestart` runs `sudo bash /home/pz_restart.sh` as a detached background process and reports back to Discord with who triggered it, the PID, and timestamp.

**Required sudoers rule** (`sudo visudo`):
```
birds ALL=(ALL) NOPASSWD: /bin/bash /home/pz_restart.sh
```
Replace `birds` with your bot's Linux user.

#### Removing `/pzrestart`

Two places now that commands are modular:
1. Delete `commands/admin.js` entirely, or remove the `pzrestart` builder and handler from it
2. Remove the `admin` import and its command defs from `index.js`

---

## Technical Stack

### Runtime
- **Node.js** `20.18.1`

### npm Dependencies

| Package | Version | Purpose |
|---|---|---|
| `discord.js` | `14.22.1` | Discord bot framework, gateway intents, slash commands |
| `@discordjs/voice` | `0.19.2` | Voice channel audio with native DAVE E2EE support |
| `@discordjs/opus` | `0.9.0` | Opus audio encoding for voice |
| `@ai-sdk/google` | `2.0.0` | Google Gemini AI (text + image generation) |
| `ai` | `5.0.60` | AI SDK core |
| `replicate` | `1.0.1` | Replicate image generation |
| `tmi.js` | `1.8.5` | Twitch chat integration |
| `express` | `4.22.2` | Web dashboard server |
| `cors` | `2.8.5` | CORS middleware for dashboard API |
| `better-sqlite3` | `11.10.0` | SQLite database for logs and memory |
| `dotenv` | `17.2.3` | Environment variable loading |

### System Dependencies

| Tool | Purpose |
|---|---|
| `yt-dlp` | YouTube audio search and extraction |
| `ffmpeg` | Audio transcoding pipeline for voice |

### External APIs

| API | Used For |
|---|---|
| [tarkov.dev](https://tarkov.dev) | GraphQL — item prices, ammo, maps |
| [eft-api.tech](https://eft-api.tech) | REST — Tarkov player stats |
| Steam Market API | CS2 skin prices and listings |
| Steam Web API | CS2 player statistics |
| CSFloat API | CS2 skin float values and patterns |
| meme-api.com | Random meme fetching |
| Discord API | Slash command registration via REST |

---

## Installation

### Prerequisites

- Node.js v20+
- Discord Bot Token + Application ID + Guild ID
- Twitch OAuth Token
- Google AI API Key
- EFT API Key *(optional)*
- Steam Web API Key *(optional, for `/cs2stats`)*

### Steps

1. **Clone**
   ```bash
   git clone https://github.com/BirdTruther/Birds-Server-AI-Bot.git
   cd Birds-Server-AI-Bot
   ```

2. **Install npm dependencies**
   ```bash
   npm ci
   ```

3. **Install system dependencies**
   ```bash
   # yt-dlp
   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
   sudo chmod a+rx /usr/local/bin/yt-dlp

   # ffmpeg
   sudo apt install ffmpeg
   ```

4. **Create `.env`**
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   DISCORD_CLIENT_ID=your_discord_application_id
   DISCORD_GUILD_ID=your_discord_server_id
   TWITCH_BOT_USERNAME=your_twitch_bot_username
   TWITCH_OAUTH_TOKEN=oauth:your_twitch_token
   TWITCH_CHANNEL=your_channel_name
   GOOGLE_GENERATIVE_AI_API_KEY=your_google_ai_api_key
   EFT_API_KEY=your_eft_api_key
   STEAM_API_KEY=your_steam_api_key
   ```

   | Variable | Where to get it |
   |---|---|
   | `DISCORD_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Token |
   | `DISCORD_CLIENT_ID` | Developer Portal → General Information → Application ID |
   | `DISCORD_GUILD_ID` | Discord → Server Settings → Widget, or right-click your server icon → Copy Server ID (enable Developer Mode first) |
   | `TWITCH_OAUTH_TOKEN` | [twitchapps.com/tmi](https://twitchapps.com/tmi) |
   | `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) |
   | `STEAM_API_KEY` | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |

5. **Start the bot**
   ```bash
   node index.js
   ```

6. **Start the dashboard** *(separate terminal)*
   ```bash
   node dashboard-server.js
   # Then open http://localhost:3001
   ```

### Deploying as a systemd Service (Linux)

```bash
# Place service file at /etc/systemd/system/discordbot.service
# then:
sudo systemctl daemon-reload
sudo systemctl enable discordbot
sudo systemctl start discordbot

# View live logs
sudo journalctl -u discordbot -f
```

### Updating the Bot

Use the included `update_bot.sh` script to pull and redeploy cleanly:

```bash
bash /home/birds/birds-server-ai-bot/update_bot.sh
```

The script: resets any local server changes → pulls from GitHub → runs `npm ci` (or regenerates the lockfile on mismatch) → rebuilds native modules → restarts the service → tails logs.

> ⚠️ **Never edit files directly on the server.** All changes must go through GitHub. The update script enforces this with `git reset --hard`.

### Discord Invite Scopes

Include both when generating your bot invite URL:
- `bot` — standard bot permissions
- `applications.commands` — required for slash commands

---

## Configuration

| Setting | Default | Location |
|---|---|---|
| Dashboard port | `3001` | `dashboard-server.js` |
| Twitch message limit | 490 chars | `services/twitch.js` |
| Twitch message delay | 1.5s | `services/twitch.js` |
| Cultist status interval | 30s | `index.js` |
| Image generation rate limit | 3 per user / 5 min | `services/image.js` |
| CS2 case key cost | $2.49 | `commands/cs2.js` — `CONFIG.CS2_KEY_COST_USD` |
| CS2 case max opens | 100 | `commands/cs2.js` — `CONFIG.CS2_CASE_MAX_OPENS` |
| CS2 price cache TTL | 30 min | `commands/cs2.js` — `CONFIG.CS2_PRICE_CACHE_TTL_MS` |
| Presence rotation interval | 5 min | `index.js` — `CONFIG.PRESENCE_ROTATE_MS` |

### AI Personas

Switchable via `/persona` or the web dashboard. Persona definitions live in `personas.js`, switching logic in `persona-manager.js`:

| Persona | Style |
|---|---|
| Aggressive/Mean | Toxic gamer energy with heavy sarcasm |
| Sassy & Stupid | Confidently wrong about everything |
| Nice & Smart | Actually helpful with accurate info |
| Paranoid Conspiracy | Everything is a hidden agenda |
| Sleepy/High Patrick | Forgetful, rambling, eventually correct |

### Tarkov Time
- 7× real-time ratio, Russia timezone (+3h)
- Cultist spawn window: **22:00–07:00** in-game time

---

## Architecture

The bot uses a **modular architecture**. `index.js` is a thin event router — all logic lives in dedicated modules.

```
Birds-Server-AI-Bot/
├── index.js               # Discord client, slash command registration, event routing
├── dashboard-server.js    # Express API + dashboard frontend server
├── music.js               # Music slash command handler (deferReply, routing)
├── music-player.js        # Voice connection (DAVE E2EE), yt-dlp, ffmpeg queue engine
├── memory.js              # SQLite conversation storage, context selection, auto-cleanup
├── database.js            # SQLite init, log tables, CDN URL tracking
├── logger.js              # Structured console + dashboard log emitter
├── personas.js            # AI personality definitions
├── persona-manager.js     # Persona state, switching logic
├── commands/
│   ├── utility.js         # /ask, /image, /meme, /code, /clearmemory, /persona, /personas
│   ├── admin.js           # /pzrestart (Birds Server specific)
│   ├── cs2.js             # All CS2 commands
│   └── tarkov.js          # All Tarkov commands
├── services/
│   ├── ai.js              # Gemini AI text + image generation
│   ├── image.js           # Image generation rate limiting + Replicate integration
│   └── twitch.js          # Twitch IRC via tmi.js
└── public/
    └── dashboard.html     # Dashboard frontend
```

### Module Responsibilities

| File | Responsibility |
|---|---|
| `index.js` | Discord/Twitch client setup, slash command registration, event routing to modules |
| `music.js` | Owns all music slash command interaction handling; only place that calls `deferReply` for music |
| `music-player.js` | Voice connection lifecycle (DAVE E2EE), yt-dlp search/stream, ffmpeg pipeline, per-guild queue |
| `commands/utility.js` | AI, image gen, meme, persona, memory utility commands |
| `commands/admin.js` | Server-specific admin commands (PZ restart) |
| `commands/cs2.js` | All CS2 slash commands and Steam API calls |
| `commands/tarkov.js` | All Tarkov slash commands and tarkov.dev GraphQL calls |
| `services/ai.js` | Gemini AI client, text generation, vision (image understanding) |
| `services/image.js` | Image generation with per-user rate limiting |
| `services/twitch.js` | Twitch IRC connection, message handling, relay to Discord |
| `memory.js` | SQLite conversation storage, smart context selection, auto-cleanup |
| `persona-manager.js` | Current persona state, `/persona` switching, dashboard sync |
| `personas.js` | All AI personality prompt definitions |
| `dashboard-server.js` | Express API, command logging, persona switcher, Cultist tracker |
| `database.js` | SQLite schema init, log tables, CDN URL tracking |
| `logger.js` | Structured logging to console and dashboard event stream |

---

## Dashboard API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/cultist/status` | Cultist tracker state |
| `POST` | `/api/cultist/toggle` | Enable/disable Cultist notifications |
| `GET` | `/api/bot/status` | Uptime and system stats |
| `GET` | `/api/persona/current` | Current persona |
| `POST` | `/api/persona/set` | Set persona `{persona: "key"}` |
| `GET` | `/api/bot/logs` | Command log history |
| `POST` | `/api/bot/logs/clear` | Clear all logs |

---

## Legal

- [Terms of Service](TERMS_OF_SERVICE.md)
- [Privacy Policy](PRIVACY_POLICY.md)

## Contributing

Feel free to submit issues or pull requests!

## License

See [LICENSE](LICENSE) for details.

## Credits

Developed by BirdTruther for the Birds Server community.

**Powered by:** Discord.js · Google Gemini AI · Tarkov.dev · EFT-API.tech · Steam APIs · CSFloat · tmi.js · yt-dlp · ffmpeg
