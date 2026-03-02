# Birds-Server-AI-Bot

A multi-platform Discord and Twitch bot with Escape from Tarkov integration, AI personality with image generation, and real-time web dashboard.

## Features

### 🎮 Tarkov Integration Commands

- `!price [item]` - Item prices with flea market & trader data
- `!bestammo [caliber]` - Best ammo by penetration power
- `!trader` - Trader reset times (EST timezone)
- `!map [mapname]` - Map info with boss spawns
- `!player [name]` - Player stats via EFT API (PMC/SCAV K/D, level)

### 💬 General Commands

- `!code` / `!github` - Share GitHub repo link
- `meme` - Fetch random meme from meme-api.com
- `@BotName` or `!patrick` - AI chat responses with switchable personas

### 🎨 AI Image Generation (Discord only)

- `@BotName generate [description]` - Generate images using Google Gemini 2.5 Flash Image
- `@BotName create [description]` - Alternative trigger for image generation
- `@BotName draw [description]` - Another way to request images
- **Rate limiting:** 1 image per user per minute
- Examples:
  - `@ThePatrick generate a photo of a squirrel`
  - `@ThePatrick draw a sunset over mountains`
  - `@ThePatrick create abstract art`

### 🤖 Auto-Features

- **Tangia Auto-Join** - Automatically joins dungeon/boss fights when TangiaBot announces them (1s delay)
- **Cultist Hunting Tracker** - Real-time Cultist spawn time monitoring with dual-server tracking

### 📊 Web Dashboard

A real-time web dashboard running on `http://localhost:3001` with:

- **Bot Status Monitor** - Uptime, memory usage, and health checks
- **Command Log** - Real-time logging of all bot commands with:
  - Platform indicators (Discord/Twitch)
  - Username and command tracking
  - Full message and response display
  - Error highlighting
  - Auto-scrolling live updates
- **Persona Switcher** - Change bot personality on-the-fly:
  - Aggressive/Mean (default "ThePatrick" persona)
  - Friendly/Helpful
  - Sarcastic
  - Professional
  - Changes apply immediately to all new conversations
- **Cultist Tracker** - Live Tarkov time conversion with spawn notifications
  - Tracks Cultist spawn windows (22:00-07:00 in-game time)
  - Monitors two servers with 12-hour offset
  - Toggle controls for enabling/disabling notifications
  - Updates every 30 seconds
- **Modern UI** - Clean interface with status indicators

## Technical Stack

### Core Technologies
- **Discord.js** - Discord bot framework with Gateway intents
- **tmi.js** - Twitch chat integration
- **Express.js** - Web dashboard server
- **Google Gemini AI** - Powered by `@ai-sdk/google`
  - **Gemini 2.5 Flash** - Text chat responses with conversation memory
  - **Gemini 2.5 Flash Image** - AI image generation

### APIs
- **tarkov.dev** - GraphQL queries for item prices, ammo stats, maps
- **eft-api.tech** - REST API for player statistics
- **meme-api.com** - Random meme fetching

### Dependencies
```json
{
  "@ai-sdk/google": "latest",
  "ai": "^5.0.60",
  "discord.js": "^14.22.1",
  "dotenv": "^17.2.3",
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "tmi.js": "^1.8.5",
  "graphql-request": "latest",
  "node-fetch": "latest"
}
```

## Installation

### Prerequisites
- Node.js (v16 or higher)
- Discord Bot Token
- Twitch OAuth Token
- Google AI API Key (for Gemini)
- EFT API Key (optional, for player stats)

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
   TWITCH_BOT_USERNAME=your_twitch_bot_username
   TWITCH_OAUTH_TOKEN=oauth:your_twitch_token
   TWITCH_CHANNEL=your_channel_name
   GOOGLE_GENERATIVE_AI_API_KEY=your_google_ai_api_key
   EFT_API_KEY=your_eft_api_key
   ```

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

## Configuration

### Key Settings

- **Twitch Message Limit** - 480 characters with smart chunking at sentence boundaries
- **Message Delay** - 1.5s between Twitch messages
- **Dashboard Port** - 3001 (configurable in `dashboard-server.js`)
- **Status Update Interval** - 30 seconds for Cultist tracker
- **Image Generation** - 60 second cooldown per user
- **Conversation Memory** - Last 5 messages per platform

### AI Personas

The bot includes multiple switchable personalities defined in `personas.js`:
- **Aggressive/Mean** - The default "ThePatrick" persona with attitude
- **Friendly/Helpful** - Supportive and encouraging responses
- **Sarcastic** - Witty and dry humor
- **Professional** - Formal and informative

Personas can be switched via the web dashboard and apply immediately to new conversations.

### Tracked Traders
Prapor, Therapist, Fence, Skier, Peacekeeper, Mechanic, Ragman, Jaeger, Ref

### Tarkov Time Calculation
- Uses 7x real-time ratio
- Russia timezone offset (+3 hours)
- Cultist spawn window: 22:00-07:00 in-game time

## Architecture

### Main Bot (`index.js`)
- Discord message handling and commands
- Twitch chat integration
- AI personality responses with Gemini
- AI image generation with rate limiting
- Tarkov API integrations
- Auto-join functionality
- Message memory system (5 messages per platform)

### Dashboard Server (`dashboard-server.js`)
- Express web server
- REST API endpoints for bot status
- Command logging system with live updates
- Persona switching functionality
- Cultist tracking state management
- Real-time Tarkov time calculations

### Personas (`personas.js`)
- Multiple AI personality definitions
- Customizable system prompts
- Platform-specific response guidelines

### Public Assets (`public/`)
- `dashboard.html` - Frontend interface with live updates

## API Endpoints

### Dashboard API

- `GET /` - Serves dashboard HTML
- `GET /api/cultist/status` - Returns current Cultist tracker state
- `POST /api/cultist/toggle` - Enable/disable Cultist notifications
- `GET /api/bot/status` - Returns bot uptime and system stats
- `GET /api/persona` - Get current bot persona
- `POST /api/persona` - Change bot persona (body: `{persona: "key"}`)
- `GET /api/commands` - Get command log history

## Image Generation

The bot uses Google's Gemini 2.5 Flash Image model ("nano banana") for AI image generation:

- **Trigger keywords:** generate, create, draw, make image/picture
- **Platform:** Discord only (no Twitch support)
- **Rate limiting:** 1 image per user per 60 seconds
- **File handling:** Temporary files stored in `/tmp` directory
- **Format:** PNG images

### Technical Implementation
- Uses Vercel AI SDK with Google provider
- Images returned in `result.files` array as `Uint8Array`
- Converted to Buffer and saved temporarily for Discord upload
- Automatic cleanup after sending

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
