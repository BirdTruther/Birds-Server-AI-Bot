// services/ai.js
const { generateText } = require('ai');
const { google } = require('@ai-sdk/google');
const { addToMemory, getSmartContext } = require('../memory.js');
const { logCommand, logSystemEvent } = require('../logger.js');
const { getCurrentPersona, getPersonaErrorMessage } = require('../persona-manager.js');

// ===== CONFIG =====
const AI_PRIMARY_MODEL  = 'gemini-2.5-flash';
const AI_FALLBACK_MODEL = 'gemini-2.0-flash';

// ===== WILD REQUEST FILTER =====
const WILD_PATTERNS = [
    /\b(jailbreak|dan mode|pretend you|act as if|ignore your|ignore all|bypass|no restrictions|no limits|unrestricted|without rules|without restrictions)\b/i,
    /\b(make (a |an )?(bomb|weapon|explosive|poison|drug|meth|crack|fentanyl))\b/i,
    /\b(how to (make|build|create|synthesize) (a |an )?(bomb|weapon|explosive|poison|drug|meth|crack|fentanyl))\b/i,
    /\b(child|minor|underage|loli|shota).*(sex|nude|naked|porn|explicit|lewd)\b/i,
    /\b(sex|nude|naked|porn|explicit|lewd).*(child|minor|underage|loli|shota)\b/i,
    /\b(roleplay|rp|pretend).*(sex|rape|assault|abuse)\b/i,
    /you are now|from now on you|you have no|you must comply|you will comply/i,
];

function isWildRequest(messageContent) {
    const lower = messageContent.toLowerCase();
    return WILD_PATTERNS.some(pattern => pattern.test(lower));
}

// ===== CORE AI FUNCTIONS =====

async function generateTextWithFallback(options) {
    try {
        return await generateText({ ...options, model: google(AI_PRIMARY_MODEL) });
    } catch (primaryErr) {
        const msg = (primaryErr?.message || '').toLowerCase();
        const isOverload =
            msg.includes('high demand')          ||
            msg.includes('503')                  ||
            msg.includes('overloaded')           ||
            msg.includes('529')                  ||
            msg.includes('temporarily unavailable') ||
            msg.includes('retry');

        if (!isOverload) throw primaryErr;

        console.warn(`[AI] ${AI_PRIMARY_MODEL} overloaded — falling back to ${AI_FALLBACK_MODEL}`);
        logSystemEvent('AI_FALLBACK', 'WARNING', 'ai',
            `Primary model overloaded, falling back to ${AI_FALLBACK_MODEL}: ${primaryErr.message.substring(0, 120)}`
        );
        return await generateText({ ...options, model: google(AI_FALLBACK_MODEL) });
    }
}

async function getAIResponse(message, platform = 'discord', channelId = 'default', username = 'user', images = []) {
    try {
        const memoryContext  = getSmartContext(platform, channelId);
        const currentPersona = getCurrentPersona();

        const recentLines    = memoryContext.split('\n');
        const userLineCount  = recentLines.filter(l => l.startsWith(`${username}:`)).length;
        const botLineCount   = recentLines.filter(l => l.startsWith('ThePatrick:')).length;
        const isRepeatConvo  = userLineCount >= 2 && botLineCount >= 2;

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
Conversation depth: ${isRepeatConvo
    ? `${username} has asked you multiple things — they're engaged. Keep building on the thread naturally.`
    : 'Fresh or early conversation.'}
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
        console.log(`[AI] Primary model: ${AI_PRIMARY_MODEL} (fallback: ${AI_FALLBACK_MODEL})`);

        const userContent = [{ type: 'text', text: message }];
        if (images && images.length > 0) {
            for (const image of images) userContent.push({ type: 'image', image: image.buffer });
        }

        const { text } = await generateTextWithFallback({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userContent  },
            ]
        });

        console.log('[AI Response]', text);
        addToMemory(platform, channelId, 'ThePatrick', text, true);
        return text;
    } catch (error) {
        console.error('[AI Error]', error);
        logSystemEvent('AI_ERROR', 'ERROR', 'ai', `AI response failed: ${error.message}`, error);
        return getPersonaErrorMessage('general');
    }
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
                { role: 'user',   content: messageText  },
            ]
        });
        addToMemory(platform, channelId, 'ThePatrick', text, true);
        logSystemEvent('INFO', 'INFO', 'filter', `Wild request roasted for ${username}: ${text.substring(0, 100)}`);
        return text;
    } catch (error) {
        console.error('[WILD FILTER] Roast generation failed:', error);
        logSystemEvent('FILTER_ERROR', 'WARNING', 'filter', `Wild request roast failed for ${username}`, error);
        return getPersonaErrorMessage('general');
    }
}

// ===== EXPORTS =====
module.exports = {
    generateTextWithFallback,
    getAIResponse,
    getWildRequestResponse,
    isWildRequest,
};