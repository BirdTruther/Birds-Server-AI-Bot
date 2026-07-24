// commands/utility.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { addToMemory, clearChannelMemory } = require('../memory.js');
const { logCommand, logSystemEvent } = require('../logger.js');
const { getCurrentPersona, getPersonaErrorMessage, setPersona, getAvailablePersonas } = require('../persona-manager.js');
const { getAIResponse, isWildRequest, getWildRequestResponse } = require('../services/ai.js');
const { generateImage, detectImageRequest, sanitizeImagePrompt } = require('../services/image.js');

// ===== CONFIG =====
const GITHUB_URL = 'https://github.com/BirdTruther';

// ===== PERSONA HELPERS =====

function buildPersonaList() {
    const keys    = getAvailablePersonas();
    const current = getCurrentPersona();
    return keys
        .map(key => key === current.name ? `**${key}** (active)` : key)
        .join(', ');
}

function applyPersona(name) {
    const success = setPersona(name);
    if (success) return `✅ Persona switched to **${name}**.`;
    const available = getAvailablePersonas().join(', ');
    return `❌ Unknown persona "${name}". Available: ${available}`;
}

// ===== MEME FETCHER =====

async function fetchMeme() {
    try {
        const response = await fetch('https://meme-api.com/gimme');
        const data = await response.json();
        if (data?.url && !data.nsfw) return { title: data.title, url: data.url };
        return null;
    } catch (error) {
        console.error('[Meme Fetch Error]', error);
        logSystemEvent('MEME_ERROR', 'WARNING', 'meme', 'Meme fetch failed', error);
        return null;
    }
}

// ===== IMAGE PROMPT EXTRACTOR =====

const IMAGE_PROMPT_TRIGGERS = [
    'generate image of', 'create image of', 'make image of',
    'generate a image of', 'create a image of', 'make a image of',
    'generate an image of', 'create an image of', 'make an image of',
    'generate picture of', 'create picture of', 'make picture of',
    'show me a picture of', 'show me an image of',
    'draw me a', 'draw me an', 'paint me a', 'paint me an',
    'generate image', 'create image', 'make image',
    'image of', 'picture of', 'photo of',
    'imagine what', 'imagine',
];

function extractImagePrompt(messageContent) {
    let prompt = messageContent.replace(/<@[!&]?\d+>/g, '').trim();

    const prefixes = ['!image', '!img', '!generate', '!draw', '!art'];
    for (const prefix of prefixes) {
        if (prompt.toLowerCase().startsWith(prefix)) {
            prompt = prompt.substring(prefix.length).trim();
            break;
        }
    }

    const lower = prompt.toLowerCase();
    for (const trigger of IMAGE_PROMPT_TRIGGERS) {
        if (lower.startsWith(trigger)) {
            prompt = prompt.substring(trigger.length).trim();
            break;
        }
    }

    return prompt || 'a cool image';
}

// ===== IMAGE ATTACHMENT UTILITIES =====

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

// Derive a safe file extension from a MIME type string.
// Gemini returns types like 'image/png', 'image/jpeg', 'image/webp'.
function mimeToExt(mimeType) {
    if (!mimeType) return 'png';
    const sub = mimeType.split('/')[1] || 'png';
    // Normalise 'jpeg' → 'jpg' for friendlier filenames
    return sub === 'jpeg' ? 'jpg' : sub;
}

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
        if (
            attachment.contentType?.startsWith('image/') ||
            /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.name || '')
        ) {
            try {
                const headRes       = await fetch(attachment.url, { method: 'HEAD' });
                const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
                if (contentLength > MAX_IMAGE_BYTES) {
                    console.warn(`[IMAGE] "${attachment.name}" is ${(contentLength / 1024 / 1024).toFixed(1)}MB — over limit, skipping.`);
                    logSystemEvent('IMAGE_SKIP', 'WARNING', 'image',
                        `Attachment "${attachment.name}" skipped: ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
                    continue;
                }
                const response      = await fetch(attachment.url);
                const arrayBuffer   = await response.arrayBuffer();
                images.push({
                    buffer:      Buffer.from(arrayBuffer),
                    contentType: attachment.contentType || 'image/jpeg',
                    name:        attachment.name,
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
        logSystemEvent('DISCORD_ERROR', 'WARNING', 'discord', 'Safe reply failed', error);
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
        logSystemEvent('DISCORD_ERROR', 'WARNING', 'discord', 'Safe send failed', error);
    }
}

// ===== SLASH COMMAND DEFINITIONS =====

const commands = {
    meme: {
        data: new SlashCommandBuilder()
            .setName('meme')
            .setDescription('Get a random meme'),

        async execute(interaction) {
            const meme   = await fetchMeme();
            const result = meme
                ? `**${meme.title}**\n${meme.url}`
                : "Couldn't fetch a meme right now. Try again!";
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/meme', '', result);
        }
    },

    code: {
        data: new SlashCommandBuilder()
            .setName('code')
            .setDescription('Get the GitHub link'),

        async execute(interaction) {
            const result = `Check out my code! 🤖 ${GITHUB_URL}`;
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/code', '', result);
        }
    },

    persona: {
        data: new SlashCommandBuilder()
            .setName('persona')
            .setDescription('Switch the bot persona')
            .addStringOption(o =>
                o.setName('name').setDescription('Persona name').setRequired(true)
            ),

        async execute(interaction) {
            const name   = interaction.options.getString('name');
            const result = applyPersona(name);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/persona', name, result);
        }
    },

    personas: {
        data: new SlashCommandBuilder()
            .setName('personas')
            .setDescription('List all available personas'),

        async execute(interaction) {
            const result = `Available personas: ${buildPersonaList()}`;
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/personas', '', result);
        }
    },

    clearmemory: {
        data: new SlashCommandBuilder()
            .setName('clearmemory')
            .setDescription('Clear AI conversation memory for this channel'),

        async execute(interaction) {
            clearChannelMemory('discord', interaction.channelId);
            await interaction.editReply('🧹 Memory cleared for this channel.');
            logCommand('discord', interaction.user.username, '/clearmemory', '', 'Memory cleared');
        }
    },

    ask: {
        data: new SlashCommandBuilder()
            .setName('ask')
            .setDescription('Ask the AI a question')
            .addStringOption(o =>
                o.setName('question').setDescription('Your question').setRequired(true)
            ),

        async execute(interaction) {
            const question  = interaction.options.getString('question');
            const username  = interaction.user.username;
            const channelId = interaction.channelId;

            addToMemory('discord', channelId, username, question);

            if (isWildRequest(question)) {
                const roast = await getWildRequestResponse(question, 'discord', channelId, username);
                await interaction.editReply(roast);
                logCommand('discord', username, '/ask (wild)', question, roast);
                return;
            }

            const response = await getAIResponse(question, 'discord', channelId, username);
            await interaction.editReply(response);
            logCommand('discord', username, '/ask', question, response);
        }
    },

    imagine: {
        data: new SlashCommandBuilder()
            .setName('imagine')
            .setDescription('Generate an image with AI')
            .addStringOption(o =>
                o.setName('prompt').setDescription('Image description').setRequired(true)
            ),

        async execute(interaction) {
            const prompt   = interaction.options.getString('prompt');
            const username = interaction.user.username;

            const cleanPrompt = sanitizeImagePrompt(extractImagePrompt(prompt));

            logCommand('discord', username, '/imagine', cleanPrompt, '[generating...]');

            const result = await generateImage(cleanPrompt, interaction.user.id, {
                enhance:  true,
                platform: 'discord',
            });

            if (!result.success) {
                await interaction.editReply(result.error);
                logCommand('discord', username, '/imagine', cleanPrompt, `[failed: ${result.error}]`);
                return;
            }

            const ext     = mimeToExt(result.mimeType);
            const tmpFile = path.join(os.tmpdir(), `imagine_${Date.now()}_${interaction.user.id}.${ext}`);

            // Write the buffer to a temp file so we can pass fs.createReadStream
            // to AttachmentBuilder. A file-backed ReadStream forces undici to open
            // a brand-new TLS socket for the multipart POST instead of reusing the
            // stale keep-alive connection that Discord's CDN closed server-side
            // between deferReply and the upload. Readable.from(buffer) does NOT
            // escape the connection pool — only a file descriptor does.
            await fs.promises.writeFile(tmpFile, result.buffer);

            try {
                const attachment = new AttachmentBuilder(
                    fs.createReadStream(tmpFile),
                    { name: `generated.${ext}` }
                );

                // editReply first (text only) so Discord marks the interaction
                // as responded and doesn't show "interaction failed".
                await interaction.editReply(`🎨 **Prompt:** ${result.finalPrompt.substring(0, 200)}`);

                // followUp carries the file on a completely independent webhook
                // POST, further decoupling the file upload from the interaction
                // reply lifecycle.
                await interaction.followUp({ files: [attachment] });

            } finally {
                // Clean up temp file regardless of success or failure.
                fs.unlink(tmpFile, err => {
                    if (err) console.warn(`[Image] Failed to delete temp file ${tmpFile}:`, err.message);
                });
            }

            logCommand('discord', username, '/imagine', cleanPrompt, `[image generated — ${result.buffer.length} bytes, ${result.mimeType}]`);
        }
    },
};

// ===== EXPORTS =====
module.exports = {
    commands,
    // Discord message handler helpers
    hasImageAttachment,
    getImageAttachments,
    extractImagePrompt,
    safeDiscordReply,
    safeDiscordSend,
};
