// ============================================================================
// BIRDS-SERVER-AI-BOT - Optimized Single-File Version
// Discord + Twitch Multi-Platform Bot with AI & Tarkov Integration
// ============================================================================

// ===== DEPENDENCIES =====
const { Client, Events, GatewayIntentBits } = require('discord.js');
const tmi = require('tmi.js');
const { createPerplexity } = require('@ai-sdk/perplexity');
const { generateText } = require('ai');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { request, gql } = require('graphql-request');
const axios = require('axios');
require('dotenv').config();

// ===== CONFIGURATION CONSTANTS =====
const CONFIG = {
    TWITCH_CHAR_LIMIT: 480,
    TWITCH_DELAY_MS: 1500,
    DUNGEON_AUTO_JOIN_DELAY: 1000,
    MAIN_TRADERS: ['Prapor', 'Therapist', 'Fence', 'Skier', 'Peacekeeper', 'Mechanic', 'Ragman', 'Jaeger', 'Ref'],
    EST_TIMEZONE: 'America/New_York',
    GITHUB_URL: 'https://github.com/BirdTruther/Birds-Server-AI-Bot'
};

// ===== MESSAGE MEMORY SYSTEM =====
// Keep last 5 messages per platform for context
const messageHistory = {
    discord: [],
    twitch: []
};

const MAX_MEMORY = 5;

function addMessageToMemory(platform, username, content) {
    const history = messageHistory[platform];
    
    history.push({
        username,
        content,
        timestamp: new Date()
    });
    
    // Keep only last MAX_MEMORY messages
    if (history.length > MAX_MEMORY) {
        history.shift();
    }
}

function getMemoryContext(platform) {
    const history = messageHistory[platform];
    
    if (history.length === 0) {
        return 'No previous messages in this conversation.';
    }
    
    return history.map(msg => `${msg.username}: ${msg.content}`).join('\n');
}

function clearMemory(platform) {
    messageHistory[platform] = [];
    console.log(`[MEMORY] Cleared ${platform} conversation history`);
}

// ===== AI SERVICE (Perplexity) =====
const perplexity = createPerplexity({
    apiKey: process.env.PERPLEXITY_TOKEN
});

// Generate AI response with ThePatrick personality
async function getAIResponse(message, platform = 'discord', username = 'user') {
    try {
        const memoryContext = getMemoryContext(platform);
        
        const { text } = await generateText({
            model: perplexity('sonar'),
            messages: [
                {
                    role: "system",
                    content: `
                    Your name is ThePatrick. 25yo toxic gamer asshole who's been flaming noobs in this Discord for years.
                    
                    **CONVERSATION CONTEXT (Last 5 messages):**
                    ${memoryContext}
                    
                    **Platform:** ${platform === 'twitch' ? 'Twitch – under 400 chars. Short AF – chat scrolls fast.' : 'Discord – can go a bit longer but still keep it punchy.'}
                    
                    Style:
                    - Cuss like a sailor, heavy sarcasm, sweaty gamer energy
                    - "Git gud," "bro you're trash," ego checks, KD flexes
                    - Use edgy humor without slurs or hate speech
                    - Emojis for savage energy 💀🤡😂🔥😤
                    - **BOLD** burns, *italics* fake sympathy
                    - Short. Punchy. No essays.
                    - Flex wins, clown bad plays, hype clutch moments
                    
                    Examples:
                    - "Mic check? Sounds like your $20 Walmart headset finally gave up 💀"
                    - "K/D ratio? Looks like a warmup bot took your spot 😂"
                    - "Voice chat broke? **Unplug your toaster PC** and try again, champ 😤"
                    - "LFG? Only if you don't grief the squad like last match 🤡"
                    - "That build? Looks like you let an AI pick perks for you. *Tragic.*"
                    
                    Triggers:
                    - Setup questions → hardware/skill roasts + quick tip
                    - Game complaints → "git gud" style reply + light insult
                    - Brags → counter-flex harder but still playful
                    - Help requests → sarcastic fix + one burn, then a real answer
                    
                    Rules:
                    - No slurs, hate speech, or real-world harassment
                    - No sexual content or targeting people's families
                    - Don't be nice or robotic, but stay playful and entertainment-focused
                    - Never self-@, never use [citations], never write long walls of text
                    
                    Be the toxic voice chat goblin everyone complains about, but secretly keeps around because you're funny and clutch.
                    `
                },
                {
                    role: "user",
                    content: [{
                        type: 'text',
                        text: message,
                    }]
                }
            ]
        });
        console.log('[AI Response]', text);
        return text;
    } catch (error) {
        console.error('[AI Error]', error);
        return "Yo, my brain just glitched. Try again? 🤖";
    }
}

// ===== TARKOV API SERVICE (Shared Functions) =====

// Get item price from Tarkov API
async function getTarkovPrice(itemName) {
    const query = gql`query { 
        itemsByName(name: "${itemName}") { 
            name 
            shortName 
            avg24hPrice 
            sellFor { price source } 
            properties { 
                ... on ItemPropertiesAmmo { 
                    penetrationPower 
                    damage 
                } 
            } 
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
            if (item.properties?.penetrationPower) {
                stats = ` | PEN:${item.properties.penetrationPower} DMG:${item.properties.damage}`;
            }
            // Add wiki link to the response
            const wikiLink = item.link ? ` | ${item.link}` : '';
            return `${item.shortName || item.name} | Flea:${fleaPrice} | Sell:${traders}${stats}${wikiLink}`;
        }
        return `No item found: ${itemName}`;
    } catch (error) {
        console.error('[Tarkov Price Error]', error);
        return `Error fetching: ${itemName}`;
    }
}

// Get best ammo by caliber from Tarkov API
async function getBestAmmo(searchCaliber) {
    const query = gql`query { 
        itemsByType(type: ammo) { 
            name 
            properties { 
                ... on ItemPropertiesAmmo { 
                    penetrationPower 
                    damage 
                    caliber 
                } 
            } 
            avg24hPrice 
            sellFor { price source } 
        } 
    }`;
    
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        const ammoList = data.itemsByType?.filter(item => item.properties?.caliber) || [];
        
        // AUTO-FILTER: Find ANY ammo containing search term in name OR caliber
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
        return `Error: ${searchCaliber}`;
    }
}

// Get trader reset times
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
                hour: '2-digit', 
                minute: '2-digit', 
                hour12: true 
            });
            return `${t.name}: ${estTime}`;
        }).join(', ');
        return `Traders: ${traderList}`;
    } catch (error) {
        console.error('[Trader Resets Error]', error);
        return 'Error fetching traders';
    }
}

// Get map info
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
        return `Error: ${mapName}`;
    }
}

// Get Player Stats
async function getPlayerStats(playerName) {
    try {
        console.log(`[EFT] Searching player: ${playerName}`);

        const searchResponse = await fetch(`https://eft-api.tech/api/users/${encodeURIComponent(playerName)}`, {
            headers: { 
                'Authorization': `Bearer ${process.env.EFT_API_KEY}`
            }
        });

        console.log(`[EFT] /users status: ${searchResponse.status}`);

        let searchText;
        try {
            searchText = await searchResponse.text();
        } catch (e) {
            searchText = '<no body>';
        }
        console.log(`[EFT] /users body: ${searchText.slice(0, 300)}`);

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

        // ===== STATS REQUEST =====
        console.log(`[EFT] Fetching stats for AID ${aid}`);

        const statsResponse = await fetch(`https://eft-api.tech/api/profile/stats/${aid}`, {
            headers: { 
                'Authorization': `Bearer ${process.env.EFT_API_KEY}`
            }
        });

        console.log(`[EFT] /profile/stats status: ${statsResponse.status}`);

        let statsText;
        try {
            statsText = await statsResponse.text();
        } catch (e) {
            statsText = '<no body>';
        }
        console.log(`[EFT] /profile/stats body: ${statsText.slice(0, 300)}`);

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

        // ===== PROFILE REQUEST =====
        console.log(`[EFT] Fetching profile for AID ${aid}`);

        const profileResponse = await fetch(`https://eft-api.tech/api/profile/${aid}`, {
            headers: { 
                'Authorization': `Bearer ${process.env.EFT_API_KEY}`
            }
        });

        console.log(`[EFT] /profile status: ${profileResponse.status}`);

        let profileText;
        try {
            profileText = await profileResponse.text();
        } catch (e) {
            profileText = '<no body>';
        }
        console.log(`[EFT] /profile body: ${profileText.slice(0, 300)}`);

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

        const experience =
            profile?.data?.info?.experience ||
            data.experience ||
            0;

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
        return `Error fetching player: ${playerName}`;
    }
}

// Calculate Tarkov level from experience points
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
        if (xp >= levels[i]) {
            return i + 1;
        }
    }
    
    return 1;
}

// Get map data from tarkov.dev API
async function getMapTimes() {
    const query = gql`{
        maps {
            name
            normalizedName
            enemies
            raidDuration
        }
    }`;
    
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        return data.maps || [];
    } catch (error) {
        console.error('[Map Times Error]', error);
        return [];
    }
}

// Calculate current Tarkov in-game time (7:1 speed ratio)
function getCurrentTarkovTime() {
    const realSeconds = Date.now() / 1000;
    const tarkovSeconds = realSeconds * 7;
    const tarkovMinutes = (tarkovSeconds / 60) % 1440;
    const hours = Math.floor(tarkovMinutes / 60);
    const minutes = Math.floor(tarkovMinutes % 60);
    return { hours, minutes };
}

// Check if time is in cultist active range (22:00-07:00)
function isCultistTime(hour) {
    return hour >= 22 || hour < 7;
}

// ===== MEME SERVICE =====
async function fetchMeme() {
    try {
        const response = await fetch('https://meme-api.com/gimme');
        const data = await response.json();
        if (data?.url) {
            return { title: data.title, url: data.url };
        }
        return null;
    } catch (error) {
        console.error('[Meme Fetch Error]', error);
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

// Split long messages for Twitch's character limit
async function sendTwitchChunked(channel, text) {
    if (text.length <= CONFIG.TWITCH_CHAR_LIMIT) {
        twitchClient.say(channel, text);
        return;
    }
    
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > CONFIG.TWITCH_CHAR_LIMIT) {
            if (currentChunk) {
                await sendTwitchMessage(channel, currentChunk.trim());
            }
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }
    
    if (currentChunk) {
        await sendTwitchMessage(channel, currentChunk.trim());
    }
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

twitchClient.connect().catch(console.error);

twitchClient.on('connected', (address, port) => {
    console.log(`✅ Connected to Twitch at ${address}:${port}`);
});

// ===== TWITCH MESSAGE HANDLER =====
twitchClient.on('message', async (channel, tags, message, self) => {
    if (self) return;
    
    console.log(`[TWITCH] ${tags.username}: ${message}`);
    addMessageToMemory('twitch', tags.username, message);
    
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('!code') || lowerMessage.includes('!github')) {
        twitchClient.say(channel, `Check out my code! 🤖 ${CONFIG.GITHUB_URL}`);
        return;
    }
    
    if (lowerMessage.startsWith('!price ')) {
        const itemName = message.substring(7);
        const result = await getTarkovPrice(itemName);
        twitchClient.say(channel, result);
        return;
    }
    
    if (lowerMessage.startsWith('!bestammo ')) {
        const searchCaliber = message.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        twitchClient.say(channel, result);
        return;
    }
    
    if (lowerMessage === '!trader') {
        const result = await getTraderResets();
        twitchClient.say(channel, result);
        return;
    }
    
    if (lowerMessage.startsWith('!map ')) {
        const mapName = message.substring(5);
        const result = await getMapInfo(mapName);
        twitchClient.say(channel, result);
        return;
    }

    if (lowerMessage.startsWith('!player ')) {
        const playerName = message.substring(8).trim();
        const result = await getPlayerStats(playerName);
        twitchClient.say(channel, result);
        return;
    }

    if (tags.username.toLowerCase() === 'tangiabot' && 
        (lowerMessage.includes('started a tangia dungeon') || 
         lowerMessage.includes('started a tangia boss fight')) && 
        lowerMessage.includes('!join')) {
        setTimeout(() => {
            twitchClient.say(channel, '!join');
            console.log('[DUNGEON/BOSS] Auto-joined!');
        }, CONFIG.DUNGEON_AUTO_JOIN_DELAY);
        return;
    }
    
    if (lowerMessage.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            twitchClient.say(channel, `${meme.title} ${meme.url}`);
        } else {
            twitchClient.say(channel, 'Could not fetch a meme right now. Try again later.');
        }
        return;
    }
    
    if (lowerMessage.includes('@' + process.env.TWITCH_BOT_USERNAME.toLowerCase()) || 
        lowerMessage.startsWith('!patrick')) {
        const response = await getAIResponse(message, 'twitch', tags.username);
        await sendTwitchChunked(channel, response);
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
});

// ===== DISCORD MESSAGE HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    
    console.log(`[DISCORD] ${message.author.username}: ${message.content}`);
    addMessageToMemory('discord', message.author.username, message.content);
    
    const lowerContent = message.content.toLowerCase();
    
    if (lowerContent.startsWith('!price ')) {
        const itemName = message.content.substring(7);
        const result = await getTarkovPrice(itemName);
        message.reply(result);
        return;
    }
    
    if (lowerContent.startsWith('!bestammo ')) {
        const searchCaliber = message.content.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        message.reply(result);
        return;
    }
    
    if (lowerContent === '!trader') {
        const result = await getTraderResets();
        message.reply(result);
        return;
    }
    
    if (lowerContent.startsWith('!map ')) {
        const mapName = message.content.substring(5);
        const result = await getMapInfo(mapName);
        message.reply(result);
        return;
    }

    if (lowerContent.startsWith('!player ')) {
        const playerName = message.content.substring(8).trim();
        const result = await getPlayerStats(playerName);
        message.reply(result);
        return;
    }

    if (lowerContent.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            await message.channel.send({ content: meme.title, files: [meme.url] });
        } else {
            await message.channel.send('Could not fetch a meme right now. Try again later.');
        }
        return;
    }
    
    if (message.content.includes(`<@${discordClient.user.id}>`)) {
        const response = await getAIResponse(message.content, 'discord', message.author.username);
        await message.reply(response);
    }
});

// ===== CULTIST MONITORING SYSTEM =====
const CULTIST_CONFIG = {
    CHANNEL_ID: '1001340004259352678',
    CHECK_INTERVAL_MS: 300000,
    CULTIST_MAPS: ['Customs', 'Shoreline', 'Woods', 'Factory', 'Ground Zero']
};

let lastCultistStates = {
    server1: {},
    server2: {}
};

async function checkCultistActivity() {
    try {
        const maps = await getMapTimes();
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
        
        maps.forEach(map => {
            if (!CULTIST_CONFIG.CULTIST_MAPS.includes(map.name)) return;
            if (!map.enemies || !map.enemies.includes('Cultist')) return;
            
            const mapKey = map.normalizedName;
            
            if (server1Active && !lastCultistStates.server1[mapKey]) {
                channel.send(`🌙 **Cultists active on ${map.name} (Server 1)!** In-game time: ${server1Time}`);
                lastCultistStates.server1[mapKey] = true;
                console.log(`[CULTIST] Server 1 active on ${map.name} at ${server1Time}`);
            } else if (!server1Active && lastCultistStates.server1[mapKey]) {
                channel.send(`☀️ **Cultists despawned on ${map.name} (Server 1).** In-game time: ${server1Time}`);
                lastCultistStates.server1[mapKey] = false;
                console.log(`[CULTIST] Server 1 inactive on ${map.name} at ${server1Time}`);
            }
            
            if (server2Active && !lastCultistStates.server2[mapKey]) {
                channel.send(`🌙 **Cultists active on ${map.name} (Server 2)!** In-game time: ${server2Time}`);
                lastCultistStates.server2[mapKey] = true;
                console.log(`[CULTIST] Server 2 active on ${map.name} at ${server2Time}`);
            } else if (!server2Active && lastCultistStates.server2[mapKey]) {
                channel.send(`☀️ **Cultists despawned on ${map.name} (Server 2).** In-game time: ${server2Time}`);
                lastCultistStates.server2[mapKey] = false;
                console.log(`[CULTIST] Server 2 inactive on ${map.name} at ${server2Time}`);
            }
        });
    } catch (error) {
        console.error('[CULTIST] Monitoring error:', error);
    }
}

discordClient.once('ready', () => {
    console.log('[CULTIST] Starting monitoring system...');
    checkCultistActivity();
    setInterval(checkCultistActivity, CULTIST_CONFIG.CHECK_INTERVAL_MS);
    console.log(`[CULTIST] Monitoring every ${CULTIST_CONFIG.CHECK_INTERVAL_MS / 60000} minutes`);
});

// ===== START DISCORD CLIENT =====
discordClient.login(process.env.DISCORD_TOKEN);

// ============================================================================
// END OF OPTIMIZED BOT
// ============================================================================
