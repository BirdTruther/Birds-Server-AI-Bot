Core AI Features

    Intelligent Conversations: Responds to mentions (@ThePatrick on Discord, @BotName or !patrick on Twitch) using Perplexity AI's Sonar model.

    Consistent Personality: Friendly, witty, 25-year-old gamer vibe with emojis, pop culture references, and casual lingo. Keeps responses under 2000 characters.

    Multi-Platform Support: Runs simultaneously on Discord and Twitch with platform-specific handling (e.g., shorter messages for Twitch chat).

Utility Commands

    Meme Generator: Type "meme" in either Discord or Twitch chat to receive a random meme image with title via Meme-API.

    Source Code Link: !code or !github in Twitch chat posts the GitHub repo: https://github.com/BirdTruther/Birds-Server-AI-Bot.

    Rate Limiting: Twitch responses are split into sentence-based chunks under 480 characters with 1.5-second delays to avoid spam warnings.

Game Automation

    Smart Triggering: Listens for TangiaBot messages containing "started a tangia dungeon" or "started a tangia boss fight" with "!join" mention, then delays 1 second before responding.

Technical Details

    Dependencies: discord.js (v14), tmi.js (Twitch), @ai-sdk/perplexity, ai, dotenv, node-fetch.

    Configuration: Uses .env for tokens (DISCORD_TOKEN, PERPLEXITY_TOKEN, TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, TWITCH_CHANNEL).

    Logging: Console logs all messages and actions for debugging.

    Safety: Ignores bot's own messages to prevent loops; handles errors gracefully.
