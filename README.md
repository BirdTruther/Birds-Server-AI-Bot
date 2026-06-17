# Birds-Server-AI-Bot

A multi-platform Discord and Twitch bot with Escape from Tarkov integration, CS2 integration, AI personality with image generation and understanding, real-time web dashboard, and full **Discord Slash Command** support.

## Features

### ⚡ Discord Slash Commands (NEW!)

All bot commands are now available as native Discord slash commands — just type `/` in any channel to see the full list with descriptions and auto-complete options. Prefix commands (`!price`, etc.) still work alongside them.

| Slash Command | Description | Arguments |
|---|---|---|
| `/price` | Tarkov item price lookup | `item` (required) |
| `/bestammo` | Best ammo by caliber | `caliber` (required) |
| `/trader` | Trader reset times | — |
| `/map` | Map info and boss spawns | `map` (required) |
| `/player` | Tarkov player stats | `name` (required) |
| `/cs2price` | CS2 skin price on Steam Market | `skin` (required) |
| `/cs2float` | CS2 skin float value | `link` (required) |
| `/cs2stats` | CS2 player stats | `steam` (required) |
| `/cs2map` | CS2 map callouts and tips | `map` (required) |
| `/cs2case` | Simulate CS2 case openings | `case`, `count`, `cost` (all required) |
| `/meme` | Get a random meme | — |
| `/code` | Get the GitHub link | — |
| `/persona` | Switch bot persona | `name` (required) |
| `/personas` | List all available personas | — |
| `/clearmemory` | Clear AI memory for this channel | — |
| `/ask` | Ask the AI a question | `question` (required) |
| `/image` | Generate an AI image | `prompt` (required) |

> **Setup note:** Add `DISCORD_CLIENT_ID=your_application_id` to your `.env` file. Slash commands register globally on bot startup. Global propagation can take up to 1 hour — for instant testing, switch to guild-scoped registration in `index.js`.

---

### 👁️ AI Image Understanding

- **Analyze Photos** - Bot can understand and describe images sent by users
- **Multiple Image Support** - Send one or more images with your message
- **Context-Aware** - Ask questions about images: "What gun is this?" "Is this loadout good?"
- **Works with @mentions** - Mention the bot and attach an image, or reply to the bot with an image
- **Supports formats:** JPEG, PNG, GIF, WebP
- Examples:
  - `@ThePatrick` (with attached screenshot) - Bot analyzes and responds
  - Reply to bot with image: "What map is this?"
  - `@ThePatrick is this a good loadout?` (with inventory screenshot)

### 🎮 Tarkov Integration Commands

Available as both prefix (`!`) and slash (`/`) commands:

- `!price [item]` / `/price item:` - Item prices with flea market & trader data
- `!bestammo [caliber]` / `/bestammo caliber:` - Best ammo by penetration power
- `!trader` / `/trader` - Trader reset times (EST timezone)
- `!map [mapname]` / `/map map:` - Map info with boss spawns
- `!player [name]` / `/player name:` - Player stats via EFT API

### 🔫 CS2 Integration Commands

Available as both prefix (`!`) and slash (`/`) commands:

- `!cs2price [skin name]` / `/cs2price skin:` - Look up current Steam Market prices for any CS2 skin
  - Returns lowest price, 30-day median, active listing count, and a direct market link
  - Example: `!cs2price AK-47 | Redline (Field-Tested)`
- `!cs2float [inspect link]` / `/cs2float link:` - Get the float value and pattern seed for any CS2 skin
  - Paste the full inspect link from your inventory or the Steam Market (right-click → Inspect in Game)
  - Returns float value, wear tier, pattern seed, and any stickers on the skin
  - Example: `!cs2float steam://rungame/730/.../+csgo_econ_action_preview ...`
- `!cs2stats [username or SteamID64]` / `/cs2stats steam:` - Pull all-time CS2 stats for a Steam player
  - Returns K/D ratio, kills, deaths, headshot %, accuracy, matches played, win rate, MVPs, bombs planted/defused, and hours played
  - Player's Steam profile must be set to **Public** for stats to be visible
  - Example: `!cs2stats shroud` or `/cs2stats steam:76561197960287930`
- `!cs2map [map name]` / `/cs2map map:` - Get competitive callouts and tips for any active duty map
  - Covers: Mirage, Inferno, Nuke, Ancient, Anubis, Dust 2, Vertigo
  - Example: `!cs2map mirage`
- `!cs2case [case name] [count] [case price]` / `/cs2case case: count: cost:` - Simulate opening CS2 cases
  - Uses real Valve drop rate odds (79.9% Mil-Spec → 0.26% Knife/Gloves)
  - Includes StatTrak simulation (10% chance per drop)
  - Shows total cost including $2.49 key cost per case
  - Max 100 cases per command
  - Example: `!cs2case Recoil Case 10 0.50`

> **Note:** `!cs2stats` / `/cs2stats` requires a `STEAM_API_KEY` in your `.env` file. Get one free at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).

### 💬 General Commands

- `!code` / `!github` / `/code` - Share GitHub repo link
- `meme` / `/meme` - Fetch random meme from meme-api.com
- `@BotName` or `!patrick` / `/ask` - AI chat responses with switchable personas

### 🎨 AI Image Generation (Discord only)

- `@BotName generate [description]` / `/image prompt:` - Generate images using Google Gemini
- `@BotName create [description]` - Alternative trigger for image generation
- `@BotName draw [description]` - Another way to request images
- **Rate limiting:** 3 images per user per 5 minutes
- Examples:
  - `@ThePatrick generate a photo of a squirrel`
  - `/image prompt:a sunset over mountains`

### 🤖 Auto-Features

- **Tangia Auto-Join** - Automatically joins dungeon/boss fights when TangiaBot announces them
- **Cultist Hunting Tracker** - Real-time Cultist spawn time monitoring with dual-server tracking
- **Rotating Activity Status** - Bot presence cycles through themed activity statuses on a timer, covering Tarkov, CS2, and Twitch topics. The list and rotation interval are configured via `PRESENCE_ACTIVITIES` and `CONFIG.PRESENCE_ROTATE_MS` in `index.js`.

### 📊 Web Dashboard

A real-time web dashboard running on `http://localhost:3001` with:

- **Bot Status Monitor** - Uptime, memory usage, and health checks
- **Command Log** - Real-time logging of all bot commands (prefix and slash) with platform indicators, username tracking, full message/response display, and error highlighting
- **Persona Switcher** - Change bot personality on-the-fly
- **Cultist Tracker** - Live Tarkov time conversion with spawn notifications
- **Modern UI** - Clean interface with status indicators

## Technical Stack

### Core Technologies
- **Discord.js v14** - Discord bot framework with Gateway intents and slash command support
- **tmi.js** - Twitch chat integration
- **Express.js** - Web dashboard server
- **Better-sqlite3** - SQLite database for logs and conversation memory
- **Google Gemini AI** - Powered by `@ai-sdk/google`
  - **Gemini 2.5 Flash** - Text chat responses with smart conversation memory and multimodal image understanding
  - **Gemini 2.5 Flash Image** - AI image generation

### APIs
- **tarkov.dev** - GraphQL queries for item prices, ammo stats, maps
- **eft-api.tech** - REST API for player statistics
- **Steam Market API** - CS2 skin prices and listing data
- **Steam Web API** - CS2 player statistics and profile lookups
- **CSFloat API** - CS2 skin float values and pattern seeds
- **meme-api.com** - Random meme fetching
- **Discord API** - Slash command registration via REST

### Dependencies
```json
{
  "@ai-sdk/google": "latest",
  "ai": "^5.0.60",
  "discord.js": "^14.22.1",
  "dotenv": "^17.2.3",
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "better-sqlite3": "latest",
  "tmi.js": "^1.8.5",
  "graphql-request": "latest",
  "node-fetch": "latest"
}
```

## Installation

### Prerequisites
- Node.js (v16 or higher)
- Discord Bot Token
- Discord Application/Client ID
- Twitch OAuth Token
- Google AI API Key (for Gemini)
- EFT API Key (optional, for player stats)
- Steam Web API Key (optional, for `cs2stats`)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/BirdTruther/Birds-Server-AI-Bot.git
   cd Birds-Server-AI-Bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the root directory:
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   DISCORD_CLIENT_ID=your_discord_application_id
   TWITCH_BOT_USERNAME=your_twitch_bot_username
   TWITCH_OAUTH_TOKEN=oauth:your_twitch_token
   TWITCH_CHANNEL=your_channel_name
   GOOGLE_GENERATIVE_AI_API_KEY=your_google_ai_api_key
   EFT_API_KEY=your_eft_api_key
   STEAM_API_KEY=your_steam_api_key
   ```

   > `DISCORD_CLIENT_ID` is your bot's **Application ID** found in the [Discord Developer Portal](https://discord.com/developers/applications). It is required for slash command registration.

4. **Run the bot**
   ```bash
   node index.js
   ```

5. **Run the dashboard** (in a separate terminal)
   ```bash
   node dashboard-server.js
   ```

6. **Access the dashboard**

   Open your browser to `http://localhost:3001`

### Invite URL Scopes

When generating your bot's invite URL in the Discord Developer Portal, make sure to include **both** of these OAuth2 scopes:

- `bot` — for standard bot permissions
- `applications.commands` — required for slash commands to appear in servers

## Configuration

### Key Settings

- **Twitch Message Limit** - 490 characters with smart chunking at sentence boundaries
- **Message Delay** - 1.5s between Twitch messages
- **Dashboard Port** - 3001 (configurable in `dashboard-server.js`)
- **Status Update Interval** - 30 seconds for Cultist tracker
- **Image Generation Rate Limit** - 3 images per user per 5 minutes
- **Conversation Memory** - Smart SQLite-based context selection
- **Image Understanding** - Supports JPEG, PNG, GIF, WebP formats
- **CS2 Case Key Cost** - $2.49 per key (configurable in `CONFIG.CS2_KEY_COST_USD`)
- **CS2 Case Max Opens** - 100 per command (configurable in `CONFIG.CS2_CASE_MAX_OPENS`)
- **CS2 Price Cache TTL** - 30 minutes (configurable in `CONFIG.CS2_PRICE_CACHE_TTL_MS`)
- **Presence Rotation Interval** - 5 minutes (configurable in `CONFIG.PRESENCE_ROTATE_MS` in `index.js`)
- **Presence Activities List** - Themed rotating statuses (configurable in `PRESENCE_ACTIVITIES` array in `index.js`)

### Smart Memory System

The bot uses an intelligent conversation memory system (`memory.js`) that:

- **Stores conversations** in SQLite database per channel/platform
- **Smart context selection** - Only sends last 8 relevant messages to AI
- **Reduces token usage** - Filters messages older than 24 hours
- **Per-channel tracking** - Separate memory for each Discord channel and Twitch stream
- **Auto-cleanup** - Removes messages older than 7 days
- **Persists across restarts** - Conversation history saved in database

**Memory Configuration:**
- Max context messages sent to AI: 8
- Max message age: 24 hours
- Messages kept per channel: 1000
- Auto-cleanup interval: Every hour

### AI Personas

The bot includes multiple switchable personalities defined in `personas.js`. All personas are **general-purpose gamers** that respond to any topic:

- **Aggressive/Mean** - Classic toxic gamer energy with heavy sarcasm
- **Sassy & Stupid** - Confidently incorrect about everything
- **Nice & Smart** - Actually helpful with accurate information
- **Paranoid Conspiracy** - Everything is a conspiracy or hidden agenda
- **Sleepy/High Patrick** - Forgetful and rambling but eventually correct

Personas can be switched via `/persona`, `!persona`, or the web dashboard.

### Tracked Traders
Prapor, Therapist, Fence, Skier, Peacekeeper, Mechanic, Ragman, Jaeger, Ref

### Tarkov Time Calculation
- Uses 7x real-time ratio
- Russia timezone offset (+3 hours)
- Cultist spawn window: 22:00-07:00 in-game time

## Architecture

### Main Bot (`index.js`)
- Discord message handling (prefix commands)
- Discord slash command registration and handling (`InteractionCreate`)
- Twitch chat integration
- AI personality responses with Gemini
- AI image generation with rate limiting
- AI image understanding with multimodal support
- Tarkov API integrations
- CS2 API integrations (Steam Market, Steam Web API, CSFloat)
- Auto-join functionality
- Smart conversation memory system
- Rotating Discord activity/presence status

### Memory System (`memory.js`)
- SQLite-based conversation storage
- Per-channel context tracking
- Smart message filtering and selection
- Automatic cleanup of old conversations
- Token usage optimization

### Dashboard Server (`dashboard-server.js`)
- Express web server
- REST API endpoints for bot status
- Command logging system with live updates
- Persona switching functionality
- Cultist tracking state management
- Real-time Tarkov time calculations

### Database (`database.js`)
- SQLite database initialization
- Command logging with full message history
- Discord CDN image URL tracking
- Automatic cleanup of old logs

### Personas (`personas.js`)
- Multiple AI personality definitions
- General-purpose gamer personalities
- Platform-specific response guidelines

### Public Assets (`public/`)
- `dashboard.html` - Frontend interface with live updates and clickable image links

## API Endpoints

### Dashboard API

- `GET /` - Serves dashboard HTML
- `GET /api/cultist/status` - Returns current Cultist tracker state
- `POST /api/cultist/toggle` - Enable/disable Cultist notifications
- `GET /api/bot/status` - Returns bot uptime and system stats
- `GET /api/persona/current` - Get current bot persona
- `POST /api/persona/set` - Change bot persona (body: `{persona: "key"}`)
- `GET /api/bot/logs` - Get command log history from SQLite
- `POST /api/bot/logs/clear` - Clear all command logs

## Image Features

### Image Understanding

The bot uses Google's Gemini 2.5 Flash model with multimodal capabilities to understand images:

- **Trigger methods:**
  - Mention bot with attached image(s)
  - Reply to bot with attached image(s)
  - No special keywords needed — just attach and ask
- **Platform:** Discord only (Twitch doesn't support image uploads)
- **Supported formats:** JPEG, PNG, GIF, WebP
- **Multiple images:** Can analyze several images in one message

### Image Generation

The bot uses Google's Gemini 2.5 Flash Image model for AI image generation:

- **Trigger keywords (prefix):** generate, create, draw, make image/picture
- **Slash command:** `/image prompt:your description here`
- **Platform:** Discord only
- **Rate limiting:** 3 images per user per 5 minutes
- **Format:** PNG

## How to Use Image Understanding

1. Upload an image to Discord
2. In the same message, @mention the bot and ask a question
3. Bot analyzes the image and responds

**Examples:**
- Upload Tarkov screenshot → `@ThePatrick what map is this?`
- Upload loadout screenshot → `@ThePatrick rate this build`
- Upload meme → `@ThePatrick explain this`
- Upload error message → `@ThePatrick what's wrong here?`

**Reply mode:**
- Bot sends a message → you reply with an image attached → bot analyzes it in context

## Legal

- [Terms of Service](TERMS_OF_SERVICE.md)
- [Privacy Policy](PRIVACY_POLICY.md)

## Contributing

Feel free to submit issues or pull requests for improvements!

## License

See [LICENSE](LICENSE) file for details.

## Credits

Developed by BirdTruther for the Birds Server community.

### Powered By
- Google Gemini AI (2.5 Flash & 2.5 Flash Image)
- Tarkov.dev API
- EFT-API.tech
- Steam Market API
- Steam Web API
- CSFloat API
- Discord.js
