# Memory System Upgrade

## What Changed

Patrick's memory got a MAJOR upgrade! Instead of just remembering the last 5 messages (period), he now has a smart SQLite-based conversation memory system.

## Key Improvements

### 1. **SQLite-Based Storage** (`memory.js`)
- Conversations stored in database with timestamps
- Separate tracking per platform (Discord/Twitch) and channel
- Automatic cleanup of old messages (7+ days)
- Keeps last 1000 messages per channel

### 2. **Smart Context Selection**
- Only sends **last 8 messages** to AI (down from unlimited)
- Prioritizes recent user messages over bot responses
- Filters messages older than 24 hours
- **Reduced token usage** = lower API costs

### 3. **Less Tarkov-Obsessed Personas**
- All personas updated to be more general-purpose
- Still has gamer vibes but responds to ANY topic
- Won't force Tarkov references into unrelated conversations
- Personas now react to what you're ACTUALLY talking about

### 4. **Better Context Awareness**
- Bot remembers separate conversations per Discord channel
- Twitch chat has its own memory per stream
- Can track multiple simultaneous conversations
- Bot responses are also stored for continuity

## Configuration (in `memory.js`)

```javascript
const CONFIG = {
  MAX_CONTEXT_MESSAGES: 8,        // How many messages sent to AI
  USER_MESSAGE_WEIGHT: 2,         // Prioritize user messages
  RECENT_MESSAGES_COUNT: 5,       // Always include N most recent
  CLEANUP_AFTER_MESSAGES: 1000,   // Keep last N per channel
  MAX_MESSAGE_AGE_HOURS: 24       // Don't pull context older than this
};
```

## Before vs After

### Before:
- Simple array storing last 5 messages globally
- Lost on restart
- Same memory for all channels
- Unlimited context sent to AI
- Tarkov-obsessed responses

### After:
- SQLite database with indexed queries
- Persists across restarts
- Separate memory per channel
- Smart 8-message context selection
- General-purpose gamer personality

## Token Usage Reduction

With the old system sending potentially hundreds of messages as context, you could easily burn through API credits. The new system caps context at **8 recent messages**, dramatically reducing:

- API costs per request
- Response latency
- Chance of hitting token limits
- Redundant/irrelevant context

## How It Works

1. **User sends message** → Stored in `conversation_memory` table
2. **Bot needs context** → Queries last 8 relevant messages from that channel
3. **AI generates response** → Response also stored in memory
4. **Auto-cleanup** → Old messages (7+ days) deleted hourly

## Files Changed

- **NEW**: `memory.js` - Smart memory system module
- **UPDATED**: `index.js` - Integrated new memory system
- **UPDATED**: `personas.js` - Less Tarkov-focused, more general
- **UPDATED**: `database.js` - Now shared by logs AND memory

## Deployment

```bash
cd /home/birds/birds-server-ai-bot
git pull
sudo systemctl restart discordbot.service
```

The bot will automatically create the new `conversation_memory` table on startup!

---

**TL;DR**: Patrick now has a real memory system that's smarter, cheaper, and less annoying about Tarkov. 🎮🧠
