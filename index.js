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
    // Retry config for image generation API
    IMAGE_RETRY_MAX: 3,           // max total attempts
    IMAGE_RETRY_BASE_MS: 2000,    // initial wait: 2s, then 4s, then 8s
    // IMPORTANT: Model reference for native image OUTPUT via Gemini API.
    // gemini-2.5-flash / gemini-2.0-flash are text+vision models — they can READ
    // images but cannot GENERATE them.
    //
    // gemini-2.0-flash-preview-image-generation — RETIRED (404 as of May 2026)
    // gemini-3.1-flash-image-preview             — CORRECT (Google "Nano Banana 2", current)
    // gemini-2.5-flash-image                     — CORRECT (Google "Nano Banana", also valid)
    IMAGE_MODEL: 'gemini-3.1-flash-image-preview',

    // AI text model cascade — primary is tried first; on overload (503/529) fallback is used.
    // gemini-2.5-flash  → best quality, but subject to demand spikes
    // gemini-2.0-flash  → fast, reliable fallback that almost never 503s
    AI_PRIMARY_MODEL: 'gemini-2.5-flash',
    AI_FALLBACK_MODEL: 'gemini-2.0-flash',

    // CS2 config
    CS2_KEY_COST_USD: 2.49,       // Valve's fixed key price — never changes
    CS2_CASE_MAX_OPENS: 100,      // max cases per !cs2case command
};

// ===== AI MODEL FALLBACK WRAPPER =====
// Calls the primary model (gemini-2.5-flash). If Google returns a
// high-demand / overload error (message contains "high demand", "503",
// "overloaded", or "529"), automatically retries once on the fallback
// model (gemini-2.0-flash) so the bot keeps responding during spikes.
async function generateTextWithFallback(options) {
    // Attempt primary model
    try {
        const result = await generateText({
            ...options,
            model: google(CONFIG.AI_PRIMARY_MODEL),
        });
        return result;
    } catch (primaryErr) {
        const msg = (primaryErr?.message || '').toLowerCase();
        const isOverload =
            msg.includes('high demand') ||
            msg.includes('503') ||
            msg.includes('overloaded') ||
            msg.includes('529') ||
            msg.includes('temporarily unavailable') ||
            msg.includes('retry');

        if (!isOverload) {
            // Not an overload error — re-throw so callers handle it normally
            throw primaryErr;
        }

        // Log the fallback switch
        console.warn(`[AI] ${CONFIG.AI_PRIMARY_MODEL} overloaded — falling back to ${CONFIG.AI_FALLBACK_MODEL}`);
        logSystemEvent('WARNING', 'WARNING', 'ai',
            `Primary model overloaded, falling back to ${CONFIG.AI_FALLBACK_MODEL}: ${primaryErr.message.substring(0, 120)}`
        );

        // Attempt fallback model — let this throw naturally if it also fails
        const result = await generateText({
            ...options,
            model: google(CONFIG.AI_FALLBACK_MODEL),
        });
        return result;
    }
}

// ===== RATE LIMITING FOR IMAGE GENERATION =====
const imageRateLimits = new Map();

function checkImageRateLimit(userId) {
    const now = Date.now();
    const windowMs = CONFIG.IMAGE_RATE_LIMIT_MINUTES * 60 * 1000;
    
    if (!imageRateLimits.has(userId)) {
        imageRateLimits.set(userId, []);
    }
    
    const userRequests = imageRateLimits.get(userId).filter(time => now - time < windowMs);
    imageRateLimits.set(userId, userRequests);
    
    if (userRequests.length >= CONFIG.IMAGE_RATE_LIMIT_MAX) {
        const oldestRequest = userRequests[0];
        const timeLeft = Math.ceil((windowMs - (now - oldestRequest)) / 60000);
        return { allowed: false, timeLeft };
    }
    
    userRequests.push(now);
    return { allowed: true };
}

// ===== IMAGE GENERATION =====
// Uses Gemini's dedicated image generation model (gemini-3.1-flash-image-preview)
// via the generateContent REST API (v1beta endpoint).
//
// IMPORTANT MODEL NOTES (as of May 2026):
//   - gemini-3.1-flash-image-preview   ← CORRECT (Google "Nano Banana 2", generates image output)
//   - gemini-2.5-flash-image           ← CORRECT (Google "Nano Banana", also generates images)
//   - gemini-2.0-flash-preview-image-generation ← RETIRED / 404 — do not use
//   - gemini-2.5-flash                 ← WRONG for this (text+vision only, cannot generate images)
//   - gemini-2.0-flash                 ← WRONG for this (text+vision only, cannot generate images)
//
// Includes exponential backoff retry for transient server errors (503, 429, 500).
// Non-retryable errors (400, 401, 403, 404) fail immediately.
//
// Retry schedule (CONFIG.IMAGE_RETRY_BASE_MS = 2000ms):
//   Attempt 1: immediate
//   Attempt 2: wait 2s
//   Attempt 3: wait 4s
//   → throws after all attempts exhausted

// HTTP status codes that are worth retrying (transient server-side issues)
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateImage(prompt) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.IMAGE_MODEL}:generateContent?key=${apiKey}`;

    const body = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
        }
    };

    let lastError = null;

    for (let attempt = 1; attempt <= CONFIG.IMAGE_RETRY_MAX; attempt++) {
        // Exponential backoff before each retry (not before the first attempt)
        if (attempt > 1) {
            const waitMs = CONFIG.IMAGE_RETRY_BASE_MS * Math.pow(2, attempt - 2); // 2s, 4s, 8s...
            console.log(`[IMAGE] Retry attempt ${attempt}/${CONFIG.IMAGE_RETRY_MAX} after ${waitMs}ms wait...`);
            logSystemEvent('INFO', 'INFO', 'image', `Image gen retry ${attempt}/${CONFIG.IMAGE_RETRY_MAX} (waiting ${waitMs}ms) for prompt: "${prompt.substring(0, 60)}"`);
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
            // Network-level failure (DNS, connection refused, etc.) — always retry
            lastError = new Error(`Network error on attempt ${attempt}: ${networkErr.message}`);
            console.warn(`[IMAGE] Network error on attempt ${attempt}:`, networkErr.message);
            logSystemEvent('WARNING', 'WARNING', 'image', `Image gen network error attempt ${attempt}: ${networkErr.message}`);
            continue;
        }

        if (!response.ok) {
            const errText = await response.text();
            lastError = new Error(`Image generation API error ${response.status}: ${errText}`);

            if (RETRYABLE_STATUS_CODES.has(response.status)) {
                // Transient error — log and retry
                console.warn(`[IMAGE] Retryable error ${response.status} on attempt ${attempt}/${CONFIG.IMAGE_RETRY_MAX}`);
                logSystemEvent('WARNING', 'WARNING', 'image', `Image gen HTTP ${response.status} on attempt ${attempt}/${CONFIG.IMAGE_RETRY_MAX}: ${errText.substring(0, 120)}`);
                continue;
            } else {
                // Non-retryable (400 bad request, 401 auth, 403 forbidden, 404 not found) — fail immediately
                console.error(`[IMAGE] Non-retryable error ${response.status} — aborting`);
                logSystemEvent('ERROR', 'ERROR', 'image', `Image gen non-retryable HTTP ${response.status}: ${errText.substring(0, 120)}`);
                throw lastError;
            }
        }

        // --- Success: parse the response ---
        const data = await response.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

        if (!imagePart) {
            // Model returned text instead of an image.
            // This should only happen if the prompt was sanitized incorrectly or the model
            // safety filters blocked it. Log it clearly and do NOT retry — it won't change.
            const textPart = parts.find(p => p.text);
            const modelText = textPart?.text || '(no text returned)';
            console.warn('[IMAGE] Model did not return an image. Model said:', modelText);
            logSystemEvent('WARNING', 'WARNING', 'image', `Image gen returned no image part. Model said: ${modelText.substring(0, 200)}`);
            // Not a transient error — the model made a content decision, retrying won't help
            throw new Error(`No image data returned from Gemini. Model said: "${modelText.substring(0, 150)}"`);
        }

        if (attempt > 1) {
            console.log(`[IMAGE] Success on attempt ${attempt} after retries.`);
            logSystemEvent('INFO', 'INFO', 'image', `Image gen succeeded on attempt ${attempt} after retries.`);
        }

        return {
            buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
            mimeType: imagePart.inlineData.mimeType
        };
    }

    // All attempts exhausted
    console.error(`[IMAGE] All ${CONFIG.IMAGE_RETRY_MAX} attempts failed. Last error:`, lastError?.message);
    logSystemEvent('ERROR', 'ERROR', 'image', `Image gen failed after ${CONFIG.IMAGE_RETRY_MAX} attempts: ${lastError?.message}`);
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
    let prompt = messageContent;
    
    // Remove bot mention
    prompt = prompt.replace(/<@[!&]?\d+>/g, '').trim();
    
    // Remove command prefixes
    const prefixes = ['!image', '!img', '!generate', '!draw', '!art'];
    for (const prefix of prefixes) {
        if (prompt.toLowerCase().startsWith(prefix)) {
            prompt = prompt.substring(prefix.length).trim();
            break;
        }
    }
    
    // Remove trigger phrases
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
        if (lowerPrompt.startsWith(trigger)) {
            prompt = prompt.substring(trigger.length).trim();
            break;
        }
    }
    
    return prompt || 'a cool image';
}

// ===== IMAGE PROMPT SANITIZER =====
// Rewrites vague, self-referential, or identity-based prompts into concrete
// visual descriptions that the image model will actually generate.
//
// The Gemini image model refuses prompts like "what do you look like" or
// "a picture of yourself" because it has no physical form and responds with
// a text explanation instead of an image. We catch those here and substitute
// a vivid, on-brand visual prompt so the request always produces something cool.
//
// Also rewrites other known trouble patterns:
//   - Extremely short/vague prompts (1-2 words) → adds artistic context
//   - "nothing" / "anything" / empty → generates a random cool scene
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

// Fallback prompts for self-referential requests — bot-themed, visually strong
const BOT_IMAGE_FALLBACKS = [
    'a sleek futuristic AI robot with glowing blue eyes standing in a neon-lit server room, cinematic lighting, highly detailed digital art',
    'an anthropomorphic robot DJ at a massive concert, laser lights, crowd going wild, photorealistic render',
    'a powerful chrome robot sitting at a gaming PC setup with RGB lighting, playing video games, dramatic studio lighting',
    'a friendly metallic robot with a bird on its shoulder standing in a lush forest at golden hour, detailed concept art',
    'an AI brain made of glowing circuits and birds flying through it, abstract digital art, vibrant colors',
];

function sanitizeImagePrompt(rawPrompt) {
    const lower = rawPrompt.toLowerCase().trim();

    // Self-referential / identity prompts → bot-themed visual
    if (SELF_REFERENTIAL_PATTERNS.some(p => p.test(lower))) {
        const fallback = BOT_IMAGE_FALLBACKS[Math.floor(Math.random() * BOT_IMAGE_FALLBACKS.length)];
        console.log(`[IMAGE] Self-referential prompt detected. Rewriting:\n  Original: "${rawPrompt}"\n  Rewritten: "${fallback}"`);
        logSystemEvent('INFO', 'INFO', 'image', `Prompt rewritten (self-ref): "${rawPrompt.substring(0, 80)}" → "${fallback.substring(0, 80)}"`);
        return fallback;
    }

    // Extremely vague / empty prompts → add artistic framing
    if (lower.length < 5 || /^(anything|something|nothing|idk|idc|whatever|random|cool|nice|good)$/i.test(lower)) {
        const vagueFallbacks = [
            'an epic fantasy landscape with dragons and castles at sunset, detailed digital painting',
            'a photorealistic tiger in a misty jungle at dawn, award-winning wildlife photography',
            'a cozy cabin in the mountains during a snowstorm, warm light through the windows, cinematic',
            'an astronaut floating in space above a colorful nebula, ultra detailed, dramatic lighting',
            'a busy cyberpunk street market at night with neon signs and rain reflections, ultra detailed',
        ];
        const fallback = vagueFallbacks[Math.floor(Math.random() * vagueFallbacks.length)];
        console.log(`[IMAGE] Vague prompt detected. Rewriting:\n  Original: "${rawPrompt}"\n  Rewritten: "${fallback}"`);
        logSystemEvent('INFO', 'INFO', 'image', `Prompt rewritten (vague): "${rawPrompt}" → "${fallback.substring(0, 80)}"`);
        return fallback;
    }

    // Prompt is fine — pass through unchanged
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
            for (const chunk of chunks) {
                await message.channel.send(chunk);
            }
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
            for (const chunk of chunks) {
                await channel.send(chunk);
            }
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
            for (const image of images) {
                userContent.push({
                    type: 'image',
                    image: image.buffer
                });
            }
        }

        const { text } = await generateTextWithFallback({
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: userContent
                }
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

// --- !cs2price <skin name> ---
// Fetches current skin price from CSGOSkins.GG API.
// Returns lowest listed price and Steam Market price side by side.
async function getCS2SkinPrice(skinName) {
    const apiKey = process.env.CSGOSKINS_API_KEY;
    if (!apiKey) return 'CS2 price lookup is not configured (missing CSGOSKINS_API_KEY).';

    try {
        const encoded = encodeURIComponent(skinName);
        const url = `https://api.csgoskins.gg/v1/items/prices?name=${encoded}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[CS2 Price] API error ${response.status}: ${errText}`);
            logSystemEvent('ERROR', 'WARNING', 'cs2', `cs2price API error ${response.status} for "${skinName}"`);
            return `Could not fetch price for "${skinName}" (API error ${response.status}).`;
        }

        const data = await response.json();
        // CSGOSkins.GG returns an array of items — grab the first closest match
        const items = data?.items || data?.data || data;
        if (!Array.isArray(items) || items.length === 0) {
            return `No results found for "${skinName}". Try a more specific name like "AK-47 | Redline (Field-Tested)".`;
        }

        const item = items[0];
        const name   = item.name || skinName;
        const steam  = item.prices?.steam   ? `$${parseFloat(item.prices.steam).toFixed(2)}`   : 'N/A';
        const lowest = item.prices?.lowest  ? `$${parseFloat(item.prices.lowest).toFixed(2)}`  : 'N/A';
        const buff   = item.prices?.buff163  ? `$${parseFloat(item.prices.buff163).toFixed(2)}` : null;

        let result = `🔫 **${name}** | Steam: ${steam} | Lowest: ${lowest}`;
        if (buff) result += ` | Buff163: ${buff}`;
        return result;
    } catch (error) {
        console.error('[CS2 Price Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'cs2', `cs2price fetch failed for "${skinName}": ${error.message}`);
        return `Error fetching CS2 price for "${skinName}".`;
    }
}

// --- !cs2stats <steamid or vanity url> ---
// Fetches CS2 player stats via the official Steam Web API.
// Accepts a 64-bit SteamID (e.g. 76561198xxxxxxxxx) or a vanity URL name.
// Vanity URLs are resolved to SteamID64 first via ResolveVanityURL.
async function getCS2PlayerStats(steamInput) {
    const apiKey = process.env.STEAM_API_KEY;
    if (!apiKey) return 'CS2 stats lookup is not configured (missing STEAM_API_KEY).';

    try {
        let steamId = steamInput.trim();

        // If input is not a 17-digit numeric SteamID64, try resolving it as a vanity URL
        if (!/^\d{17}$/.test(steamId)) {
            const vanityUrl = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(steamId)}`;
            const vanityRes = await fetch(vanityUrl);
            const vanityData = await vanityRes.json();
            if (vanityData?.response?.success === 1) {
                steamId = vanityData.response.steamid;
            } else {
                return `Could not find a Steam account for "${steamInput}". Try using your full SteamID64 (17-digit number).`;
            }
        }

        // Fetch CS2 (appid 730) stats
        const statsUrl = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${apiKey}&steamid=${steamId}`;
        const statsRes = await fetch(statsUrl);

        if (!statsRes.ok) {
            if (statsRes.status === 403) {
                return `Stats for that account are private. The player needs to make their game stats public in Steam privacy settings.`;
            }
            return `Could not retrieve stats (Steam API error ${statsRes.status}).`;
        }

        const statsData = await statsRes.json();
        const stats = statsData?.playerstats?.stats;

        if (!stats || stats.length === 0) {
            return `No CS2 stats found for that account. Stats may be private or the player hasn't played CS2.`;
        }

        // Pull key stats by name from the stats array
        const getStat = (name) => stats.find(s => s.name === name)?.value || 0;

        const kills          = getStat('total_kills').toLocaleString();
        const deaths         = getStat('total_deaths').toLocaleString();
        const wins           = getStat('total_wins').toLocaleString();
        const matchesPlayed  = getStat('total_matches_played').toLocaleString();
        const headshotKills  = getStat('total_kills_headshot').toLocaleString();
        const mvps           = getStat('total_mvps').toLocaleString();
        const timePlayed     = getStat('total_time_played');
        const hoursPlayed    = (timePlayed / 3600).toFixed(0);

        const kdRaw = getStat('total_deaths') > 0
            ? (getStat('total_kills') / getStat('total_deaths')).toFixed(2)
            : getStat('total_kills').toFixed(2);

        const hsPercent = getStat('total_kills') > 0
            ? ((getStat('total_kills_headshot') / getStat('total_kills')) * 100).toFixed(1)
            : '0.0';

        const playerName = statsData.playerstats.steamID || steamInput;

        return [
            `🎮 **CS2 Stats** for SteamID: ${steamId}`,
            `K/D: ${kdRaw} | Kills: ${kills} | Deaths: ${deaths}`,
            `Wins: ${wins} | Matches: ${matchesPlayed} | MVPs: ${mvps}`,
            `Headshots: ${headshotKills} (${hsPercent}%) | Hours: ${hoursPlayed}h`,
        ].join('\n');
    } catch (error) {
        console.error('[CS2 Stats Error]', error);
        logSystemEvent('ERROR', 'WARNING', 'cs2', `cs2stats fetch failed for "${steamInput}": ${error.message}`);
        return `Error fetching CS2 stats for "${steamInput}".`;
    }
}

// --- !cs2map <map name> ---
// Returns callouts and key info for CS2 active duty maps.
// Fully static — no API needed. Update CS2_MAP_DATA as the map pool changes.
const CS2_MAP_DATA = {
    mirage: {
        name: 'Mirage',
        setting: 'Moroccan city',
        side: 'CT-sided',
        callouts: 'A Site: Palace, Ramp, CT, Jungle, Stairs, Ticket Booth | B Site: Short, Van, Bench, Default, B Apps | Mid: Window, Catwalk, Top Mid, Connector, Underpass',
        tip: 'Window control mid is everything — whoever owns it controls the map.',
    },
    inferno: {
        name: 'Inferno',
        setting: 'Italian village',
        side: 'CT-sided',
        callouts: 'A Site: Pit, Library, Short, CT, Arch, Balcony | B Site: Banana, Car, Spools, Coffins, Dark | Mid: Top Mid, Mid Apartments',
        tip: 'Banana control determines most B executes — smoke it or lose it.',
    },
    nuke: {
        name: 'Nuke',
        setting: 'Nuclear facility',
        side: 'CT-sided',
        callouts: 'Upper: Ramp, Secret, Lobby, Silo, Outside | Lower: Lower A, Vents, Heaven, Hell | B Site: Squeaky, B Hut',
        tip: 'Nuke rewards map knowledge above all else — learn the vents.',
    },
    ancient: {
        name: 'Ancient',
        setting: 'Mayan ruins',
        side: 'Balanced',
        callouts: 'A Site: Donut, Temple, CT, Ramp, Ruins | B Site: River, Cave, Elbow, Pillar | Mid: Mid, Speed',
        tip: 'Mid speed round to Cave can catch CT rotations completely off guard.',
    },
    anubis: {
        name: 'Anubis',
        setting: 'Egyptian ruins',
        side: 'Balanced',
        callouts: 'A Site: Speed, Palace, Fountain, Connector | B Site: Bridge, Water, Hovel, Canal | Mid: Mid, Alley',
        tip: 'Bridge control on B is crucial — it cuts off CT rotation.',
    },
    dust2: {
        name: 'Dust 2',
        setting: 'Middle Eastern town',
        side: 'T-sided',
        callouts: 'A Site: Long, Short, CT, Pit, Ramp | B Site: Tunnels, B Doors, B Platform, Window | Mid: Catwalk, Xbox, Top Mid',
        tip: 'Long A control early game is a huge advantage — commit to it or leave it.',
    },
    vertigo: {
        name: 'Vertigo',
        setting: 'Skyscraper construction',
        side: 'CT-sided',
        callouts: 'A Site: Ramp, Stairs, Scaffolding, A Default | B Site: Elevator, B Corner, B Default | Mid: Mid, Boost',
        tip: 'Elevator mid control gives Ts an info advantage on both sites.',
    },
};

function getCS2MapInfo(mapInput) {
    const key = mapInput.toLowerCase().replace(/[^a-z0-9]/g, '').replace('dust2', 'dust2').replace('dust_2', 'dust2');

    // Try exact key match first, then partial match
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

// --- !cs2case <case name> <count> <case cost> ---
// Simulates opening CS2 cases using Valve's officially disclosed drop rates.
// Rates source: China Ministry of Culture disclosure (2017), verified by community.
//
// Usage:  !cs2case Kilowatt 10 1.50
//   case name  = any string (cosmetic only, used in output)
//   count      = number of cases to open (1–100)
//   case cost  = USD price of the case itself (key is always $2.49)
//
// Drop rate tiers (official Valve odds):
//   Mil-Spec (Blue)    79.92%
//   Restricted (Purple) 15.98%
//   Classified (Pink)   3.20%
//   Covert (Red)        0.64%
//   Knife/Gloves (Gold) 0.26%
//   StatTrak multiplier: ~10% chance on any drop
const CS2_CASE_ODDS = [
    { tier: '🔵 Mil-Spec',   rarity: 'Blue',   chance: 0.7992 },
    { tier: '🟣 Restricted', rarity: 'Purple', chance: 0.1598 },
    { tier: '🩷 Classified', rarity: 'Pink',   chance: 0.0320 },
    { tier: '🔴 Covert',     rarity: 'Red',    chance: 0.0064 },
    { tier: '🟡 Knife/Gloves', rarity: 'Gold', chance: 0.0026 },
];
const CS2_STATTRAK_CHANCE = 0.10; // 10% chance of StatTrak on any drop

function simulateCS2Case(caseName, count, caseCostUSD) {
    // Input validation
    const numCases = Math.min(Math.max(Math.floor(count), 1), CONFIG.CS2_CASE_MAX_OPENS);
    const caseCost = Math.max(parseFloat(caseCostUSD) || 0, 0);
    const keyCost  = CONFIG.CS2_KEY_COST_USD;
    const totalCostPerCase = caseCost + keyCost;
    const totalCost = (totalCostPerCase * numCases).toFixed(2);

    // Simulate each case opening
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

    // Build outcome lines — only show tiers that actually dropped
    const outcomeLines = CS2_CASE_ODDS
        .filter(t => results[t.rarity] > 0)
        .map(t => `${t.tier}: ${results[t.rarity]}x`)
        .join(' | ');

    // Flavor comment based on results
    let flavor = '💀 Rough run — the market is not your friend today.';
    if (results.Gold > 0)  flavor = '🎉 YOU HIT A KNIFE/GLOVES! Screenshot that NOW!';
    else if (results.Red > 0)  flavor = '🔥 A Covert drop?! That\'s actually solid.';
    else if (results.Pink > 0) flavor = '😤 A Classified — not bad, not great.';
    else if (results.Purple >= numCases * 0.3) flavor = '📦 Mostly Restricted. Could be worse... barely.';

    return [
        `📦 **CS2 Case Simulator** — ${caseName} (${numCases} opened)`,
        `💰 Case: $${caseCost.toFixed(2)} + Key: $${keyCost.toFixed(2)} = **$${totalCostPerCase.toFixed(2)}/open** | Total spent: **$${totalCost}**`,
        `📊 Results: ${outcomeLines || 'Nothing notable'}`,
        `🎰 StatTrak drops: ${statTrakCount}`,
        flavor,
    ].join('\n');
}

function parseCS2CaseCommand(args) {
    // Parse: !cs2case <case name (can be multi-word)> <count> <cost>
    // The last two tokens are always count and cost; everything before is the case name.
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
        if (data && data.url && !data.nsfw) {
            return { title: data.title, url: data.url };
        }
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

    // CS2 commands on Twitch
    if (lowerMessage.startsWith('!cs2price ')) {
        const skinName = message.substring(10).trim();
        const result = await getCS2SkinPrice(skinName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!cs2price', skinName, result);
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
            await sendTwitchChunked(channel, `${meme.title} ${meme.url}`);
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
        if (isWildRequest(message)) {
            const response = await getWildRequestResponse(message, 'twitch', channel, tags.username);
            await sendTwitchChunked(channel, response);
            logCommand('twitch', tags.username, 'wild-request', message, response);
        } else {
            const response = await getAIResponse(message, 'twitch', channel, tags.username);
            await sendTwitchChunked(channel, response);
            logCommand('twitch', tags.username, '@mention', message, response);
        }
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
    addToMemory('discord', message.channelId, message.author.username, message.content);
    
    const lowerContent = message.content.toLowerCase();
    
    if (lowerContent.startsWith('!price ')) {
        const itemName = message.content.substring(7);
        const result = await getTarkovPrice(itemName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!price', itemName, result);
        return;
    }
    
    if (lowerContent.startsWith('!bestammo ')) {
        const searchCaliber = message.content.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!bestammo', searchCaliber, result);
        return;
    }
    
    if (lowerContent === '!trader') {
        const result = await getTraderResets();
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!trader', message.content, result);
        return;
    }
    
    if (lowerContent.startsWith('!map ')) {
        const mapName = message.content.substring(5);
        const result = await getMapInfo(mapName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!map', mapName, result);
        return;
    }

    if (lowerContent.startsWith('!player ')) {
        const playerName = message.content.substring(8).trim();
        const result = await getPlayerStats(playerName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!player', playerName, result);
        return;
    }

    // CS2 commands on Discord
    if (lowerContent.startsWith('!cs2price ')) {
        const skinName = message.content.substring(10).trim();
        const result = await getCS2SkinPrice(skinName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!cs2price', skinName, result);
        return;
    }

    if (lowerContent.startsWith('!cs2stats ')) {
        const steamInput = message.content.substring(10).trim();
        const result = await getCS2PlayerStats(steamInput);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!cs2stats', steamInput, result);
        return;
    }

    if (lowerContent.startsWith('!cs2map ')) {
        const mapInput = message.content.substring(8).trim();
        const result = getCS2MapInfo(mapInput);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!cs2map', mapInput, result);
        return;
    }

    if (lowerContent.startsWith('!cs2case ')) {
        const args = message.content.substring(9).trim();
        const parsed = parseCS2CaseCommand(args);
        if (!parsed) {
            const usage = '❌ Usage: `!cs2case <case name> <count> <case cost>`\nExample: `!cs2case Kilowatt 10 1.50`';
            await safeDiscordReply(message, usage);
            logCommand('discord', message.author.username, '!cs2case', args, usage, true);
        } else {
            const result = simulateCS2Case(parsed.caseName, parsed.count, parsed.cost);
            await safeDiscordReply(message, result);
            logCommand('discord', message.author.username, '!cs2case', args, result);
        }
        return;
    }

    if (lowerContent.includes('meme')) {
        const meme = await fetchMeme();
        if (meme) {
            await message.channel.send({ content: meme.title, files: [meme.url] });
            logCommand('discord', message.author.username, 'meme', message.content, meme.title);
        } else {
            const errorMsg = 'Could not fetch a meme right now. Try again later.';
            await safeDiscordSend(message.channel, errorMsg);
            logCommand('discord', message.author.username, 'meme', message.content, errorMsg, true);
        }
        return;
    }
    
    if (message.content.includes(`<@${discordClient.user.id}>`)) {

        if (isWildRequest(message.content)) {
            const response = await getWildRequestResponse(message.content, 'discord', message.channelId, message.author.username);
            await safeDiscordReply(message, response);
            logCommand('discord', message.author.username, 'wild-request', message.content, response);
            return;
        }

        if (detectImageRequest(message.content)) {
            const rateLimit = checkImageRateLimit(message.author.id);
            if (!rateLimit.allowed) {
                const rateLimitMsg = getPersonaErrorMessage('rate_limit')(rateLimit.timeLeft);
                await safeDiscordReply(message, rateLimitMsg);
                logCommand('discord', message.author.username, 'image-rate-limit', message.content, rateLimitMsg);
                return;
            }
            
            try {
                await message.channel.sendTyping();
                console.log('[IMAGE] Processing image request from Discord');
                
                const rawPrompt = extractImagePrompt(message.content);
                const extractedPrompt = sanitizeImagePrompt(rawPrompt);
                const prompt = SELF_REFERENTIAL_PATTERNS.some(p => p.test(message.content.toLowerCase()))
                    ? sanitizeImagePrompt(message.content)
                    : extractedPrompt;

                const typingInterval = setInterval(() => {
                    message.channel.sendTyping().catch(() => {});
                }, 8000);

                let imageData, mimeType;
                try {
                    ({ buffer: imageData, mimeType } = await generateImage(prompt));
                } finally {
                    clearInterval(typingInterval);
                }
                
                const timestamp = Date.now();
                const ext = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
                const filename = `generated_${timestamp}.${ext}`;
                const filepath = path.join(os.tmpdir(), filename);
                
                console.log('[IMAGE] Saving to temp file:', filepath);
                
                fs.writeFileSync(filepath, imageData);
                
                const sentMessage = await message.reply({ 
                    content: `Here's your image for: "${prompt}" 🎨`,
                    files: [filepath]
                });
                
                let imageUrl = null;
                if (sentMessage.attachments.size > 0) {
                    const attachment = sentMessage.attachments.first();
                    imageUrl = attachment.url;
                    console.log('[IMAGE] Discord CDN URL:', imageUrl);
                }
                
                fs.unlinkSync(filepath);
                console.log('[IMAGE] Temp file cleaned up');
                
                logCommand('discord', message.author.username, 'image-gen', prompt, `Image generated: ${imageUrl || 'URL not captured'}`, false, imageUrl);
            } catch (error) {
                console.error('[IMAGE] Error generating image:', error);
                logSystemEvent('ERROR', 'ERROR', 'discord', 'Image generation failed', error);
                const errorMsg = getPersonaErrorMessage('image_gen');
                await safeDiscordReply(message, errorMsg);
                logCommand('discord', message.author.username, 'image-gen-error', message.content, errorMsg, true);
            }
        } else {
            const images = await getImageAttachments(message);
            
            if (images.length > 0) {
                try {
                    await message.channel.sendTyping();
                    console.log(`[IMAGE UNDERSTANDING] Processing ${images.length} image(s) from ${message.author.username}`);
                    
                    const response = await getAIResponse(
                        message.content || "What's in this image?",
                        'discord',
                        message.channelId,
                        message.author.username,
                        images
                    );
                    
                    await safeDiscordReply(message, response);
                    logCommand('discord', message.author.username, 'image-understanding', message.content, response);
                } catch (error) {
                    console.error('[IMAGE UNDERSTANDING] Error:', error);
                    logSystemEvent('ERROR', 'ERROR', 'discord', 'Image understanding failed', error);
                    const errorMsg = getPersonaErrorMessage('image_read');
                    await safeDiscordReply(message, errorMsg);
                    logCommand('discord', message.author.username, 'image-understanding-error', message.content, errorMsg, true);
                }
            } else {
                const response = await getAIResponse(message.content, 'discord', message.channelId, message.author.username);
                await safeDiscordReply(message, response);
                logCommand('discord', message.author.username, '@mention', message.content, response);
            }
        }
    }
    
    else if (hasImageAttachment(message) && message.reference) {
        let repliedToMsg = null;
        try {
            repliedToMsg = await message.channel.messages.fetch(message.reference.messageId);
        } catch (err) {
            if (err.code === 10008) return;
            console.error('[IMAGE UNDERSTANDING REPLY] Fetch error:', err);
            logSystemEvent('ERROR', 'WARNING', 'discord', 'Failed to fetch referenced message', err);
            return;
        }

        if (repliedToMsg.author.id === discordClient.user.id) {
            const images = await getImageAttachments(message);
            
            if (images.length > 0) {
                await message.channel.sendTyping();
                console.log(`[IMAGE UNDERSTANDING] Processing ${images.length} image(s) in reply from ${message.author.username}`);
                
                const response = await getAIResponse(
                    message.content || "What's in this image?",
                    'discord',
                    message.channelId,
                    message.author.username,
                    images
                );
                
                await safeDiscordReply(message, response);
                logCommand('discord', message.author.username, 'image-understanding-reply', message.content, response);
            }
        }
    }
});

// ===== REPLY-TO-BOT HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.reference) return;
    
    let repliedTo;
    try {
        repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    } catch (err) {
        if (err.code === 10008) return;
        console.error('[REPLY-TO-BOT] Fetch error:', err);
        logSystemEvent('ERROR', 'WARNING', 'discord', 'Reply handler: failed to fetch referenced message', err);
        return;
    }

    if (repliedTo.author.id !== discordClient.user.id) return;
    
    console.log(`[REPLY-TO-BOT] ${message.author.username}: ${message.content}`);
    addToMemory('discord', message.channelId, message.author.username, message.content);
    
    const lowerContent = message.content.toLowerCase();
    
    if (lowerContent.startsWith('!price ')) {
        const itemName = message.content.substring(7);
        const result = await getTarkovPrice(itemName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!price-reply', itemName, result);
        return;
    }
    
    if (lowerContent.startsWith('!bestammo ')) {
        const searchCaliber = message.content.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!bestammo-reply', searchCaliber, result);
        return;
    }
    
    if (lowerContent === '!trader') {
        const result = await getTraderResets();
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!trader-reply', message.content, result);
        return;
    }
    
    if (lowerContent.startsWith('!map ')) {
        const mapName = message.content.substring(5);
        const result = await getMapInfo(mapName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!map-reply', mapName, result);
        return;
    }
    
    if (lowerContent.startsWith('!player ')) {
        const playerName = message.content.substring(8).trim();
        const result = await getPlayerStats(playerName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!player-reply', playerName, result);
        return;
    }

    // CS2 commands in reply-to-bot handler
    if (lowerContent.startsWith('!cs2price ')) {
        const skinName = message.content.substring(10).trim();
        const result = await getCS2SkinPrice(skinName);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!cs2price-reply', skinName, result);
        return;
    }

    if (lowerContent.startsWith('!cs2stats ')) {
        const steamInput = message.content.substring(10).trim();
        const result = await getCS2PlayerStats(steamInput);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!cs2stats-reply', steamInput, result);
        return;
    }

    if (lowerContent.startsWith('!cs2map ')) {
        const mapInput = message.content.substring(8).trim();
        const result = getCS2MapInfo(mapInput);
        await safeDiscordReply(message, result);
        logCommand('discord', message.author.username, '!cs2map-reply', mapInput, result);
        return;
    }

    if (lowerContent.startsWith('!cs2case ')) {
        const args = message.content.substring(9).trim();
        const parsed = parseCS2CaseCommand(args);
        if (!parsed) {
            const usage = '❌ Usage: `!cs2case <case name> <count> <case cost>`\nExample: `!cs2case Kilowatt 10 1.50`';
            await safeDiscordReply(message, usage);
            logCommand('discord', message.author.username, '!cs2case-reply', args, usage, true);
        } else {
            const result = simulateCS2Case(parsed.caseName, parsed.count, parsed.cost);
            await safeDiscordReply(message, result);
            logCommand('discord', message.author.username, '!cs2case-reply', args, result);
        }
        return;
    }

    if (isWildRequest(message.content)) {
        const response = await getWildRequestResponse(message.content, 'discord', message.channelId, message.author.username);
        await safeDiscordReply(message, response);
        logCommand('discord', message.author.username, 'wild-request-reply', message.content, response);
        return;
    }
    
    const images = await getImageAttachments(message);
    
    if (images.length > 0) {
        await message.channel.sendTyping();
        console.log(`[IMAGE UNDERSTANDING REPLY] Processing ${images.length} image(s) from ${message.author.username}`);
        
        const response = await getAIResponse(
            message.content || "What's in this image?",
            'discord',
            message.channelId,
            message.author.username,
            images
        );
        
        await safeDiscordReply(message, response);
        logCommand('discord', message.author.username, 'reply-to-bot-with-image', message.content, response);
    } else {
        const response = await getAIResponse(message.content, 'discord', message.channelId, message.author.username);
        await safeDiscordReply(message, response);
        logCommand('discord', message.author.username, 'reply-to-bot', message.content, response);
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
  let server1Active = false;
  let server2Active = false;

  try {
    const { db } = require('./database.js');

    const row1 = db.prepare("SELECT value FROM bot_data WHERE key = 'cultist_server1_active'").get();
    const row2 = db.prepare("SELECT value FROM bot_data WHERE key = 'cultist_server2_active'").get();

    server1Active = row1?.value === '1' || row1?.value === 'true';
    server2Active = row2?.value === '1' || row2?.value === 'true';

    console.log(`[CULTIST CHECK] Server1: ${server1Active}, Server2: ${server2Active}`);
  } catch (err) {
    console.error('[CULTIST] DB read error:', err.message);
    return;
  }

  const channel = discordClient.channels.cache.get(CULTIST_CONFIG.CHANNEL_ID);
  if (!channel) {
    console.log('[CULTIST] Channel not found');
    return;
  }

  if (server1Active && !lastCultistStates.server1.active) {
    await safeDiscordSend(channel, '🔴 **CULTIST ALERT** — Server 1: Cultists are active! 🔪');
    logSystemEvent('CULTIST', 'INFO', 'monitor', 'Server 1 cultists went active');
  } else if (!server1Active && lastCultistStates.server1.active) {
    await safeDiscordSend(channel, '✅ **Cultists cleared** — Server 1 is safe.');
    logSystemEvent('CULTIST', 'INFO', 'monitor', 'Server 1 cultists cleared');
  }

  if (server2Active && !lastCultistStates.server2.active) {
    await safeDiscordSend(channel, '🔴 **CULTIST ALERT** — Server 2: Cultists are active! 🔪');
    logSystemEvent('CULTIST', 'INFO', 'monitor', 'Server 2 cultists went active');
  } else if (!server2Active && lastCultistStates.server2.active) {
    await safeDiscordSend(channel, '✅ **Cultists cleared** — Server 2 is safe.');
    logSystemEvent('CULTIST', 'INFO', 'monitor', 'Server 2 cultists cleared');
  }

  lastCultistStates.server1.active = server1Active;
  lastCultistStates.server2.active = server2Active;
}

discordClient.once('ready', () => {
    setInterval(checkCultistActivity, CULTIST_CONFIG.CHECK_INTERVAL_MS);
    console.log('[CULTIST] Monitoring started');
    logSystemEvent('STARTUP', 'INFO', 'cultist', 'Cultist monitoring started');
});

// ===== EXPORT SYSTEM BRIDGE =====
if (global.setDiscordClientForExport) {
    global.setDiscordClientForExport(discordClient);
    console.log('[EXPORT] Discord client registered for export system');
    logSystemEvent('STARTUP', 'INFO', 'export', 'Discord client registered for export system');
}

// ===== DISCORD LOGIN =====
discordClient.login(process.env.DISCORD_TOKEN).then(() => {
    if (global.setDiscordClientForExport) {
        global.setDiscordClientForExport(discordClient);
        console.log('[EXPORT] Discord client registered post-login');
    }
}).catch((error) => {
    console.error('[DISCORD LOGIN ERROR]', error);
    logSystemEvent('CONNECTION', 'ERROR', 'discord', 'Failed to login to Discord', error);
    process.exit(1);
});

setTimeout(() => {
    logSystemEvent('STARTUP', 'INFO', 'system', '✅ Bot fully initialized and running');
}, 5000);
