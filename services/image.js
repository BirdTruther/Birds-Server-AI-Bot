// services/image.js
const { generateText } = require('ai');
const { google } = require('@ai-sdk/google');
const Replicate = require('replicate');
const { logCommand, logSystemEvent } = require('../logger.js');
const { generateTextWithFallback } = require('./ai.js');

// ===== CONFIG =====
const IMAGE_RATE_LIMIT_MAX      = 3;   // max generates per window
const IMAGE_RATE_LIMIT_WINDOW   = 60;  // seconds
const IMAGE_MAX_PROMPT_LENGTH   = 500;
const IMAGE_MODEL               = 'black-forest-labs/flux-schnell';

// ===== RATE LIMIT STORE =====
// Map<userId, { count: number, windowStart: number }>
const imageRateLimitStore = new Map();

// Prune stale rate limit entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of imageRateLimitStore) {
        if (now - data.windowStart > IMAGE_RATE_LIMIT_WINDOW * 1000) {
            imageRateLimitStore.delete(userId);
        }
    }
}, 10 * 60 * 1000);

// ===== IMAGE KEYWORD DETECTION =====
const IMAGE_TRIGGER_PATTERNS = [
    /\b(draw|paint|sketch|illustrate|generate|create|make|show)\s+(me\s+)?(a\s+|an\s+|the\s+)?(picture|image|photo|artwork|illustration|drawing|painting|portrait|wallpaper|scene|art)\b/i,
    /\b(picture|image|photo|artwork|illustration|drawing|painting)\s+of\b/i,
    /\bcan you (draw|paint|illustrate|generate|create|make|visualize)\b/i,
    /\bgenerate\s+(a\s+|an\s+)?(image|picture|photo|artwork|illustration)\b/i,
    /\bshow\s+me\s+(what|how|a|an|the)\b/i,
];

function detectImageRequest(messageText) {
    return IMAGE_TRIGGER_PATTERNS.some(pattern => pattern.test(messageText));
}

// ===== PROMPT SANITIZATION =====
const NSFW_TERMS = [
    'nude', 'naked', 'nsfw', 'explicit', 'porn', 'hentai', 'sexual',
    'genitals', 'breasts', 'topless', 'xxx', 'erotic', 'lewd',
    'underage', 'child', 'minor', 'loli', 'shota',
    'gore', 'graphic violence', 'mutilation', 'torture',
];

const NSFW_REPLACEMENTS = {
    'nude':      'clothed person',
    'naked':     'clothed person',
    'nsfw':      'appropriate',
    'explicit':  'tasteful',
    'gore':      'peaceful scene',
    'violence':  'calm scene',
};

function sanitizeImagePrompt(prompt) {
    let sanitized = prompt.substring(0, IMAGE_MAX_PROMPT_LENGTH);

    for (const term of NSFW_TERMS) {
        const replacement = NSFW_REPLACEMENTS[term] || '';
        sanitized = sanitized.replace(new RegExp(`\\b${term}\\b`, 'gi'), replacement);
    }

    // Collapse any double spaces from removals
    sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();

    return sanitized;
}

// ===== RATE LIMIT CHECK =====
function checkImageRateLimit(userId) {
    const now  = Date.now();
    const data = imageRateLimitStore.get(userId);

    if (!data || (now - data.windowStart) > IMAGE_RATE_LIMIT_WINDOW * 1000) {
        // Fresh window
        imageRateLimitStore.set(userId, { count: 1, windowStart: now });
        return { allowed: true, remaining: IMAGE_RATE_LIMIT_MAX - 1 };
    }

    if (data.count >= IMAGE_RATE_LIMIT_MAX) {
        const secondsLeft = Math.ceil(IMAGE_RATE_LIMIT_WINDOW - (now - data.windowStart) / 1000);
        return { allowed: false, secondsLeft, remaining: 0 };
    }

    data.count++;
    imageRateLimitStore.set(userId, data);
    return { allowed: true, remaining: IMAGE_RATE_LIMIT_MAX - data.count };
}

// ===== PROMPT ENHANCEMENT =====
async function enhanceImagePrompt(rawPrompt) {
    try {
        const { text } = await generateTextWithFallback({
            messages: [
                {
                    role: 'system',
                    content: `You are an expert at writing image generation prompts for Flux (a diffusion model).
Take the user's simple request and expand it into a rich, detailed prompt.
Rules:
- Add art style, lighting, mood, camera angle if they make sense
- Keep it under 150 words
- Do NOT add anything NSFW or that violates content policy
- Return ONLY the improved prompt, no explanation, no quotes`,
                },
                { role: 'user', content: rawPrompt },
            ],
        });
        console.log(`[Image] Prompt enhanced: "${rawPrompt}" → "${text.substring(0, 80)}..."`);
        return text.trim();
    } catch (error) {
        // If enhancement fails, just use the raw prompt — don't block image generation
        console.warn('[Image] Prompt enhancement failed, using raw prompt:', error.message);
        return rawPrompt;
    }
}

// ===== CORE IMAGE GENERATION =====
async function generateImage(prompt, userId = 'unknown', options = {}) {
    const { enhance = true, platform = 'discord' } = options;

    // 1. Rate limit check
    const rateCheck = checkImageRateLimit(userId);
    if (!rateCheck.allowed) {
        return {
            success: false,
            error: `⏳ You're generating images too fast! Try again in **${rateCheck.secondsLeft}s**.`,
        };
    }

    // 2. Sanitize
    const sanitized = sanitizeImagePrompt(prompt);
    if (!sanitized || sanitized.length < 3) {
        return { success: false, error: '❌ Prompt was empty after filtering. Try describing something different.' };
    }

    // 3. Optionally enhance the prompt via AI
    const finalPrompt = enhance ? await enhanceImagePrompt(sanitized) : sanitized;

    // 4. Generate
    try {
        console.log(`[Image] Generating for ${userId} on ${platform} — prompt: "${finalPrompt.substring(0, 80)}..."`);
        logSystemEvent('IMAGE_GENERATE', 'INFO', 'image', `Generating image for ${userId}: "${finalPrompt.substring(0, 80)}"`);

        const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

        const output = await replicate.run(IMAGE_MODEL, {
            input: {
                prompt: finalPrompt,
                num_outputs: 1,
                output_format: 'webp',
                output_quality: 80,
            },
        });

        const imageUrl = Array.isArray(output) ? output[0] : output;

        if (!imageUrl) {
            throw new Error('Replicate returned no output URL');
        }

        // Fetch the image as a buffer for Discord attachment
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image buffer: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());

        console.log(`[Image] Success — ${buffer.length} bytes`);
        logSystemEvent('IMAGE_SUCCESS', 'INFO', 'image', `Image generated for ${userId} — ${buffer.length} bytes`);

        return {
            success:       true,
            buffer,
            imageUrl,
            finalPrompt,
            originalPrompt: prompt,
            remaining:     rateCheck.remaining,
        };

    } catch (error) {
        console.error('[Image Generation Error]', error);
        logSystemEvent('IMAGE_ERROR', 'ERROR', 'image', `Image generation failed for ${userId}: ${error.message}`, error);

        // Friendly error messages based on failure type
        let friendlyError = '❌ Image generation failed. Try again in a moment.';
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('nsfw') || msg.includes('safety'))    friendlyError = '🚫 That prompt triggered the content filter. Try describing something different.';
        if (msg.includes('rate limit') || msg.includes('429')) friendlyError = '⏳ Replicate is rate limiting us. Try again in ~30 seconds.';
        if (msg.includes('timeout') || msg.includes('timed'))  friendlyError = '⌛ Image generation timed out. Try a simpler prompt.';
        if (msg.includes('token') || msg.includes('auth'))     friendlyError = '🔑 API authentication error. Contact the server admin.';

        return { success: false, error: friendlyError };
    }
}

// ===== EXPORTS =====
module.exports = {
    generateImage,
    checkImageRateLimit,
    detectImageRequest,
    sanitizeImagePrompt,
    enhanceImagePrompt,
};