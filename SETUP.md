# Setup & Deployment

---

## Prerequisites

- Node.js ≥ 20.18.1
- `yt-dlp` and `ffmpeg` system binaries (for music)
- A Discord application with a bot token
- A Twitch account for the bot user + OAuth token

---

## Installation

### 1. Clone

```bash
git clone https://github.com/BirdTruther/Birds-Server-AI-Bot.git
cd Birds-Server-AI-Bot
```

### 2. Install npm dependencies

```bash
npm ci
```

### 3. Install system dependencies

```bash
# yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# ffmpeg
sudo apt install ffmpeg
```

### 4. Create `.env`

```bash
cp .env.example .env
```

Then fill in your values:

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | [Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `DISCORD_CLIENT_ID` | ✅ | Developer Portal → General Information → Application ID |
| `DISCORD_GUILD_ID` | ✅ | Right-click server icon → Copy Server ID (requires Developer Mode) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | ✅ | [aistudio.google.com](https://aistudio.google.com) |
| `TWITCH_BOT_USERNAME` | ✅ | Your Twitch bot account username |
| `TWITCH_OAUTH_TOKEN` | ✅ | [twitchapps.com/tmi](https://twitchapps.com/tmi) |
| `TWITCH_CHANNEL` | ✅ | Your Twitch channel name (no `#`) |
| `EFT_API_KEY` | Optional | [eft-api.tech](https://eft-api.tech) — required for `/player` |
| `STEAM_API_KEY` | Optional | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) — required for `/cs2stats` |
| `CSGOSKINS_API_KEY` | Optional | Required for `/cs2price` |
| `CSFLOAT_API_KEY` | Optional | [csfloat.com](https://csfloat.com) — required for `/cs2float` |

### 5. Start

```bash
# Bot
node index.js

# Dashboard (separate terminal)
node dashboard-server.js
# → http://localhost:3001
```

---

## Discord Bot Invite Scopes

Include both when generating your bot invite URL:
- `bot`
- `applications.commands`

---

## systemd Service (Linux)

Create `/etc/systemd/system/discordbot.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable discordbot
sudo systemctl start discordbot

# Live logs
sudo journalctl -u discordbot -f
```

---

## Updating

Use `update_bot.sh` to pull and redeploy cleanly:

```bash
bash /home/birds/birds-server-ai-bot/update_bot.sh
```

The script: hard-resets local changes → pulls from GitHub → runs `npm ci` → rebuilds native modules → restarts the service → tails logs.

> ⚠️ **Never edit files directly on the server.** All changes must go through GitHub. The update script enforces this with `git reset --hard`.

---

## Music Troubleshooting

If the bot won't join voice and you see:

```
[VOICE WS CLOSE] code=4017 reason=E2EE/DAVE protocol required
```

Run:

```bash
npm install @discordjs/voice@0.19.2
sudo systemctl restart discordbot
```

---

## Configuration Reference

| Setting | Default | Location |
|---|---|---|
| Dashboard port | `3001` | `dashboard-server.js` |
| Twitch message limit | 490 chars | `services/twitch.js` |
| Twitch message delay | 1.5s | `services/twitch.js` |
| Cultist status interval | 30s | `index.js` |
| Image rate limit | 3 per user / 60s | `services/image.js` |
| CS2 case key cost | $2.49 | `commands/cs2.js` → `CONFIG.CS2_KEY_COST_USD` |
| CS2 case max opens | 100 | `commands/cs2.js` → `CONFIG.CS2_CASE_MAX_OPENS` |
| CS2 price cache TTL | 30 min | `commands/cs2.js` → `CONFIG.CS2_PRICE_CACHE_TTL_MS` |
| Presence rotation interval | 5 min | `index.js` → `CONFIG.PRESENCE_ROTATE_MS` |

### Tarkov Time
- 7× real-time ratio, Russia timezone (+3h)
- Cultist spawn window: **22:00–07:00** in-game time

---

## Removing `/pzrestart`

`/pzrestart` is Birds Server specific. To remove it:

1. Delete `commands/admin.js`
2. Remove the `admin` import and command registration from `index.js`

If you keep it, add a sudoers rule (`sudo visudo`):

```
birds ALL=(ALL) NOPASSWD: /bin/bash /home/pz_restart.sh
```

Replace `birds` with your bot's Linux user.

---

## Dashboard API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/bot/status` | Uptime and system stats |
| `GET` | `/api/bot/logs` | Command log history |
| `POST` | `/api/bot/logs/clear` | Clear all logs |
| `GET` | `/api/persona/current` | Current persona |
| `POST` | `/api/persona/set` | Set persona `{ "persona": "key" }` |
| `GET` | `/api/cultist/status` | Cultist tracker state |
| `POST` | `/api/cultist/toggle` | Enable/disable Cultist notifications |
