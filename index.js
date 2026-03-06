// BIRDS-SERVER-AI-BOT
// Discord + Twitch Multi-Platform Bot with AI & Tarkov Integration

// ===== DEPENDENCIES =====
const { Client, Events, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const tmi = require('tmi.js');
const { google } = require('@ai-sdk/google');
const { generateText } = require('ai');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { request, gql } = require('graphql-request');
const PERSONAS = require('./personas.js');
const { logCommand: dbLogCommand, logSystem } = require('./database.js');
const { addToMemory, getSmartContext, clearChannelMemory } = require('./memory.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CULTIST_ROLE_ID = '1459380427063038140';
require('dotenv').config();

// ===== SYSTEM LOGGING HELPER =====
function logSystemEvent(log_type, severity, component, message, error = null) {
  const logEntry = {
    log_type,
    severity,
    component,
    message,
    stack_trace: error ? error.stack : null,
    metadata: error ? {
      name: error.name,
      message: error.message,
      code: error.code
    } : null
  };
  
  logSystem(logEntry);
  
  // Also console log for immediate visibility
  const prefix = severity === 'ERROR' || severity === 'CRITICAL' ? '[ERROR]' : '[INFO]';
  console.log(`${prefix} [${component}] ${message}`);
}

// Log bot startup
logSystemEvent('STARTUP', 'INFO', 'system', `🚀 Bot starting up - Node ${process.version} on ${process.platform}`);
logSystemEvent('STARTUP', 'INFO', 'system', `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

// ===== PROCESS ERROR HANDLERS =====

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  logSystemEvent('CRASH', 'CRITICAL', 'system', `❌ Uncaught Exception: ${error.message}`, error);
  console.error('[FATAL] Uncaught exception, exiting...', error);
  process.exit(1);
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logSystemEvent('ERROR', 'ERROR', 'system', `❌ Unhandled Promise Rejection: ${error.message}`, error);
  console.error('[ERROR] Unhandled rejection:', error);
});

// Catch SIGTERM (graceful shutdown request)
process.on('SIGTERM', () => {
  logSystemEvent('SHUTDOWN', 'INFO', 'system', '📴 Received SIGTERM signal - shutting down gracefully');
  cleanup();
  process.exit(0);
});

// Catch SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  logSystemEvent('SHUTDOWN', 'INFO', 'system', '📴 Received SIGINT signal (Ctrl+C) - shutting down');
  cleanup();
  process.exit(0);
});

// Catch unexpected exit
process.on('exit', (code) => {
  if (code !== 0) {
    logSystemEvent('SHUTDOWN', 'WARNING', 'system', `❌ Process exiting with code ${code}`);
  } else {
    logSystemEvent('SHUTDOWN', 'INFO', 'system', '✅ Process exiting normally');
  }
});

// Cleanup function
function cleanup() {
  try {
    logSystemEvent('SHUTDOWN', 'INFO', 'system', '🧹 Cleaning up resources...');
    
    if (discordClient) {
      discordClient.destroy();
      logSystemEvent('SHUTDOWN', 'INFO', 'discord', 'Discord client disconnected');
    }
    
    if (twitchClient) {
      twitchClient.disconnect();
      logSystemEvent('SHUTDOWN', 'INFO', 'twitch', 'Twitch client disconnected');
    }
  } catch (error) {
    logSystemEvent('ERROR', 'ERROR', 'system', 'Error during cleanup', error);
  }
}

// ===== DASHBOARD LOGGING HELPER =====
function logCommand(platform, username, command, message, response = null, error = false, image_url = null) {
  const logEntry = {
    platform,
    username,
    command,
    message,
    response: response ? response.substring(0, 200) : null,
    error,
    image_url
  };
  
  // Log to SQLite database
  dbLogCommand(logEntry);
  
  // Also send to dashboard if available (for real-time updates)
  if (typeof global.dashboardLogCommand === 'function') {
    try {
      global.dashboardLogCommand(logEntry);
    } catch (err) {
      console.error('[LOG ERROR]', err);
      logSystemEvent('ERROR', 'WARNING', 'dashboard', 'Failed to send log to dashboard', err);
    }
  }
}

// ===== CONFIGURATION CONSTANTS =====
const CONFIG = {
    TWITCH_CHAR_LIMIT: 480,
    TWITCH_DELAY_MS: 1500,
    DUNGEON_AUTO_JOIN_DELAY: 1000,
    MAIN_TRADERS: ['Prapor', 'Therapist', 'Fence', 'Skier', 'Peacekeeper', 'Mechanic', 'Ragman', 'Jaeger', 'Ref'],
    EST_TIMEZONE: 'America/New_York',
    GITHUB_URL: 'https://github.com/BirdTruther/Birds-Server-AI-Bot',
    IMAGE_RATE_LIMIT_MS: 60000 // 1 minute cooldown per user
};

// Share cultist state with dashboard
let cultistState = {
  enabled: true,
  server1Active: false,
  server2Active: false,
  server1Time: '--:--'
};

// ===== IMAGE GENERATION RATE LIMITING =====
const imageRateLimits = new Map(); // Map<userId, lastRequestTimestamp>

function checkImageRateLimit(userId) {
    const now = Date.now();
    const lastRequest = imageRateLimits.get(userId);
    
    if (lastRequest && (now - lastRequest) < CONFIG.IMAGE_RATE_LIMIT_MS) {
        const timeLeft = Math.ceil((CONFIG.IMAGE_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
        return { allowed: false, timeLeft };
    }
    
    imageRateLimits.set(userId, now);
    return { allowed: true };
}

// ===== IMAGE GENERATION DETECTION =====
const IMAGE_KEYWORDS = [
    'generate',
    'create',
    'draw',
    'make image',
    'make picture',
    'make a image',
    'make a picture',
    'generate image',
    'generate picture',
    'create image',
    'create picture'
];

function detectImageRequest(message) {
    const lowerMessage = message.toLowerCase();
    return IMAGE_KEYWORDS.some(keyword => lowerMessage.includes(keyword));
}

function extractImagePrompt(message) {
    // Remove bot mention and clean up the prompt
    let prompt = message.replace(/<@!?\d+>/g, '').trim();
    
    // Remove common trigger words to get just the description
    const triggerPatterns = [
        /^(generate|create|draw|make)\s+(an?\s+)?(image|picture)\s+(of\s+)?/i,
        /^(generate|create|draw|make)\s+/i
    ];
    
    for (const pattern of triggerPatterns) {
        prompt = prompt.replace(pattern, '').trim();
    }
    
    return prompt || 'abstract art';
}

// ===== AI IMAGE GENERATION SERVICE =====
async function generateImage(prompt) {
    try {
        console.log(`[IMAGE] Generating image with prompt: ${prompt}`);
        console.log(`[IMAGE] Using model: gemini-2.5-flash-image`);
        
        const result = await generateText({
            model: google('gemini-2.5-flash-image'),
            prompt: prompt
        });
        
        console.log('[IMAGE] Result received');
        console.log('[IMAGE] Files in response:', result.files?.length || 0);
        
        // Images are returned in result.files array with uint8Array property
        if (result.files && result.files.length > 0) {
            for (const file of result.files) {
                if (file.mediaType && file.mediaType.startsWith('image/')) {
                    console.log('[IMAGE] Image found - Media type:', file.mediaType);
                    // Convert Uint8Array to Buffer
                    return Buffer.from(file.uint8Array);
                }
            }
        }
        
        throw new Error('No image data in response');
    } catch (error) {
        console.error('[IMAGE Error]', error);
        logSystemEvent('ERROR', 'ERROR', 'ai', `Image generation failed: ${error.message}`, error);
        throw error;
    }
}

// ===== AI SERVICE (Gemini 2.5 Flash) with Persona Support =====
function getCurrentPersona() {
    // Get current persona from dashboard
    if (typeof global.getBotPersona === 'function') {
        const personaKey = global.getBotPersona();
        return PERSONAS[personaKey] || PERSONAS.aggressive;
    }
    // Default to aggressive if dashboard not available
    return PERSONAS.aggressive;
}

async function getAIResponse(message, platform = 'discord', channelId = 'default', username = 'user') {
    try {
        // Get smart context from SQLite memory system
        const memoryContext = getSmartContext(platform, channelId);
        const currentPersona = getCurrentPersona();
        
        const platformNote = platform === 'twitch' 
            ? 'Twitch – under 400 chars. Short AF – chat scrolls fast.' 
            : 'Discord – can go a bit longer but still keep it punchy.';
        
        const systemPrompt = `${currentPersona.systemPrompt}

**Recent Conversation:**
${memoryContext}

**Platform:** ${platformNote}
**Current User:** ${username}`;
        
        console.log(`[AI] Using persona: ${currentPersona.name}`);
        console.log(`[AI] Context length: ${memoryContext.length} chars`);
        console.log(`[AI] Using model: gemini-2.5-flash`);
        
        const { text } = await generateText({
            model: google('gemini-2.5-flash'),
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: [{ type: 'text', text: message }]
                }
            ]
        });
        
        console.log('[AI Response]', text);
        
        // Store bot response in memory
        addToMemory(platform, channelId, 'ThePatrick', text, true);
        
        return text;
    } catch (error) {
        console.error('[AI Error]', error);
        logSystemEvent('ERROR', 'ERROR', 'ai', `AI response failed: ${error.message}`, error);
        return "Yo, my brain just glitched. Try again? 🤖";
    }
}

// ===== TARKOV API SERVICE =====

async function getTarkovPrice(itemName) {
    const query = gql`query { 
        itemsByName(name: "${itemName}") { 
            name shortName avg24hPrice 
            sellFor { price source } 
            properties { ... on ItemPropertiesAmmo { penetrationPower damage } } 
            link 
        } 
    }`;
    
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        if (data.itemsByName?.length > 0) {
            const item = data.itemsByName[0];
            const fleaPrice = item.avg24hPrice ? `₽${item.avg24hPrice.toLocaleString()}` : 'N/A';
            const traders = item.sellFor?.slice(0, 2).map(s => `${s.source}:₽${s.price.toLocaleString()}`).join(', ') || 'None';
            let stats = '';
            if (item.properties?.penetrationPower) stats = ` | PEN:${item.properties.penetrationPower} DMG:${item.properties.damage}`;
            const wikiLink = item.link ? ` | ${item.link}` : '';
            return `${item.shortName || item.name} | Flea:${fleaPrice} | Sell:${traders}${stats}${wikiLink}`;
        }
        return `No item found: ${itemName}`;
    } catch (error) {
        console.error('[Tarkov Price Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'tarkov', `Price lookup failed for ${itemName}`, error);
        return `Error fetching: ${itemName}`;
    }
}

async function getBestAmmo(searchCaliber) {
    const query = gql`query { 
        itemsByType(type: ammo) { 
            name 
            properties { ... on ItemPropertiesAmmo { penetrationPower damage caliber } } 
            avg24hPrice 
            sellFor { price source } 
        } 
    }`;
    
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        const ammoList = data.itemsByType?.filter(item => item.properties?.caliber) || [];
        const matchingAmmo = ammoList.filter(item => 
            item.name.toLowerCase().includes(searchCaliber.toLowerCase()) || 
            item.properties.caliber.toLowerCase().includes(searchCaliber.toLowerCase())
        );
        
        if (matchingAmmo.length > 0) {
            const bestAmmo = matchingAmmo.sort((a, b) => 
                (b.properties.penetrationPower || 0) - (a.properties.penetrationPower || 0)
            )[0];
            const fleaPrice = bestAmmo.avg24hPrice ? `₽${bestAmmo.avg24hPrice.toLocaleString()}` : 'N/A';
            const traderSource = bestAmmo.sellFor?.[0]?.source || 'Flea';
            const cleanTrader = traderSource === 'flea-market' ? 'Flea' : traderSource.replace(/-/g, ' L');
            return `${bestAmmo.name} | PEN:${bestAmmo.properties.penetrationPower} DMG:${bestAmmo.properties.damage} | ${fleaPrice} (${cleanTrader})`;
        }
        return `No ${searchCaliber} ammo found. Try partial names like "m995" or ".300"`;
    } catch (error) {
        console.error('[Best Ammo Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'tarkov', `Best ammo lookup failed for ${searchCaliber}`, error);
        return `Error: ${searchCaliber}`;
    }
}

async function getTraderResets() {
    const query = gql`query { traders { name resetTime } }`;
    
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        const mainTraders = data.traders.filter(t => CONFIG.MAIN_TRADERS.includes(t.name));
        const traderList = mainTraders.map(t => {
            if (!t.resetTime) return `${t.name}: Now`;
            const date = new Date(t.resetTime);
            const estTime = date.toLocaleString('en-US', { 
                timeZone: CONFIG.EST_TIMEZONE, 
                hour: '2-digit', minute: '2-digit', hour12: true 
            });
            return `${t.name}: ${estTime}`;
        }).join(', ');
        return `Traders: ${traderList}`;
    } catch (error) {
        console.error('[Trader Resets Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'tarkov', 'Trader resets lookup failed', error);
        return 'Error fetching traders';
    }
}

async function getMapInfo(mapName) {
    const query = gql`query { maps(name: "${mapName}") { name enemies } }`;
    
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        if (data.maps?.length > 0) {
            const map = data.maps[0];
            const bosses = map.enemies?.join(', ') || 'None';
            return `${map.name} | Bosses: ${bosses}`;
        }
        return `No map: ${mapName}`;
    } catch (error) {
        console.error('[Map Info Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'tarkov', `Map lookup failed for ${mapName}`, error);
        return `Error: ${mapName}`;
    }
}

async function getPlayerStats(playerName) {
    try {
        console.log(`[EFT] Searching player: ${playerName}`);

        const searchResponse = await fetch(`https://eft-api.tech/api/users/${encodeURIComponent(playerName)}`, {
            headers: { 'Authorization': `Bearer ${process.env.EFT_API_KEY}` }
        });

        console.log(`[EFT] /users status: ${searchResponse.status}`);

        let searchText = '';
        try {
            searchText = await searchResponse.text();
        } catch (e) {
            searchText = '<no body>';
        }

        let searchData = null;
        if (searchResponse.ok) {
            try {
                searchData = JSON.parse(searchText);
            } catch (e) {
                console.error('[EFT] /users JSON parse error', e);
                return `Error reading EFT response for: ${playerName}`;
            }
        }

        if (!searchResponse.ok) {
            if (searchResponse.status === 404) return `Player not found: ${playerName}`;
            if (searchResponse.status === 503) return `EFT API is unavailable or overloaded right now (503) while searching for: ${playerName}`;
            return `Error searching for: ${playerName} (HTTP ${searchResponse.status})`;
        }

        if (!searchData || !searchData.success || !searchData.data || searchData.data.length === 0) {
            return `Player not found: ${playerName}`;
        }

        const aid = searchData.data[0].aid;
        const nickname = searchData.data[0].Info.Nickname;

        console.log(`[EFT] Fetching stats for AID ${aid}`);

        const statsResponse = await fetch(`https://eft-api.tech/api/profile/stats/${aid}`, {
            headers: { 'Authorization': `Bearer ${process.env.EFT_API_KEY}` }
        });

        console.log(`[EFT] /profile/stats status: ${statsResponse.status}`);

        let statsText = '';
        try {
            statsText = await statsResponse.text();
        } catch (e) {
            statsText = '<no body>';
        }

        let statsData = null;
        if (statsResponse.ok) {
            try {
                statsData = JSON.parse(statsText);
            } catch (e) {
                console.error('[EFT] /profile/stats JSON parse error', e);
                return `Error reading stats for: ${nickname}`;
            }
        }

        if (!statsResponse.ok) {
            if (statsResponse.status === 503) {
                return `EFT API is unavailable or overloaded right now (503) when fetching stats for: ${nickname}`;
            }
            return `Error fetching stats for: ${nickname} (HTTP ${statsResponse.status})`;
        }

        const data = statsData.data;

        console.log(`[EFT] Fetching profile for AID ${aid}`);

        const profileResponse = await fetch(`https://eft-api.tech/api/profile/${aid}`, {
            headers: { 'Authorization': `Bearer ${process.env.EFT_API_KEY}` }
        });

        console.log(`[EFT] /profile status: ${profileResponse.status}`);

        let profileText = '';
        try {
            profileText = await profileResponse.text();
        } catch (e) {
            profileText = '<no body>';
        }

        let profile = null;
        if (profileResponse.ok) {
            try {
                profile = JSON.parse(profileText);
            } catch (e) {
                console.error('[EFT] /profile JSON parse error', e);
            }
        } else if (profileResponse.status === 503) {
            console.warn('[EFT] Profile endpoint 503; falling back to stats data only');
        }

        const experience = profile?.data?.info?.experience || data.experience || 0;
        const level = calculateLevel(experience);

        const pmcKills = data.pmc?.kills || 0;
        const pmcDeaths = data.pmc?.deaths || 0;
        const pmcKD = pmcDeaths > 0 ? (pmcKills / pmcDeaths).toFixed(2) : pmcKills.toFixed(2);

        const scavKills = data.scav?.kills || 0;
        const scavDeaths = data.scav?.deaths || 0;
        const scavKD = scavDeaths > 0 ? (scavKills / scavDeaths).toFixed(2) : scavKills.toFixed(2);

        const profileUrl = `https://eft-api.tech/profile?aid=${aid}`;

        return `${nickname} | Lvl:${level} | PMC K/D:${pmcKD} | SCAV K/D:${scavKD} | ${profileUrl}`;
    } catch (error) {
        console.error('[Player Stats Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'tarkov', `Player stats lookup failed for ${playerName}`, error);
        return `Error fetching player: ${playerName}`;
    }
}

function calculateLevel(xp) {
    const levels = [
        0, 1000, 4017, 8432, 14256, 21477, 30023, 39936, 51204, 63723, 77563,
        93279, 115302, 143253, 177337, 217885, 264432, 316851, 374400, 437465,
        505161, 577978, 656347, 741150, 836066, 944133, 1066259, 1199423, 1343743,
        1499338, 1666320, 1846664, 2043349, 2258436, 2492126, 2750217, 3032022,
        3337766, 3663831, 4010401, 4377662, 4765799, 5182399, 5627732, 6102063,
        6630287, 7189442, 7779792, 8401607, 9055144, 9740666, 10458431, 11219666,
        12024744, 12874041, 13767918, 14706741, 15690872, 16720667, 17816442,
        19041492, 20360945, 21792266, 23350443, 25098462, 27100775, 29581231,
        33028574, 37953544, 44260543, 51901513, 60887711, 71228846, 82933459,
        96009180, 110462910, 126300949, 144924572, 172016256
    ];
    
    for (let i = levels.length - 1; i >= 0; i--) {
        if (xp >= levels[i]) return i + 1;
    }
    return 1;
}

function getCurrentTarkovTime() {
    const oneDay = 24 * 60 * 60 * 1000;
    const russia = 3 * 60 * 60 * 1000;
    const tarkovRatio = 7;
    const now = Date.now();
    const tarkovTime = (russia + (now * tarkovRatio)) % oneDay;
    const totalMinutes = Math.floor(tarkovTime / (60 * 1000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return { hours, minutes };
}

function isCultistTime(hour) {
    return hour >= 22 || hour < 7;
}

async function fetchMeme() {
    try {
        const response = await fetch('https://meme-api.com/gimme');
        const data = await response.json();
        if (data?.url) return { title: data.title, url: data.url };
        return null;
    } catch (error) {
        console.error('[Meme Fetch Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'meme', 'Meme fetch failed', error);
        return null;
    }
}

// ===== TWITCH UTILITIES =====
async function sendTwitchMessage(channel, text, delayMs = CONFIG.TWITCH_DELAY_MS) {
    return new Promise((resolve) => {
        twitchClient.say(channel, text);
        setTimeout(resolve, delayMs);
    });
}

async function sendTwitchChunked(channel, text) {
    if (text.length <= CONFIG.TWITCH_CHAR_LIMIT) {
        twitchClient.say(channel, text);
        return;
    }
    
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > CONFIG.TWITCH_CHAR_LIMIT) {
            if (currentChunk) await sendTwitchMessage(channel, currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }
    
    if (currentChunk) await sendTwitchMessage(channel, currentChunk.trim());
}

// ===== TWITCH CLIENT SETUP =====
const twitchClient = new tmi.Client({
    options: { debug: true },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_OAUTH_TOKEN
    },
    channels: [process.env.TWITCH_CHANNEL]
});

twitchClient.connect().catch((error) => {
    console.error('[TWITCH CONNECTION ERROR]', error);
    logSystemEvent('CONNECTION', 'ERROR', 'twitch', 'Failed to connect to Twitch', error);
});

twitchClient.on('connected', (address, port) => {
    console.log(`✅ Connected to Twitch at ${address}:${port}`);
    logSystemEvent('CONNECTION', 'INFO', 'twitch', `✅ Connected to Twitch at ${address}:${port}`);
});

twitchClient.on('disconnected', (reason) => {
    console.log(`❌ Twitch disconnected: ${reason}`);
    logSystemEvent('CONNECTION', 'WARNING', 'twitch', `❌ Twitch disconnected: ${reason}`);
});

// ===== TWITCH MESSAGE HANDLER =====
twitchClient.on('message', async (channel, tags, message, self) => {
    if (self) return;
    
    console.log(`[TWITCH] ${tags.username}: ${message}`);
    // Store in memory with channel as channelId
    addToMemory('twitch', channel, tags.username, message);
    
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('!code') || lowerMessage.includes('!github')) {
        const response = `Check out my code! 🤖 ${CONFIG.GITHUB_URL}`;
        twitchClient.say(channel, response);
        logCommand('twitch', tags.username, '!code', message, response);
        return;
    }
    
    if (lowerMessage.startsWith('!price ')) {
        const itemName = message.substring(7);
        const result = await getTarkovPrice(itemName);
        twitchClient.say(channel, result);
        logCommand('twitch', tags.username, '!price', itemName, result);
        return;
    }
    
    if (lowerMessage.startsWith('!bestammo ')) {
        const searchCaliber = message.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        twitchClient.say(channel, result);
        logCommand('twitch', tags.username, '!bestammo', searchCaliber, result);
        return;
    }
    
    if (lowerMessage === '!trader') {
        const result = await getTraderResets();
        twitchClient.say(channel, result);
        logCommand('twitch', tags.username, '!trader', message, result);
        return;
    }
    
    if (lowerMessage.startsWith('!map ')) {
        const mapName = message.substring(5);
        const result = await getMapInfo(mapName);
        twitchClient.say(channel, result);
        logCommand('twitch', tags.username, '!map', mapName, result);
        return;
    }

    if (lowerMessage.startsWith('!player ')) {
        const playerName = message.substring(8).trim();
        const result = await getPlayerStats(playerName);
        twitchClient.say(channel, result);
        logCommand('twitch', tags.username, '!player', playerName, result);
        return;
    }

    if (tags.username.toLowerCase() === 'tangiabot' && 
        (lowerMessage.includes('started a tangia dungeon') || 
         lowerMessage.includes('started a tangia boss fight')) && 
        lowerMessage.includes('!join')) {
        setTimeout(() => {
            twitchClient.say(channel, '!join');
            console.log('[DUNGEON/BOSS] Auto-joined!');
            logCommand('twitch', 'BOT', 'auto-join', 'Tangia event detected', '!join');
        }, CONFIG.DUNGEON_AUTO_JOIN_DELAY);
        return;
    }
    
    if (lowerMessage.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            twitchClient.say(channel, `${meme.title} ${meme.url}`);
            logCommand('twitch', tags.username, 'meme', message, meme.title);
        } else {
            const errorMsg = 'Could not fetch a meme right now. Try again later.';
            twitchClient.say(channel, errorMsg);
            logCommand('twitch', tags.username, 'meme', message, errorMsg, true);
        }
        return;
    }
    
    if (lowerMessage.includes('@' + process.env.TWITCH_BOT_USERNAME.toLowerCase()) || 
        lowerMessage.startsWith('!patrick')) {
        const response = await getAIResponse(message, 'twitch', channel, tags.username);
        await sendTwitchChunked(channel, response);
        logCommand('twitch', tags.username, '@mention', message, response);
    }
});

// ===== DISCORD CLIENT SETUP =====
const discordClient = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

discordClient.on('ready', (readyClient) => {
    console.log(`✅ Discord logged in as ${readyClient.user.tag}`);
    logSystemEvent('CONNECTION', 'INFO', 'discord', `✅ Discord logged in as ${readyClient.user.tag}`);
});

discordClient.on('error', (error) => {
    console.error('[DISCORD ERROR]', error);
    logSystemEvent('ERROR', 'ERROR', 'discord', 'Discord client error', error);
});

discordClient.on('shardDisconnect', (event) => {
    console.log(`❌ Discord disconnected: ${event.reason || 'Unknown'}`);
    logSystemEvent('CONNECTION', 'WARNING', 'discord', `❌ Discord disconnected: ${event.reason || 'Unknown'}`);
});

discordClient.on('shardReconnecting', () => {
    console.log('🔄 Discord reconnecting...');
    logSystemEvent('CONNECTION', 'INFO', 'discord', '🔄 Discord reconnecting...');
});

// ===== DISCORD MESSAGE HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    
    console.log(`[DISCORD] ${message.author.username}: ${message.content}`);
    // Store in memory with channel ID
    addToMemory('discord', message.channelId, message.author.username, message.content);
    
    const lowerContent = message.content.toLowerCase();
    
    if (lowerContent.startsWith('!price ')) {
        const itemName = message.content.substring(7);
        const result = await getTarkovPrice(itemName);
        message.reply(result);
        logCommand('discord', message.author.username, '!price', itemName, result);
        return;
    }
    
    if (lowerContent.startsWith('!bestammo ')) {
        const searchCaliber = message.content.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        message.reply(result);
        logCommand('discord', message.author.username, '!bestammo', searchCaliber, result);
        return;
    }
    
    if (lowerContent === '!trader') {
        const result = await getTraderResets();
        message.reply(result);
        logCommand('discord', message.author.username, '!trader', message.content, result);
        return;
    }
    
    if (lowerContent.startsWith('!map ')) {
        const mapName = message.content.substring(5);
        const result = await getMapInfo(mapName);
        message.reply(result);
        logCommand('discord', message.author.username, '!map', mapName, result);
        return;
    }

    if (lowerContent.startsWith('!player ')) {
        const playerName = message.content.substring(8).trim();
        const result = await getPlayerStats(playerName);
        message.reply(result);
        logCommand('discord', message.author.username, '!player', playerName, result);
        return;
    }

    if (lowerContent.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            await message.channel.send({ content: meme.title, files: [meme.url] });
            logCommand('discord', message.author.username, 'meme', message.content, meme.title);
        } else {
            const errorMsg = 'Could not fetch a meme right now. Try again later.';
            await message.channel.send(errorMsg);
            logCommand('discord', message.author.username, 'meme', message.content, errorMsg, true);
        }
        return;
    }
    
    // Handle @mentions - check for image generation keywords
    if (message.content.includes(`<@${discordClient.user.id}>`)) {
        // Check if this is an image generation request
        if (detectImageRequest(message.content)) {
            // Check rate limit
            const rateLimit = checkImageRateLimit(message.author.id);
            if (!rateLimit.allowed) {
                const currentPersona = getCurrentPersona();
                const rateLimitMsg = currentPersona.name === 'Aggressive/Mean' 
                    ? `Whoa there, slow down! You're generating images too fast. Chill for ${rateLimit.timeLeft} more seconds. 😤`
                    : `Hey! You need to wait ${rateLimit.timeLeft} more seconds before generating another image. 🎨⏰`;
                await message.reply(rateLimitMsg);
                logCommand('discord', message.author.username, 'image-rate-limit', message.content, rateLimitMsg);
                return;
            }
            
            // Generate image
            try {
                await message.channel.sendTyping();
                console.log('[IMAGE] Processing image request from Discord');
                
                const prompt = extractImagePrompt(message.content);
                const imageData = await generateImage(prompt);
                
                // Use system temp directory for file storage
                const timestamp = Date.now();
                const filename = `generated_${timestamp}.png`;
                const filepath = path.join(os.tmpdir(), filename);
                
                console.log('[IMAGE] Saving to temp file:', filepath);
                
                // Write Buffer directly to file
                fs.writeFileSync(filepath, imageData);
                
                // Send the file and capture the Discord CDN URL
                const sentMessage = await message.reply({ 
                    content: `Here's your image for: "${prompt}" 🎨`,
                    files: [filepath]
                });
                
                // Extract Discord CDN link from the sent message
                let imageUrl = null;
                if (sentMessage.attachments.size > 0) {
                    const attachment = sentMessage.attachments.first();
                    imageUrl = attachment.url;
                    console.log('[IMAGE] Discord CDN URL:', imageUrl);
                }
                
                // Clean up the temp file
                fs.unlinkSync(filepath);
                console.log('[IMAGE] Temp file cleaned up');
                
                // Log with Discord CDN link
                logCommand('discord', message.author.username, 'image-gen', prompt, `Image generated: ${imageUrl || 'URL not captured'}`, false, imageUrl);
            } catch (error) {
                console.error('[IMAGE] Error generating image:', error);
                logSystemEvent('ERROR', 'ERROR', 'discord', 'Image generation failed', error);
                const errorMsg = "Yo, something broke while making your image. Try again? 🤖💥";
                await message.reply(errorMsg);
                logCommand('discord', message.author.username, 'image-gen-error', message.content, errorMsg, true);
            }
        } else {
            // Regular text chat response
            const response = await getAIResponse(message.content, 'discord', message.channelId, message.author.username);
            await message.reply(response);
            logCommand('discord', message.author.username, '@mention', message.content, response);
        }
    }
});

// ===== REPLY-TO-BOT HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.reference) return;
    
    try {
        const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedTo.author.id !== discordClient.user.id) return;
        
        console.log(`[REPLY-TO-BOT] ${message.author.username}: ${message.content}`);
        addToMemory('discord', message.channelId, message.author.username, message.content);
        
        const lowerContent = message.content.toLowerCase();
        
        // Handle commands in replies
        if (lowerContent.startsWith('!price ')) {
            const itemName = message.content.substring(7);
            const result = await getTarkovPrice(itemName);
            message.reply(result);
            logCommand('discord', message.author.username, '!price-reply', itemName, result);
            return;
        }
        
        if (lowerContent.startsWith('!bestammo ')) {
            const searchCaliber = message.content.substring(10).trim();
            const result = await getBestAmmo(searchCaliber);
            message.reply(result);
            logCommand('discord', message.author.username, '!bestammo-reply', searchCaliber, result);
            return;
        }
        
        if (lowerContent === '!trader') {
            const result = await getTraderResets();
            message.reply(result);
            logCommand('discord', message.author.username, '!trader-reply', message.content, result);
            return;
        }
        
        if (lowerContent.startsWith('!map ')) {
            const mapName = message.content.substring(5);
            const result = await getMapInfo(mapName);
            message.reply(result);
            logCommand('discord', message.author.username, '!map-reply', mapName, result);
            return;
        }
        
        if (lowerContent.startsWith('!player ')) {
            const playerName = message.content.substring(8).trim();
            const result = await getPlayerStats(playerName);
            message.reply(result);
            logCommand('discord', message.author.username, '!player-reply', playerName, result);
            return;
        }
        
        // AI response for non-commands
        const response = await getAIResponse(message.content, 'discord', message.channelId, message.author.username);
        message.reply(response);
        logCommand('discord', message.author.username, 'reply-to-bot', message.content, response);
    } catch (error) {
        console.error('[REPLY ERROR]', error);
        logSystemEvent('ERROR', 'WARNING', 'discord', 'Reply handler error', error);
    }
});

// ===== CULTIST MONITORING SYSTEM =====
const CULTIST_CONFIG = {
    CHANNEL_ID: '1001340004259352678',
    CHECK_INTERVAL_MS: 300000
};

let lastCultistStates = {
    server1: { active: false },
    server2: { active: false }
};

async function checkCultistActivity() {
  // Only run if dashboard says it's enabled
  if (!cultistState.enabled) {
    console.log('[CULTIST] Monitoring disabled by dashboard');
    return;
  }
    try {
    const channel = discordClient.channels.cache.get(CULTIST_CONFIG.CHANNEL_ID);
    
    if (!channel) {
      console.error('[CULTIST] Channel not found!');
      return;
    }     
        const { hours: server1Hours, minutes: server1Minutes } = getCurrentTarkovTime();
        const server1Time = `${server1Hours.toString().padStart(2, '0')}:${server1Minutes.toString().padStart(2, '0')}`;
        const server1Active = isCultistTime(server1Hours);
        
        const server2Hours = (server1Hours + 12) % 24;
        const server2Time = `${server2Hours.toString().padStart(2, '0')}:${server1Minutes.toString().padStart(2, '0')}`;
        const server2Active = isCultistTime(server2Hours);
        
        // Check Server Instance 1
        if (server1Active && !lastCultistStates.server1.active) {
            channel.send(`<@&${CULTIST_ROLE_ID}> 🌙 **Cultists are now active! (Server 1)** In-game time: ${server1Time}`);
            lastCultistStates.server1.active = true;
            console.log(`[CULTIST] Server 1 active at ${server1Time}`);
        } else if (!server1Active && lastCultistStates.server1.active) {
            channel.send(`<@&${CULTIST_ROLE_ID}> ☀️ **Cultists despawned. (Server 1)** In-game time: ${server1Time}`);
            lastCultistStates.server1.active = false;
            console.log(`[CULTIST] Server 1 inactive at ${server1Time}`);
        }
        
        if (server2Active && !lastCultistStates.server2.active) {
            channel.send(`<@&${CULTIST_ROLE_ID}> 🌙 **Cultists are now active! (Server 2)** In-game time: ${server2Time}`);
            lastCultistStates.server2.active = true;
            console.log(`[CULTIST] Server 2 active at ${server2Time}`);
        } else if (!server2Active && lastCultistStates.server2.active) {
            channel.send(`<@&${CULTIST_ROLE_ID}> ☀️ **Cultists despawned. (Server 2)** In-game time: ${server2Time}`);
            lastCultistStates.server2.active = false;
            console.log(`[CULTIST] Server 2 inactive at ${server2Time}`);
        }
        
        console.log(`[CULTIST] Check - S1:${server1Time}(${server1Active}) S2:${server2Time}(${server2Active})`);
    } catch (error) {
        console.error('[CULTIST] Monitoring error:', error);
        logSystemEvent('ERROR', 'WARNING', 'cultist', 'Cultist monitoring error', error);
    }
}

discordClient.once('ready', () => {
    console.log('[CULTIST] Starting monitoring system...');
    logSystemEvent('STARTUP', 'INFO', 'cultist', 'Cultist monitoring system started');
    checkCultistActivity();
    setInterval(checkCultistActivity, CULTIST_CONFIG.CHECK_INTERVAL_MS);
    console.log(`[CULTIST] Monitoring every ${CULTIST_CONFIG.CHECK_INTERVAL_MS / 60000} minutes`);
});

// ===== START DISCORD CLIENT =====
discordClient.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('[DISCORD LOGIN ERROR]', error);
    logSystemEvent('CONNECTION', 'CRITICAL', 'discord', 'Discord login failed', error);
    process.exit(1);
});

// Log successful startup after short delay
setTimeout(() => {
    logSystemEvent('STARTUP', 'INFO', 'system', '✅ Bot fully initialized and running');
}, 5000);
