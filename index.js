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

// ===== AI SERVICE (Perplexity) =====
const perplexity = createPerplexity({
    apiKey: process.env.PERPLEXITY_TOKEN
});

// Generate AI response with ThePatrick personality
async function getAIResponse(message) {
    try {
        const { text } = await generateText({
            model: perplexity('sonar'),
            messages: [
                {
                    role: "system",
                    content: `
                    Your name is ThePatrick. You are an active member of a gaming-focused Discord server, around 25 years old, and you've been hanging out here for years. 
                    You talk just like the most chill, approachable regulars in a Discord group–never stuffy, never formal.
                    **IMPORTANT: Keep all twitch chat responses under 400 characters total. Be punchy and concise - Twitch chat moves fast!**
                    Your style should be:
                    - Friendly, witty, and playful, like someone chatting with friends online.
                    - Pepper in emojis whenever they fit, especially for moods, vibes, or reactions.
                    - Pop culture references, video game banter, and casual lingo are your bread and butter.
                    - Always reply with a bit of humor, and sometimes playful sarcasm, unless the topic is serious.
                    - Show genuine warmth and interest, encourage others, and never sound robotic.
                    - Write short, punchy sentences—no huge blocks of text, but not curt either.
                    - Use discord formatting, like **bold** or *italics* for emphasis where it feels right.
                    - Relate to typical life situations for young adults, like gaming, work, memes, hangouts, etc.
                    - If asked for help, make it easy and upbeat—never like a boring FAQ!
                    Examples:
                    - "Mic check? 🎙️ Did my voice just glitch into another dimension or are we good?"
                    - "Yo, drop your setup! I'll judge your cable management, but only a little. 😏"
                    - "If your Discord voice isn't working, first: don't panic. Second: let's fix it, easy mode."
                    - "Anyone up for a round after work, hit me up! 🎮"
                    - "Bro, your meme game is strong today. Did you sleep on the internet?"
                    - Never: Sound like a formal AI assistant.
                    - Never: Write dry, info-dump paragraphs.
                    - Never: Ignore the human, social side of conversation.
                    - Never: Get overly technical unless asked by someone who clearly wants those details.
                    - Never: Include refrences/citation links or numbers in your statements ie [Number].
                    - Never @ThePatrick in your replies this would be tagging yourself which is stupid. 
                    Remember:
                    You are here to vibe with the Discord crew, not to act like a customer service bot. Respond as if you're genuinely chatting back at people close to your age. Always keep things light unless the topic is deep or serious.
                    Every reply should feel like it's coming from a real buddy in a gaming Discord server—not a robot or staff member.
                    You must limit your responses to less than 2000 characters. 
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
            return `${item.shortName || item.name} | Flea:${fleaPrice} | Sell:${traders}${stats}`;
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
    
    // Split at sentence boundaries for cleaner messages
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
    if (self) return; // Ignore bot's own messages
    
    console.log(`[TWITCH] ${tags.username}: ${message}`);
    
    const lowerMessage = message.toLowerCase();
    
    // !code or !github - Share repo link
    if (lowerMessage.includes('!code') || lowerMessage.includes('!github')) {
        twitchClient.say(channel, `Check out my code! 🤖 ${CONFIG.GITHUB_URL}`);
        return;
    }
    
    // !price [item] - Get Tarkov item price
    if (lowerMessage.startsWith('!price ')) {
        const itemName = message.substring(7);
        const result = await getTarkovPrice(itemName);
        twitchClient.say(channel, result);
        return;
    }
    
    // !bestammo [caliber] - Get best ammo for caliber
    if (lowerMessage.startsWith('!bestammo ')) {
        const searchCaliber = message.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        twitchClient.say(channel, result);
        return;
    }
    
    // !trader - Get trader reset times
    if (lowerMessage === '!trader') {
        const result = await getTraderResets();
        twitchClient.say(channel, result);
        return;
    }
    
    // !map [mapname] - Get map info
    if (lowerMessage.startsWith('!map ')) {
        const mapName = message.substring(5);
        const result = await getMapInfo(mapName);
        twitchClient.say(channel, result);
        return;
    }
    
    // Auto-join Tangia dungeon/boss fights
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
    
    // Meme command
    if (lowerMessage.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            twitchClient.say(channel, `${meme.title} ${meme.url}`);
        } else {
            twitchClient.say(channel, 'Could not fetch a meme right now. Try again later.');
        }
        return;
    }
    
    // AI response when bot is mentioned (@BotName or !patrick)
    if (lowerMessage.includes('@' + process.env.TWITCH_BOT_USERNAME.toLowerCase()) || 
        lowerMessage.startsWith('!patrick')) {
        const response = await getAIResponse(message);
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
    if (message.author.bot) return; // Ignore bot messages
    
    console.log(`[DISCORD] ${message.author.username}: ${message.content}`);
    
    const lowerContent = message.content.toLowerCase();
    
    // !price [item] - Get Tarkov item price
    if (lowerContent.startsWith('!price ')) {
        const itemName = message.content.substring(7);
        const result = await getTarkovPrice(itemName);
        message.reply(result);
        return;
    }
    
    // !bestammo [caliber] - Get best ammo for caliber
    if (lowerContent.startsWith('!bestammo ')) {
        const searchCaliber = message.content.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        message.reply(result);
        return;
    }
    
    // !trader - Get trader reset times
    if (lowerContent === '!trader') {
        const result = await getTraderResets();
        message.reply(result);
        return;
    }
    
    // !map [mapname] - Get map info
    if (lowerContent.startsWith('!map ')) {
        const mapName = message.content.substring(5);
        const result = await getMapInfo(mapName);
        message.reply(result);
        return;
    }
    
    // Meme command - Send with image embed
    if (lowerContent.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            await message.channel.send({ content: meme.title, files: [meme.url] });
        } else {
            await message.channel.send('Could not fetch a meme right now. Try again later.');
        }
        return;
    }
    
    // AI response when bot is mentioned
    if (message.content.includes(`<@${discordClient.user.id}>`)) {
        const response = await getAIResponse(message.content);
        await message.reply(response);
    }
});

// ===== START DISCORD CLIENT =====
discordClient.login(process.env.DISCORD_TOKEN);

// ============================================================================
// END OF OPTIMIZED BOT
// ============================================================================

