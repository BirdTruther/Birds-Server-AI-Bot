Bot Overview

Name: Birds-Server-AI-Bot
Platforms: Discord + Twitch
AI Personality: "ThePatrick" - a toxic gamer persona powered by Perplexity's Sonar model
Core Features
Tarkov Integration Commands

    !price [item] - Item prices with flea market & trader data

    !bestammo [caliber] - Best ammo by penetration power

    !trader - Trader reset times (EST timezone)

    !map [mapname] - Map info with boss spawns

    !player [name] - Player stats via EFT API (PMC/SCAV K/D, level)

General Commands

    !code / !github - Share GitHub repo link

    meme - Fetch random meme from meme-api.com

    @BotName or !patrick - AI responses

Auto-Features

    Tangia Auto-Join: Automatically joins dungeon/boss fights when TangiaBot announces them (1s delay)

Technical Stack

    Discord.js with Gateway intents for messages

    tmi.js for Twitch chat

    Perplexity AI (Sonar model) for conversational responses

    GraphQL queries to tarkov.dev API

    REST API calls to eft-api.tech for player stats

Key Configurations

    Twitch char limit: 480 (with smart chunking at sentence boundaries)

    Message delay: 1.5s between Twitch messages

    Tracked traders: Prapor, Therapist, Fence, Skier, Peacekeeper, Mechanic, Ragman, Jaeger, Ref

    Player level calculation using Tarkov's 79-level XP table
