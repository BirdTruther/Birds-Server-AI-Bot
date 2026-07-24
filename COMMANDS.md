# Commands

All commands are Discord slash commands. Type `/` in any channel — Discord autocomplete shows them instantly.

Commands are registered **guild-scoped** to `DISCORD_GUILD_ID` on startup.

---

## Tarkov

| Command | Description | Args |
|---|---|---|
| `/price` | Flea market & trader prices | `item` |
| `/bestammo` | Best ammo by caliber, ranked by penetration | `caliber` |
| `/trader` | Trader reset times (EST) | — |
| `/map` | Map info and boss spawns | `map` |
| `/player` | Player stats via EFT API | `name` |

---

## CS2

| Command | Description | Args |
|---|---|---|
| `/cs2price` | Current Steam Market skin price | `skin` |
| `/cs2float` | Float value + pattern seed from inspect link | `link` |
| `/cs2stats` | All-time player stats (public profile required) | `steam` |
| `/cs2map` | Competitive callouts for active duty maps | `map` |
| `/cs2case` | Case opening simulator with real Valve odds | `case`, `count`, `cost` |

> `/cs2float` requires `CSFLOAT_API_KEY`. `/cs2stats` requires `STEAM_API_KEY`. `/cs2price` requires `CSGOSKINS_API_KEY`.

---

## Music

| Command | Description |
|---|---|
| `/play` | Search YouTube and play in your voice channel |
| `/skip` | Skip the current track |
| `/stop` | Stop playback, clear queue, leave channel |
| `/queue` | Show the current queue |
| `/pause` | Pause playback |
| `/resume` | Resume a paused track |
| `/nowplaying` | Show the currently playing track |

Music uses `yt-dlp` + `ffmpeg` — no API key required.

---

## AI & General

| Command | Description | Args |
|---|---|---|
| `/ask` | Ask the AI a question | `question` |
| `/image` | Generate an AI image with Gemini | `prompt` |
| `/persona` | Switch the bot's personality | `name` |
| `/personas` | List all available personas | — |
| `/clearmemory` | Clear conversation memory for this channel | — |
| `/meme` | Fetch a random meme | — |
| `/code` | Get the GitHub repo link | — |

You can also **mention** the bot or **reply** to a bot message to chat with it directly. Attach an image to have it analyzed.

---

## Server Admin

| Command | Description |
|---|---|
| `/pzrestart` | Trigger a Project Zomboid server restart |

> **Birds Server specific.** See [Removing /pzrestart](SETUP.md#removing-pzrestart) if you don't run a PZ server.

---

## AI Personas

Switch via `/persona` or the web dashboard.

| Persona | Style |
|---|---|
| Aggressive/Mean | Toxic gamer energy with heavy sarcasm |
| Sassy & Stupid | Confidently wrong about everything |
| Nice & Smart | Actually helpful with accurate info |
| Paranoid Conspiracy | Everything is a hidden agenda |
| Sleepy/High Patrick | Forgetful, rambling, eventually correct |
