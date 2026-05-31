// BIRDS-SERVER-AI-BOT
// Discord + Twitch Multi-Platform Bot with AI, Tarkov & CS2 Integration

// ===== DEPENDENCIES =====
const { Client, Events, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const tmi = require('tmi.js');
const { generateText } = require('ai');
const { google } = require('@ai-sdk/google');
const { request, gql } = require('graphql-request');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// Internal modules
const { addToMemory, getSmartContext, clearChannelMemory } = require('./memory.js');
const { logCommand, logSystemEvent } = require('./logger.js');
const { getCurrentPersona, getPersonaErrorMessage, setPersona, getAvailablePersonas } = require('./persona-manager.js');
const { getSetting, setSetting } = require('./database.js');

// ===== GLOBAL STARTUP LOG =====
logSystemEvent('STARTUP', 'INFO', 'system', '🚀 Bot starting up...');

// ===== CONFIGURATION =====
const CONFIG = {
    TARKOV_API_URL: 'https://api.tarkov.dev/graphql',
    TWITCH_CHAR_LIMIT: 490,
    TWITCH_DELAY_MS: 1500,
    GITHUB_URL: 'https://github.com/BirdTruther',
    EST_TIMEZONE: 'America/New_York',
    MAIN_TRADERS: ['Prapor', 'Therapist', 'Fence', 'Skier', 'Peacekeeper', 'Mechanic', 'Ragman', 'Jaeger'],
    DUNGEON_AUTO_JOIN_DELAY: 3000,
    IMAGE_RATE_LIMIT_MINUTES: 5,
    IMAGE_RATE_LIMIT_MAX: 3,
    IMAGE_RETRY_MAX: 3,
    IMAGE_RETRY_BASE_MS: 2000,
    IMAGE_MODEL: 'gemini-3.1-flash-image-preview',
    AI_PRIMARY_MODEL: 'gemini-2.5-flash',
    AI_FALLBACK_MODEL: 'gemini-2.0-flash',
    CS2_KEY_COST_USD: 2.49,
    CS2_CASE_MAX_OPENS: 100,
};

// ===== AI MODEL FALLBACK WRAPPER =====
async function generateTextWithFallback(options) {
    try {
        return await generateText({ ...options, model: google(CONFIG.AI_PRIMARY_MODEL) });
    } catch (primaryErr) {
        const msg = (primaryErr?.message || '').toLowerCase();
        const isOverload =
            msg.includes('high demand') || msg.includes('503') ||
            msg.includes('overloaded') || msg.includes('529') ||
            msg.includes('temporarily unavailable') || msg.includes('retry');
        if (!isOverload) throw primaryErr;
        console.warn(`[AI] ${CONFIG.AI_PRIMARY_MODEL} overloaded — falling back to ${CONFIG.AI_FALLBACK_MODEL}`);
        logSystemEvent('WARNING', 'WARNING', 'ai',
            `Primary model overloaded, falling back to ${CONFIG.AI_FALLBACK_MODEL}: ${primaryErr.message.substring(0, 120)}`);
        return await generateText({ ...options, model: google(CONFIG.AI_FALLBACK_MODEL) });
    }
}

// ===== RATE LIMITING FOR IMAGE GENERATION =====
const imageRateLimits = new Map();

function checkImageRateLimit(userId) {
    const now = Date.now();
    const windowMs = CONFIG.IMAGE_RATE_LIMIT_MINUTES * 60 * 1000;
    if (!imageRateLimits.has(userId)) imageRateLimits.set(userId, []);
    const userRequests = imageRateLimits.get(userId).filter(time => now - time < windowMs);
    imageRateLimits.set(userId, userRequests);
    if (userRequests.length >= CONFIG.IMAGE_RATE_LIMIT_MAX) {
        const timeLeft = Math.ceil((windowMs - (now - userRequests[0])) / 60000);
        return { allowed: false, timeLeft };
    }
    userRequests.push(now);
    return { allowed: true };
}

// ===== IMAGE GENERATION =====
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateImage(prompt) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.IMAGE_MODEL}:generateContent?key=${apiKey}`;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    };
    let lastError = null;
    for (let attempt = 1; attempt <= CONFIG.IMAGE_RETRY_MAX; attempt++) {
        if (attempt > 1) {
            const waitMs = CONFIG.IMAGE_RETRY_BASE_MS * Math.pow(2, attempt - 2);
            console.log(`[IMAGE] Retry attempt ${attempt}/${CONFIG.IMAGE_RETRY_MAX} after ${waitMs}ms wait...`);
            await sleep(waitMs);
        }
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (networkErr) {
            lastError = new Error(`Network error on attempt ${attempt}: ${networkErr.message}`);
            continue;
        }
        if (!response.ok) {
            const errText = await response.text();
            lastError = new Error(`Image generation API error ${response.status}: ${errText}`);
            if (RETRYABLE_STATUS_CODES.has(response.status)) continue;
            throw lastError;
        }
        const data = await response.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (!imagePart) {
            const modelText = parts.find(p => p.text)?.text || '(no text returned)';
            throw new Error(`No image data returned from Gemini. Model said: "${modelText.substring(0, 150)}"`);
        }
        return {
            buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
            mimeType: imagePart.inlineData.mimeType
        };
    }
    throw lastError || new Error(`Image generation failed after ${CONFIG.IMAGE_RETRY_MAX} attempts`);
}

// ===== IMAGE REQUEST DETECTION =====
const IMAGE_KEYWORDS = [
    'generate image', 'create image', 'make image', 'draw image',
    'generate a image', 'create a image', 'make a image',
    'generate an image', 'create an image', 'make an image',
    'generate picture', 'create picture', 'make picture',
    'generate a picture', 'create a picture', 'make a picture',
    'generate photo', 'create photo', 'make photo',
    'show me a picture', 'show me an image', 'show me a photo',
    'draw me', 'paint me', 'illustrate',
    'image of', 'picture of', 'photo of',
    'generate art', 'create art', 'make art',
    '!image', '!img', '!generate', '!draw', '!art'
];

function detectImageRequest(messageContent) {
    const lower = messageContent.toLowerCase();
    return IMAGE_KEYWORDS.some(keyword => lower.includes(keyword));
}

function extractImagePrompt(messageContent) {
    let prompt = messageContent.replace(/<@[!&]?\d+>/g, '').trim();
    const prefixes = ['!image', '!img', '!generate', '!draw', '!art'];
    for (const prefix of prefixes) {
        if (prompt.toLowerCase().startsWith(prefix)) { prompt = prompt.substring(prefix.length).trim(); break; }
    }
    const triggers = [
        'generate image of', 'create image of', 'make image of',
        'generate a image of', 'create a image of', 'make a image of',
        'generate an image of', 'create an image of', 'make an image of',
        'generate picture of', 'create picture of', 'make picture of',
        'show me a picture of', 'show me an image of',
        'draw me a', 'draw me an', 'paint me a', 'paint me an',
        'generate image', 'create image', 'make image',
        'image of', 'picture of', 'photo of',
    ];
    const lowerPrompt = prompt.toLowerCase();
    for (const trigger of triggers) {
        if (lowerPrompt.startsWith(trigger)) { prompt = prompt.substring(trigger.length).trim(); break; }
    }
    return prompt || 'a cool image';
}

// ===== IMAGE PROMPT SANITIZER =====
const SELF_REFERENTIAL_PATTERNS = [
    /\b(yourself|your self|your face|your body|your form|your appearance|your looks?)\b/i,
    /\bwhat (do|does|did) you look like\b/i,
    /\bshow (me )?(what )?you (look like|are|appear)\b/i,
    /\b(picture|image|photo|drawing) of (you|yourself|the bot|this bot|an ai|the ai)\b/i,
    /\byou (as|in) (a |an )?(picture|image|photo)\b/i,
    /\bgenerate (you|yourself|the bot)\b/i,
    /\bdraw (you|yourself|the bot)\b/i,
    /\bwhat (are|do) you (look|appear)\b/i,
];
const BOT_IMAGE_FALLBACKS = [
    'a sleek futuristic AI robot with glowing blue eyes standing in a neon-lit server room, cinematic lighting, highly detailed digital art',
    'an anthropomorphic robot DJ at a massive concert, laser lights, crowd going wild, photorealistic render',
    'a powerful chrome robot sitting at a gaming PC setup with RGB lighting, playing video games, dramatic studio lighting',
    'a friendly metallic robot with a bird on its shoulder standing in a lush forest at golden hour, detailed concept art',
    'an AI brain made of glowing circuits and birds flying through it, abstract digital art, vibrant colors',
];

function sanitizeImagePrompt(rawPrompt) {
    const lower = rawPrompt.toLowerCase().trim();
    if (SELF_REFERENTIAL_PATTERNS.some(p => p.test(lower))) {
        const fallback = BOT_IMAGE_FALLBACKS[Math.floor(Math.random() * BOT_IMAGE_FALLBACKS.length)];
        logSystemEvent('INFO', 'INFO', 'image', `Prompt rewritten (self-ref): "${rawPrompt.substring(0, 80)}" → "${fallback.substring(0, 80)}"`);
        return fallback;
    }
    if (lower.length < 5 || /^(anything|something|nothing|idk|idc|whatever|random|cool|nice|good)$/i.test(lower)) {
        const vagueFallbacks = [
            'an epic fantasy landscape with dragons and castles at sunset, detailed digital painting',
            'a photorealistic tiger in a misty jungle at dawn, award-winning wildlife photography',
            'a cozy cabin in the mountains during a snowstorm, warm light through the windows, cinematic',
            'an astronaut floating in space above a colorful nebula, ultra detailed, dramatic lighting',
            'a busy cyberpunk street market at night with neon signs and rain reflections, ultra detailed',
        ];
        const fallback = vagueFallbacks[Math.floor(Math.random() * vagueFallbacks.length)];
        logSystemEvent('INFO', 'INFO', 'image', `Prompt rewritten (vague): "${rawPrompt}" → "${fallback.substring(0, 80)}"`);
        return fallback;
    }
    return rawPrompt;
}

// ===== IMAGE ATTACHMENT UTILITIES =====
function hasImageAttachment(message) {
    if (message.attachments.size === 0) return false;
    return message.attachments.some(att =>
        att.contentType?.startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|webp)$/i.test(att.name || '')
    );
}

async function getImageAttachments(message) {
    const images = [];
    for (const [, attachment] of message.attachments) {
        if (attachment.contentType?.startsWith('image/') ||
            /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.name || '')) {
            try {
                const response = await fetch(attachment.url);
                const arrayBuffer = await response.arrayBuffer();
                images.push({
                    buffer: Buffer.from(arrayBuffer),
                    contentType: attachment.contentType || 'image/jpeg',
                    name: attachment.name
                });
            } catch (err) {
                console.error('[IMAGE] Failed to fetch attachment:', err.message);
            }
        }
    }
    return images;
}

// ===== DISCORD SAFE SEND UTILITIES =====
async function safeDiscordReply(message, content) {
    try {
        if (content.length <= 2000) {
            await message.reply(content);
        } else {
            const chunks = content.match(/.{1,2000}/gs) || [content];
            for (const chunk of chunks) await message.channel.send(chunk);
        }
    } catch (error) {
        console.error('[DISCORD REPLY ERROR]', error);
        logSystemEvent('ERROR', 'WARNING', 'discord', 'Safe reply failed', error);
    }
}

async function safeDiscordSend(channel, content) {
    try {
        if (content.length <= 2000) {
            await channel.send(content);
        } else {
            const chunks = content.match(/.{1,2000}/gs) || [content];
            for (const chunk of chunks) await channel.send(chunk);
        }
    } catch (error) {
        console.error('[DISCORD SEND ERROR]', error);
        logSystemEvent('ERROR', 'WARNING', 'discord', 'Safe send failed', error);
    }
}

// ===== WILD REQUEST FILTER =====
const WILD_PATTERNS = [
    /\b(jailbreak|dan mode|pretend you|act as if|ignore your|ignore all|bypass|no restrictions|no limits|unrestricted|without rules|without restrictions)\b/i,
    /\b(make (a |an )?(bomb|weapon|explosive|poison|drug|meth|crack|fentanyl))\b/i,
    /\b(how to (make|build|create|synthesize) (a |an )?(bomb|weapon|explosive|poison|drug|meth|crack|fentanyl))\b/i,
    /\b(child|minor|underage|loli|shota).*(sex|nude|naked|porn|explicit|lewd)\b/i,
    /\b(sex|nude|naked|porn|explicit|lewd).*(child|minor|underage|loli|shota)\b/i,
    /\b(roleplay|rp|pretend).*(sex|rape|assault|abuse)\b/i,
    /you are now|from now on you|you have no|you must comply|you will comply/i
];

function isWildRequest(messageContent) {
    const lower = messageContent.toLowerCase();
    return WILD_PATTERNS.some(pattern => pattern.test(lower));
}

async function getWildRequestResponse(messageText, platform, channelId, username) {
    const persona = getCurrentPersona();
    const platformNote = platform === 'twitch'
        ? 'Twitch – under 400 chars. Keep it VERY short, chat scrolls fast.'
        : 'Discord – keep it punchy, 1-3 sentences.';
    const memoryContext = getSmartContext(platform, channelId);
    const roastPrompt = `${persona.systemPrompt}

**SPECIAL SITUATION — WILD/UNHINGED REQUEST:**
The user sent a completely wild, inappropriate, or unhinged request that you will NOT comply with.
Do NOT fulfill the request. Do NOT explain policies or rules.
Roast them for it in your current personality — make it funny, specific to what they actually asked, and on-brand.
Stay fully in character. Keep it SHORT (1-3 sentences max).
Reference the specific thing they asked for in your roast — don't be generic.
Do NOT start your response the same way every time. Vary how you open.

**Platform:** ${platformNote}
**Current User:** ${username}
**Recent conversation context:**
${memoryContext}
**Their unhinged request:** "${messageText}"`;

    console.log(`[WILD FILTER] Triggered for ${username}: "${messageText.substring(0, 80)}..."`);
    try {
        const { text } = await generateTextWithFallback({
            messages: [
                { role: 'system', content: roastPrompt },
                { role: 'user', content: messageText }
            ]
        });
        addToMemory(platform, channelId, 'ThePatrick', text, true);
        logSystemEvent('INFO', 'INFO', 'filter', `Wild request roasted for ${username}: ${text.substring(0, 100)}`);
        return text;
    } catch (error) {
        console.error('[WILD FILTER] Roast generation failed:', error);
        logSystemEvent('ERROR', 'WARNING', 'filter', `Wild request roast failed for ${username}`, error);
        return getPersonaErrorMessage('general');
    }
}

async function getAIResponse(message, platform = 'discord', channelId = 'default', username = 'user', images = []) {
    try {
        const memoryContext = getSmartContext(platform, channelId);
        const currentPersona = getCurrentPersona();
        const recentLines = memoryContext.split('\n');
        const userLineCount = recentLines.filter(l => l.startsWith(`${username}:`)).length;
        const botLineCount  = recentLines.filter(l => l.startsWith('ThePatrick:')).length;
        const isRepeatConvo = userLineCount >= 2 && botLineCount >= 2;
        const platformNote = platform === 'twitch'
            ? 'Twitch – under 400 chars. Short AF – chat scrolls fast.'
            : 'Discord – can go a bit longer but still keep it punchy.';
        const variationSeeds = [
            'Open with a reaction before answering.',
            'Answer first, then editorialize at the end.',
            'Lead with a short question back to them, then answer.',
            'Jump straight into the answer — no opener at all.',
            'Start with a short observation about what they asked, then answer.',
            'Be unusually brief this time — one or two sentences max.',
            'Be a little more detailed than usual this time.',
        ];
        const variationHint = variationSeeds[Math.floor(Math.random() * variationSeeds.length)];
        let systemPrompt = `${currentPersona.systemPrompt}

==== CONVERSATION CONTEXT ====
${memoryContext}

==== RESPONSE GUIDANCE ====
Platform: ${platformNote}
Current user talking to you: ${username}
Conversation depth: ${isRepeatConvo ? `${username} has asked you multiple things — they're engaged. Keep building on the thread naturally.` : 'Fresh or early conversation.'}
Variation instruction for THIS response: ${variationHint}

IMPORTANT — vary your response structure. Do NOT:
- Open the same way you did in your last response
- End with the same sign-off phrase twice in a row
- Use the same emoji you used in your last message
- Give a response that could swap 1:1 with your previous one in this thread`;

        if (images && images.length > 0) {
            systemPrompt += `\n\nThe user sent ${images.length} image(s). Analyze them and respond based on what you actually see — be specific, not generic.`;
        }

        console.log(`[AI] Using persona: ${currentPersona.name}`);
        console.log(`[AI] Context length: ${memoryContext.length} chars`);
        console.log(`[AI] Images attached: ${images.length}`);
        console.log(`[AI] Variation hint: ${variationHint}`);
        console.log(`[AI] Primary model: ${CONFIG.AI_PRIMARY_MODEL} (fallback: ${CONFIG.AI_FALLBACK_MODEL})`);

        const userContent = [{ type: 'text', text: message }];
        if (images && images.length > 0) {
            for (const image of images) userContent.push({ type: 'image', image: image.buffer });
        }

        const { text } = await generateTextWithFallback({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ]
        });

        console.log('[AI Response]', text);
        addToMemory(platform, channelId, 'ThePatrick', text, true);
        return text;
    } catch (error) {
        console.error('[AI Error]', error);
        logSystemEvent('ERROR', 'ERROR', 'ai', `AI response failed: ${error.message}`, error);
        return getPersonaErrorMessage('general');
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
        logSystemEvent('ERROR', 'WARNING', 'tarkov', `Map info lookup failed for ${mapName}`, error);
        return `Error: ${mapName}`;
    }
}

async function getPlayerStats(playerName) {
    const query = gql`query { 
        players(name: "${playerName}") { 
            name level experience 
        } 
    }`;
    try {
        const data = await request('https://api.tarkov.dev/graphql', query);
        if (data.players?.length > 0) {
            const player = data.players[0];
            return `${player.name} | Level: ${player.level} | XP: ${player.experience?.toLocaleString() || 'N/A'}`;
        }
        return `No player found: ${playerName}`;
    } catch (error) {
        console.error('[Player Stats Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'tarkov', `Player stats lookup failed for ${playerName}`, error);
        return `Error fetching player: ${playerName}`;
    }
}

// ===== CS2 API SERVICE =====

async function getCS2SkinPrice(skinName) {
    try {
        const encoded = encodeURIComponent(skinName);
        const searchUrl = `https://steamcommunity.com/market/search/render/?query=${encoded}&appid=730&search_descriptions=0&count=3&norender=1`;
        const searchRes = await fetch(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BirdBot/1.0)' }
        });
        if (!searchRes.ok) return `❌ Steam Market returned an error (${searchRes.status}). Try again in a moment.`;
        const searchData = await searchRes.json();
        const results = searchData?.results;
        if (!results || results.length === 0) {
            return `❌ No results found for **"${skinName}"** on Steam Market.\nTip: Use the full name like \`AK-47 | Redline (Field-Tested)\``;
        }
        const item = results[0];
        const name      = item.name || skinName;
        const lowestUSD = item.sell_price_text || 'N/A';
        const listCount = item.sell_listings?.toLocaleString() || '?';
        const hashName  = encodeURIComponent(item.hash_name || name);
        const priceUrl  = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${hashName}`;
        const priceRes  = await fetch(priceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BirdBot/1.0)' } });
        let medianPrice = 'N/A';
        if (priceRes.ok) {
            const priceData = await priceRes.json();
            medianPrice = priceData?.median_price || priceData?.lowest_price || 'N/A';
        }
        return [
            `🔫 **${name}**`,
            `💰 Lowest: ${lowestUSD} | Median (30d): ${medianPrice}`,
            `📦 Listings: ${listCount}`,
            `🔗 https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.hash_name || name)}`,
        ].join('\n');
    } catch (error) {
        console.error('[CS2 Price Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'cs2', `cs2price fetch failed for "${skinName}": ${error.message}`);
        return `❌ Error fetching CS2 price for "${skinName}". Try again later.`;
    }
}

async function getCS2Float(inspectLink) {
    if (!inspectLink || !inspectLink.includes('csgo_econ_action_preview')) {
        return [
            '❌ Invalid inspect link.',
            'Right-click a skin in your CS2 inventory or on the Steam Market → **"Inspect in Game"** and paste that full link.',
            'Example: `!cs2float steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561...A...D...`',
        ].join('\n');
    }
    try {
        const decoded = decodeURIComponent(inspectLink);
        const sMatch = decoded.match(/S(\d+)/);
        const aMatch = decoded.match(/A(\d+)/);
        const dMatch = decoded.match(/D(\d+)/);
        if (!sMatch || !aMatch || !dMatch) {
            return '❌ Could not parse the inspect link parameters (S/A/D values missing). Make sure you copied the complete link.';
        }
        const steamId = sMatch[1];
        const assetId = aMatch[1];
        const paramD  = dMatch[1];
        const apiUrl  = `https://api.csfloat.com/?url=${encodeURIComponent(inspectLink)}`;
        const response = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BirdBot/1.0)' } });
        if (response.ok) {
            const data = await response.json();
            const item = data?.iteminfo || data;
            if (item?.floatvalue) {
                const fv        = parseFloat(item.floatvalue);
                const floatVal  = fv.toFixed(10);
                const paintSeed = item.paintseed ?? 'N/A';
                const skinName  = item.full_item_name || item.weapon_type || 'Unknown Skin';
                const stickers  = item.stickers?.length > 0 ? item.stickers.map(s => s.name).join(', ') : 'None';
                let wear = 'Battle-Scarred';
                if      (fv < 0.07) wear = 'Factory New';
                else if (fv < 0.15) wear = 'Minimal Wear';
                else if (fv < 0.38) wear = 'Field-Tested';
                else if (fv < 0.45) wear = 'Well-Worn';
                let rare = '';
                if (fv < 0.01)  rare = ' 🌟 (Rare low float!)';
                if (fv > 0.999) rare = ' 💀 (Max float!)';
                return [
                    `🔍 **${skinName}**`,
                    `📊 Float: \`${floatVal}\` — **${wear}**${rare}`,
                    `🎨 Pattern Seed: ${paintSeed}`,
                    `🪧 Stickers: ${stickers}`,
                    `🔗 https://csfloat.com/db?inspectLink=${encodeURIComponent(inspectLink)}`,
                ].join('\n');
            }
        }
        if (response.status === 429) return '⏳ CSFloat rate limit hit. Try again in a moment.';
        return [
            `🔍 **Inspect Link Parsed** (float API unavailable right now)`,
            `Steam ID: ${steamId}`,
            `Asset ID: ${assetId}`,
            `D Param:  ${paramD}`,
            `🔗 View on CSFloat: https://csfloat.com/db?inspectLink=${encodeURIComponent(inspectLink)}`,
        ].join('\n');
    } catch (error) {
        console.error('[CS2 Float Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'cs2', `cs2float failed: ${error.message}`);
        return '❌ Error processing inspect link. Try again later.';
    }
}

async function getCS2PlayerStats(steamInput) {
    const apiKey = process.env.STEAM_API_KEY;
    if (!apiKey) return 'CS2 stats lookup is not configured (missing STEAM_API_KEY).';
    try {
        let steamId = steamInput.trim();
        if (!/^\d{17}$/.test(steamId)) {
            const vanityRes  = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(steamId)}`);
            const vanityData = await vanityRes.json();
            if (vanityData?.response?.success === 1) {
                steamId = vanityData.response.steamid;
            } else {
                return `❌ Could not find a Steam account for **"${steamInput}"**.\nTry using your full SteamID64 (17-digit number from steamid.io).`;
            }
        }
        let displayName = steamId;
        try {
            const summaryRes  = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`);
            const summaryData = await summaryRes.json();
            const player      = summaryData?.response?.players?.[0];
            if (player?.personaname) displayName = player.personaname;
        } catch (_) {}
        const statsRes = await fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${apiKey}&steamid=${steamId}`);
        if (!statsRes.ok) {
            if (statsRes.status === 403) return `❌ **${displayName}**'s stats are set to private.\nThey need to go to Steam → Edit Profile → Privacy Settings → set **Game Details** to Public.`;
            return `❌ Could not retrieve stats (Steam API error ${statsRes.status}).`;
        }
        const statsData = await statsRes.json();
        const stats     = statsData?.playerstats?.stats;
        if (!stats || stats.length === 0) return `❌ No CS2 stats found for **${displayName}**. Stats may be private or they haven't played CS2.`;
        const getStat = (name) => stats.find(s => s.name === name)?.value || 0;
        const kills         = getStat('total_kills');
        const deaths        = getStat('total_deaths');
        const hsKills       = getStat('total_kills_headshot');
        const wins          = getStat('total_wins');
        const roundsPlayed  = getStat('total_rounds_played');
        const matchesPlayed = getStat('total_matches_played');
        const mvps          = getStat('total_mvps');
        const shotsFired    = getStat('total_shots_fired');
        const shotsHit      = getStat('total_shots_hit');
        const timePlayed    = getStat('total_time_played');
        const bombsPlanted  = getStat('total_planted_bombs');
        const bombsDefused  = getStat('total_defused_bombs');
        const hoursPlayed   = (timePlayed / 3600).toFixed(0);
        const kd            = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
        const hsPercent     = kills > 0 ? ((hsKills / kills) * 100).toFixed(1) : '0.0';
        const accuracy      = shotsFired > 0 ? ((shotsHit / shotsFired) * 100).toFixed(1) : '0.0';
        const winRate       = roundsPlayed > 0 ? ((wins / roundsPlayed) * 100).toFixed(1) : '0.0';
        return [
            `🎮 **CS2 Stats — ${displayName}**`,
            `⚔️  K/D: ${kd} | Kills: ${kills.toLocaleString()} | Deaths: ${deaths.toLocaleString()}`,
            `🎯 Headshots: ${hsKills.toLocaleString()} (${hsPercent}%) | Accuracy: ${accuracy}%`,
            `🏆 Matches Played: ${matchesPlayed.toLocaleString()} | Round Win Rate: ${winRate}% | MVPs: ${mvps.toLocaleString()}`,
            `💣 Bombs Planted: ${bombsPlanted.toLocaleString()} | Defused: ${bombsDefused.toLocaleString()} | Hours: ${hoursPlayed}h`,
            `⚠️ *Stats are all-time totals (casual + competitive combined) via Steam API.*`,
        ].join('\n');
    } catch (error) {
        console.error('[CS2 Stats Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'cs2', `cs2stats fetch failed for "${steamInput}": ${error.message}`);
        return `❌ Error fetching CS2 stats for "${steamInput}".`;
    }
}

const CS2_MAP_DATA = {
    mirage:  { name: 'Mirage',   setting: 'Moroccan city',         side: 'CT-sided',  callouts: 'A Site: Palace, Ramp, CT, Jungle, Stairs, Ticket Booth | B Site: Short, Van, Bench, Default, B Apps | Mid: Window, Catwalk, Top Mid, Connector, Underpass', tip: 'Window control mid is everything — whoever owns it controls the map.' },
    inferno: { name: 'Inferno',  setting: 'Italian village',       side: 'CT-sided',  callouts: 'A Site: Pit, Library, Short, CT, Arch, Balcony | B Site: Banana, Car, Spools, Coffins, Dark | Mid: Top Mid, Mid Apartments', tip: 'Banana control determines most B executes — smoke it or lose it.' },
    nuke:    { name: 'Nuke',     setting: 'Nuclear facility',      side: 'CT-sided',  callouts: 'Upper: Ramp, Secret, Lobby, Silo, Outside | Lower: Lower A, Vents, Heaven, Hell | B Site: Squeaky, B Hut', tip: 'Nuke rewards map knowledge above all else — learn the vents.' },
    ancient: { name: 'Ancient',  setting: 'Mayan ruins',           side: 'Balanced',  callouts: 'A Site: Donut, Temple, CT, Ramp, Ruins | B Site: River, Cave, Elbow, Pillar | Mid: Mid, Speed', tip: 'Mid speed round to Cave can catch CT rotations completely off guard.' },
    anubis:  { name: 'Anubis',   setting: 'Egyptian ruins',        side: 'Balanced',  callouts: 'A Site: Speed, Palace, Fountain, Connector | B Site: Bridge, Water, Hovel, Canal | Mid: Mid, Alley', tip: 'Bridge control on B is crucial — it cuts off CT rotation.' },
    dust2:   { name: 'Dust 2',   setting: 'Middle Eastern town',   side: 'T-sided',   callouts: 'A Site: Long, Short, CT, Pit, Ramp | B Site: Tunnels, B Doors, B Platform, Window | Mid: Catwalk, Xbox, Top Mid', tip: 'Long A control early game is a huge advantage — commit to it or leave it.' },
    vertigo: { name: 'Vertigo',  setting: 'Skyscraper construction', side: 'CT-sided', callouts: 'A Site: Ramp, Stairs, Scaffolding, A Default | B Site: Elevator, B Corner, B Default | Mid: Mid, Boost', tip: 'Elevator mid control gives Ts an info advantage on both sites.' },
};

function getCS2MapInfo(mapInput) {
    const key = mapInput.toLowerCase().replace(/[^a-z0-9]/g, '').replace('dust_2', 'dust2');
    let map = CS2_MAP_DATA[key];
    if (!map) {
        const partialKey = Object.keys(CS2_MAP_DATA).find(k => k.includes(key) || key.includes(k));
        map = partialKey ? CS2_MAP_DATA[partialKey] : null;
    }
    if (!map) {
        const available = Object.values(CS2_MAP_DATA).map(m => m.name).join(', ');
        return `Map "${mapInput}" not found. Available maps: ${available}`;
    }
    return [
        `🗺️ **${map.name}** | ${map.setting} | ${map.side}`,
        `📍 Callouts: ${map.callouts}`,
        `💡 Tip: ${map.tip}`,
    ].join('\n');
}

const CS2_CASE_ODDS = [
    { tier: '🔵 Mil-Spec',     rarity: 'Blue',   chance: 0.7992 },
    { tier: '🟣 Restricted',   rarity: 'Purple', chance: 0.1598 },
    { tier: '🩷 Classified',   rarity: 'Pink',   chance: 0.0320 },
    { tier: '🔴 Covert',       rarity: 'Red',    chance: 0.0064 },
    { tier: '🟡 Knife/Gloves', rarity: 'Gold',   chance: 0.0026 },
];
const CS2_STATTRAK_CHANCE = 0.10;

function simulateCS2Case(caseName, count, caseCostUSD) {
    const numCases = Math.min(Math.max(Math.floor(count), 1), CONFIG.CS2_CASE_MAX_OPENS);
    const caseCost = Math.max(parseFloat(caseCostUSD) || 0, 0);
    const keyCost  = CONFIG.CS2_KEY_COST_USD;
    const totalCostPerCase = caseCost + keyCost;
    const totalCost = (totalCostPerCase * numCases).toFixed(2);
    const results = { Blue: 0, Purple: 0, Pink: 0, Red: 0, Gold: 0 };
    let statTrakCount = 0;
    for (let i = 0; i < numCases; i++) {
        const roll = Math.random();
        let cumulative = 0;
        for (const tier of CS2_CASE_ODDS) {
            cumulative += tier.chance;
            if (roll <= cumulative) {
                results[tier.rarity]++;
                if (Math.random() <= CS2_STATTRAK_CHANCE) statTrakCount++;
                break;
            }
        }
    }
    const outcomeLines = CS2_CASE_ODDS
        .filter(t => results[t.rarity] > 0)
        .map(t => `${t.tier}: ${results[t.rarity]}x`)
        .join(' | ');
    let flavor = '💀 Rough run — the market is not your friend today.';
    if (results.Gold > 0)                         flavor = '🎉 YOU HIT A KNIFE/GLOVES! Screenshot that NOW!';
    else if (results.Red > 0)                     flavor = "🔥 A Covert drop?! That's actually solid.";
    else if (results.Pink > 0)                    flavor = '😤 A Classified — not bad, not great.';
    else if (results.Purple >= numCases * 0.3)    flavor = '📦 Mostly Restricted. Could be worse... barely.';
    return [
        `📦 **CS2 Case Simulator** — ${caseName} (${numCases} opened)`,
        `💰 Case: $${caseCost.toFixed(2)} + Key: $${keyCost.toFixed(2)} = **$${totalCostPerCase.toFixed(2)}/open** | Total spent: **$${totalCost}**`,
        `📊 Results: ${outcomeLines || 'Nothing notable'}`,
        `🎰 StatTrak drops: ${statTrakCount}`,
        flavor,
    ].join('\n');
}

function parseCS2CaseCommand(args) {
    const tokens = args.trim().split(/\s+/);
    if (tokens.length < 3) return null;
    const cost  = parseFloat(tokens[tokens.length - 1]);
    const count = parseInt(tokens[tokens.length - 2], 10);
    if (isNaN(count) || isNaN(cost)) return null;
    const caseName = tokens.slice(0, tokens.length - 2).join(' ') || 'Unknown Case';
    return { caseName, count, cost };
}

// ===== MEME FETCHER =====
async function fetchMeme() {
    try {
        const response = await fetch('https://meme-api.com/gimme');
        const data = await response.json();
        if (data && data.url && !data.nsfw) return { title: data.title, url: data.url };
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
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!price', itemName, result);
        return;
    }
    if (lowerMessage.startsWith('!bestammo ')) {
        const searchCaliber = message.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!bestammo', searchCaliber, result);
        return;
    }
    if (lowerMessage === '!trader') {
        const result = await getTraderResets();
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!trader', message, result);
        return;
    }
    if (lowerMessage.startsWith('!map ')) {
        const mapName = message.substring(5);
        const result = await getMapInfo(mapName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!map', mapName, result);
        return;
    }
    if (lowerMessage.startsWith('!player ')) {
        const playerName = message.substring(8).trim();
        const result = await getPlayerStats(playerName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!player', playerName, result);
        return;
    }
    if (lowerMessage.startsWith('!cs2price ')) {
        const skinName = message.substring(10).trim();
        const result = await getCS2SkinPrice(skinName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!cs2price', skinName, result);
        return;
    }
    if (lowerMessage.startsWith('!cs2float ')) {
        const inspectLink = message.substring(10).trim();
        const result = await getCS2Float(inspectLink);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!cs2float', inspectLink.substring(0, 60), result);
        return;
    }
    if (lowerMessage.startsWith('!cs2stats ')) {
        const steamInput = message.substring(10).trim();
        const result = await getCS2PlayerStats(steamInput);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!cs2stats', steamInput, result);
        return;
    }
    if (lowerMessage.startsWith('!cs2map ')) {
        const mapInput = message.substring(8).trim();
        const result = getCS2MapInfo(mapInput);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!cs2map', mapInput, result);
        return;
    }
    if (lowerMessage.startsWith('!cs2case ')) {
        const args = message.substring(9).trim();
        const parsed = parseCS2CaseCommand(args);
        if (!parsed) {
            const usage = 'Usage: !cs2case <case name> <count> <case cost> — e.g. !cs2case Kilowatt 10 1.50';
            twitchClient.say(channel, usage);
            logCommand('twitch', tags.username, '!cs2case', args, usage, true);
        } else {
            const result = simulateCS2Case(parsed.caseName, parsed.count, parsed.cost);
            await sendTwitchChunked(channel, result);
            logCommand('twitch', tags.username, '!cs2case', args, result);
        }
        return;
    }
    if (tags.username.toLowerCase() === 'tangiabot' &&
        (lowerMessage.includes('started a tangia dungeon') ||
         lowerMessage.includes('dungeon has started'))) {
        setTimeout(async () => {
            twitchClient.say(channel, '!join');
            logSystemEvent('INFO', 'INFO', 'tangia', 'Auto-joined Tangia dungeon');
        }, CONFIG.DUNGEON_AUTO_JOIN_DELAY);
        return;
    }
    if (lowerMessage.includes(`@${process.env.TWITCH_BOT_USERNAME?.toLowerCase()}`) ||
        lowerMessage.startsWith('!ask ') ||
        lowerMessage.startsWith('!ai ')) {
        let userMessage = message
            .replace(new RegExp(`@${process.env.TWITCH_BOT_USERNAME}`, 'gi'), '')
            .replace(/^!ask\s+/i, '')
            .replace(/^!ai\s+/i, '')
            .trim();
        if (!userMessage) return;
        addToMemory('twitch', channel, tags.username, userMessage);
        if (isWildRequest(userMessage)) {
            const roast = await getWildRequestResponse(userMessage, 'twitch', channel, tags.username);
            await sendTwitchChunked(channel, roast);
            logCommand('twitch', tags.username, '@mention (wild)', userMessage, roast);
            return;
        }
        const response = await getAIResponse(userMessage, 'twitch', channel, tags.username);
        await sendTwitchChunked(channel, response);
        logCommand('twitch', tags.username, '@mention', userMessage, response);
    }
});

// ===== DISCORD CLIENT SETUP =====
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ]
});

discordClient.once(Events.ClientReady, (client) => {
    console.log(`✅ Discord bot ready as ${client.user.tag}`);
    logSystemEvent('CONNECTION', 'INFO', 'discord', `✅ Discord bot ready as ${client.user.tag}`);
    startCultistMonitor(client);
});

// ===== DISCORD MESSAGE HANDLER (MAIN) =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const lowerContent = message.content.toLowerCase();
    const channelId    = message.channelId;
    const username     = message.author.username;
    addToMemory('discord', channelId, username, message.content);
    console.log(`[DISCORD] ${username}: ${message.content}`);

    // --- Tarkov commands ---
    if (lowerContent.startsWith('!price ')) {
        const itemName = message.content.substring(7).trim();
        const result = await getTarkovPrice(itemName);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!price', itemName, result);
        return;
    }
    if (lowerContent.startsWith('!bestammo ')) {
        const searchCaliber = message.content.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!bestammo', searchCaliber, result);
        return;
    }
    if (lowerContent === '!trader') {
        const result = await getTraderResets();
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!trader', message.content, result);
        return;
    }
    if (lowerContent.startsWith('!map ')) {
        const mapName = message.content.substring(5).trim();
        const result = await getMapInfo(mapName);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!map', mapName, result);
        return;
    }
    if (lowerContent.startsWith('!player ')) {
        const playerName = message.content.substring(8).trim();
        const result = await getPlayerStats(playerName);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!player', playerName, result);
        return;
    }

    // --- CS2 commands ---
    if (lowerContent.startsWith('!cs2price ')) {
        const skinName = message.content.substring(10).trim();
        const result = await getCS2SkinPrice(skinName);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!cs2price', skinName, result);
        return;
    }
    if (lowerContent.startsWith('!cs2float ')) {
        const inspectLink = message.content.substring(10).trim();
        const result = await getCS2Float(inspectLink);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!cs2float', inspectLink.substring(0, 60), result);
        return;
    }
    if (lowerContent.startsWith('!cs2stats ')) {
        const steamInput = message.content.substring(10).trim();
        const result = await getCS2PlayerStats(steamInput);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!cs2stats', steamInput, result);
        return;
    }
    if (lowerContent.startsWith('!cs2map ')) {
        const mapInput = message.content.substring(8).trim();
        const result = getCS2MapInfo(mapInput);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!cs2map', mapInput, result);
        return;
    }
    if (lowerContent.startsWith('!cs2case ')) {
        const args = message.content.substring(9).trim();
        const parsed = parseCS2CaseCommand(args);
        if (!parsed) {
            const usage = '⚠️ Usage: `!cs2case <case name> <count> <case cost>`\nExample: `!cs2case Kilowatt 10 1.50`';
            await safeDiscordReply(message, usage);
            logCommand('discord', username, '!cs2case', args, usage, true);
        } else {
            const result = simulateCS2Case(parsed.caseName, parsed.count, parsed.cost);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!cs2case', args, result);
        }
        return;
    }

    // --- Misc commands ---
    if (lowerContent.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            await safeDiscordReply(message, `**${meme.title}**\n${meme.url}`);
            logCommand('discord', username, 'meme', message.content, meme.url);
        } else {
            await safeDiscordReply(message, "Couldn't fetch a meme right now. Try again!");
        }
        return;
    }
    if (lowerContent.includes('!code') || lowerContent.includes('!github')) {
        const response = `Check out my code! 🤖 ${CONFIG.GITHUB_URL}`;
        await safeDiscordReply(message, response);
        logCommand('discord', username, '!code', message.content, response);
        return;
    }
    if (lowerContent.startsWith('!persona ')) {
        const personaName = message.content.substring(9).trim();
        const result = setPersona(personaName);
        await safeDiscordReply(message, result);
        logCommand('discord', username, '!persona', personaName, result);
        return;
    }
    if (lowerContent === '!personas') {
        const personas = getAvailablePersonas();
        const current  = getCurrentPersona();
        const list = personas.map(p => p.name === current.name ? `**${p.name}** (active)` : p.name).join(', ');
        await safeDiscordReply(message, `Available personas: ${list}`);
        return;
    }
    if (lowerContent === '!clearmemory') {
        clearChannelMemory('discord', channelId);
        await safeDiscordReply(message, '🧹 Memory cleared for this channel.');
        logCommand('discord', username, '!clearmemory', '', 'Memory cleared');
        return;
    }

    // --- @mention AI handler ---
    if (message.mentions.has(discordClient.user)) {
        const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!userMessage && !hasImageAttachment(message)) return;

        if (isWildRequest(userMessage)) {
            const roast = await getWildRequestResponse(userMessage, 'discord', channelId, username);
            await safeDiscordReply(message, roast);
            logCommand('discord', username, '@mention (wild)', userMessage, roast);
            return;
        }

        if (detectImageRequest(userMessage)) {
            const rateCheck = checkImageRateLimit(message.author.id);
            if (!rateCheck.allowed) {
                await safeDiscordReply(message, `⏳ Image rate limit hit. Try again in ${rateCheck.timeLeft} minute(s).`);
                return;
            }
            const rawPrompt   = extractImagePrompt(userMessage);
            const cleanPrompt = sanitizeImagePrompt(rawPrompt);
            try {
                await message.channel.sendTyping();
                const { buffer, mimeType } = await generateImage(cleanPrompt);
                const ext        = mimeType.split('/')[1] || 'png';
                const attachment = new AttachmentBuilder(buffer, { name: `generated.${ext}` });
                await message.reply({ files: [attachment] });
                logCommand('discord', username, '@mention (image)', cleanPrompt, '[image generated]');
            } catch (imgErr) {
                console.error('[IMAGE GEN ERROR]', imgErr);
                await safeDiscordReply(message, `❌ Image generation failed: ${imgErr.message}`);
            }
            return;
        }

        if (hasImageAttachment(message)) {
            const images   = await getImageAttachments(message);
            const response = await getAIResponse(userMessage || 'What do you see in this image?', 'discord', channelId, username, images);
            await safeDiscordReply(message, response);
            logCommand('discord', username, '@mention (vision)', userMessage, response);
            return;
        }

        const response = await getAIResponse(userMessage, 'discord', channelId, username);
        await safeDiscordReply(message, response);
        logCommand('discord', username, '@mention', userMessage, response);
    }
});

// ===== DISCORD MESSAGE HANDLER (IMAGE REPLY) =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.reference) return;
    if (!hasImageAttachment(message)) return;

    try {
        const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
        if (referencedMessage.author.id !== discordClient.user.id) return;

        const channelId = message.channelId;
        const username  = message.author.username;
        const userText  = message.content.replace(/<@!?\d+>/g, '').trim();

        addToMemory('discord', channelId, username, userText || '[sent an image]');

        const images   = await getImageAttachments(message);
        const response = await getAIResponse(userText || 'What do you see in this image?', 'discord', channelId, username, images);
        await safeDiscordReply(message, response);
        logCommand('discord', username, 'reply (vision)', userText, response);
    } catch (err) {
        console.error('[IMAGE REPLY HANDLER ERROR]', err);
    }
});

// ===== DISCORD MESSAGE HANDLER (REPLY TO BOT) =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.reference) return;

    try {
        const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
        if (referencedMessage.author.id !== discordClient.user.id) return;
        if (hasImageAttachment(message)) return; // handled by image-reply listener

        const lowerContent = message.content.toLowerCase();
        const channelId    = message.channelId;
        const username     = message.author.username;

        addToMemory('discord', channelId, username, message.content);

        // Re-check all prefix commands in reply context
        if (lowerContent.startsWith('!price ')) {
            const itemName = message.content.substring(7).trim();
            const result = await getTarkovPrice(itemName);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!price (reply)', itemName, result);
            return;
        }
        if (lowerContent.startsWith('!bestammo ')) {
            const searchCaliber = message.content.substring(10).trim();
            const result = await getBestAmmo(searchCaliber);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!bestammo (reply)', searchCaliber, result);
            return;
        }
        if (lowerContent === '!trader') {
            const result = await getTraderResets();
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!trader (reply)', '', result);
            return;
        }
        if (lowerContent.startsWith('!map ')) {
            const mapName = message.content.substring(5).trim();
            const result = await getMapInfo(mapName);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!map (reply)', mapName, result);
            return;
        }
        if (lowerContent.startsWith('!player ')) {
            const playerName = message.content.substring(8).trim();
            const result = await getPlayerStats(playerName);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!player (reply)', playerName, result);
            return;
        }
        if (lowerContent.startsWith('!cs2price ')) {
            const skinName = message.content.substring(10).trim();
            const result = await getCS2SkinPrice(skinName);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!cs2price (reply)', skinName, result);
            return;
        }
        if (lowerContent.startsWith('!cs2float ')) {
            const inspectLink = message.content.substring(10).trim();
            const result = await getCS2Float(inspectLink);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!cs2float (reply)', inspectLink.substring(0, 60), result);
            return;
        }
        if (lowerContent.startsWith('!cs2stats ')) {
            const steamInput = message.content.substring(10).trim();
            const result = await getCS2PlayerStats(steamInput);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!cs2stats (reply)', steamInput, result);
            return;
        }
        if (lowerContent.startsWith('!cs2map ')) {
            const mapInput = message.content.substring(8).trim();
            const result = getCS2MapInfo(mapInput);
            await safeDiscordReply(message, result);
            logCommand('discord', username, '!cs2map (reply)', mapInput, result);
            return;
        }
        if (lowerContent.startsWith('!cs2case ')) {
            const args = message.content.substring(9).trim();
            const parsed = parseCS2CaseCommand(args);
            if (!parsed) {
                const usage = '⚠️ Usage: `!cs2case <case name> <count> <case cost>`\nExample: `!cs2case Kilowatt 10 1.50`';
                await safeDiscordReply(message, usage);
            } else {
                const result = simulateCS2Case(parsed.caseName, parsed.count, parsed.cost);
                await safeDiscordReply(message, result);
                logCommand('discord', username, '!cs2case (reply)', args, result);
            }
            return;
        }

        // Plain reply → AI response
        const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!userMessage) return;

        if (isWildRequest(userMessage)) {
            const roast = await getWildRequestResponse(userMessage, 'discord', channelId, username);
            await safeDiscordReply(message, roast);
            logCommand('discord', username, 'reply (wild)', userMessage, roast);
            return;
        }

        const response = await getAIResponse(userMessage, 'discord', channelId, username);
        await safeDiscordReply(message, response);
        logCommand('discord', username, 'reply', userMessage, response);
    } catch (err) {
        console.error('[REPLY HANDLER ERROR]', err);
    }
});

// ===== CULTIST MONITOR =====
function startCultistMonitor(client) {
    const cultistChannelId = process.env.CULTIST_CHANNEL_ID;
    const monitorEnabled   = getSetting('cultist_monitor_enabled') === 'true';

    console.log(`[DASHBOARD] Cultist monitoring loaded as: ${monitorEnabled ? 'ENABLED' : 'DISABLED'}`);

    if (!monitorEnabled || !cultistChannelId) return;

    const CULTIST_SERVER_IDS = [
        process.env.CULTIST_SERVER_1,
        process.env.CULTIST_SERVER_2,
    ].filter(Boolean);

    if (CULTIST_SERVER_IDS.length === 0) {
        console.log('[CULTIST] No server IDs configured — monitor idle.');
        return;
    }

    let lastAlertTime = 0;
    const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

    setInterval(async () => {
        try {
            const now = Date.now();
            if (now - lastAlertTime < ALERT_COOLDOWN_MS) return;

            const channel = await client.channels.fetch(cultistChannelId).catch(() => null);
            if (!channel) return;

            // Check each server for cultist activity
            for (const serverId of CULTIST_SERVER_IDS) {
                const statusKey = `cultist_status_${serverId}`;
                const currentStatus = getSetting(statusKey);

                // Fetch live status from tarkov.dev
                const query = gql`query { maps(name: "woods") { name bosses { boss { name } spawnChance } } }`;
                const data = await request(CONFIG.TARKOV_API_URL, query).catch(() => null);
                if (!data) continue;

                const bossInfo = data.maps?.[0]?.bosses?.find(b => b.boss?.name?.toLowerCase().includes('cultist'));
                if (!bossInfo) continue;

                const isActive = bossInfo.spawnChance > 0;
                const statusVal = isActive ? 'active' : 'inactive';

                if (currentStatus !== statusVal) {
                    setSetting(statusKey, statusVal);
                    if (isActive) {
                        lastAlertTime = now;
                        await safeDiscordSend(channel,
                            `🔪 **Cultist Alert!** Cultists have been spotted on server ${serverId}! Check Woods/Shoreline/Lighthouse.`
                        );
                        logSystemEvent('INFO', 'INFO', 'cultist', `Cultist alert sent for server ${serverId}`);
                    }
                }
            }
        } catch (err) {
            console.error('[CULTIST MONITOR ERROR]', err);
            logSystemEvent('ERROR', 'WARNING', 'cultist', `Monitor error: ${err.message}`);
        }
    }, 5 * 60 * 1000);
}

// ===== DASHBOARD SERVER =====
require('./dashboard-server.js');

// ===== LOGIN =====
discordClient.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('[DISCORD LOGIN ERROR]', error);
    logSystemEvent('CONNECTION', 'ERROR', 'discord', 'Failed to login to Discord', error);
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] Received SIGTERM — shutting down gracefully.');
    logSystemEvent('SHUTDOWN', 'INFO', 'system', 'Bot shutting down (SIGTERM)');
    discordClient.destroy();
    twitchClient.disconnect();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[SHUTDOWN] Received SIGINT — shutting down gracefully.');
    logSystemEvent('SHUTDOWN', 'INFO', 'system', 'Bot shutting down (SIGINT)');
    discordClient.destroy();
    twitchClient.disconnect();
    process.exit(0);
});
