# Birds-Server-AI-Bot

A multi-platform Discord and Twitch bot with Escape from Tarkov integration, AI personality, and real-time web dashboard.

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
- `@BotName` or `!patrick` - AI responses powered by "ThePatrick" persona

### 🤖 Auto-Features

- **Tangia Auto-Join** - Automatically joins dungeon/boss fights when TangiaBot announces them (1s delay)
- **Cultist Hunting Tracker** - Real-time Cultist spawn time monitoring with dual-server tracking

### 📊 Web Dashboard

A real-time web dashboard running on `http://localhost:3001` with:

- **Bot Status Monitor** - Uptime, memory usage, and health checks
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
- **Perplexity AI** (Sonar model) - AI personality responses

### APIs
- **tarkov.dev** - GraphQL queries for item prices, ammo stats, maps
- **eft-api.tech** - REST API for player statistics

### Dependencies
```json
{
  "@ai-sdk/perplexity": "^2.0.11",
  "ai": "^5.0.60",
  "discord.js": "^14.22.1",
  "dotenv": "^17.2.3",
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "tmi.js": "^1.8.5"
}
```

## Installation

### Prerequisites
- Node.js (v16 or higher)
- Discord Bot Token
- Twitch OAuth Token
- Perplexity API Key

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
   TWITCH_OAUTH=oauth:your_twitch_token
   TWITCH_CHANNEL=your_channel_name
   PERPLEXITY_API_KEY=your_perplexity_api_key
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
- AI personality responses
- Tarkov API integrations
- Auto-join functionality

### Dashboard Server (`dashboard-server.js`)
- Express web server
- REST API endpoints for bot status
- Cultist tracking state management
- Real-time Tarkov time calculations

### Public Assets (`public/`)
- `dashboard.html` - Frontend interface with live updates

## API Endpoints

### Dashboard API

- `GET /` - Serves dashboard HTML
- `GET /api/cultist/status` - Returns current Cultist tracker state
- `POST /api/cultist/toggle` - Enable/disable Cultist notifications
- `GET /api/bot/status` - Returns bot uptime and system stats

## Contributing

Feel free to submit issues or pull requests for improvements!

## License

See [LICENSE](LICENSE) file for details.

## Credits

Developed by BirdTruther for the Birds Server community.
