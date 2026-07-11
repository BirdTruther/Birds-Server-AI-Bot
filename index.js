// BIRDS-SERVER-AI-BOT
// Discord + Twitch Multi-Platform Bot with AI, Tarkov & CS2 Integration

// ===== DEPENDENCIES =====
const { Client, Events, GatewayIntentBits, AttachmentBuilder, REST, Routes, ActivityType } = require('discord.js');
require('dotenv').config();

// Core modules
const { addToMemory } = require('./memory.js');
const { logCommand, logSystemEvent } = require('./logger.js');
const { getSetting, setSetting } = require('./database.js');
const { musicSlashCommandDefs, handleMusicInteraction } = require('./music.js');

// Services
const { getAIResponse, isWildRequest, getWildRequestResponse } = require('./services/ai.js');
const { generateImage, detectImageRequest, sanitizeImagePrompt, checkImageRateLimit } = require('./services/image.js');
require('./services/twitch.js'); // self-initializing — connects on require

// Command modules
const utilityCommands = require('./commands/utility.js');
const adminCommands   = require('./commands/admin.js');
const cs2Commands     = require('./commands/cs2.js');
const tarkovCommands  = require('./commands/tarkov.js');

// Discord-only helpers (live in utility.js)
const {
    hasImageAttachment,
    getImageAttachments,
    extractImagePrompt,
    safeDiscordReply,
    safeDiscordSend,
} = require('./commands/utility.js');

// ===== GLOBAL STARTUP LOG =====
logSystemEvent('STARTUP', 'INFO', 'system', '🚀 Bot starting up...');

// ===== TOP-LEVEL UNHANDLED REJECTION GUARD =====
// Prevents a single bad interaction from crashing the entire process.
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
    logSystemEvent('UNHANDLED_REJECTION', 'ERROR', 'system', String(reason?.message ?? reason));
});

// ===== CONFIG =====
const CONFIG = {
    PRESENCE_ROTATE_MS: 5 * 60 * 1000,
};

// ===== ROTATING PRESENCE =====
const PRESENCE_ACTIVITIES = [
    { name: 'Escape From Tarkov',                 type: ActivityType.Playing },
    { name: 'The Flea Market',                     type: ActivityType.Watching },
    { name: 'for Cultists in the dark...',         type: ActivityType.Watching },
    { name: 'stash management',                    type: ActivityType.Playing },
    { name: 'Counter-Strike 2 | Premier Mirage',  type: ActivityType.Playing },
    { name: 'CS2 Case Openings',                   type: ActivityType.Watching },
    { name: 'Mirage mid control',                  type: ActivityType.Watching },
    { name: 'the stream', type: ActivityType.Streaming, url: 'https://twitch.tv/' + (process.env.TWITCH_CHANNEL || 'twitch') },
    { name: 'Twitch chat chaos',                   type: ActivityType.Watching },
    { name: 'your commands',                       type: ActivityType.Listening },
    { name: 'over the server',                     type: ActivityType.Watching },
    { name: 'Barbie Dreamhouse',                   type: ActivityType.Playing },
    { name: 'Addict by Pinkii',                    type: ActivityType.Listening },
    { name: 'For news about Vantas',               type: ActivityType.Watching },
];

let presenceIndex = 0;

function rotatePresence(client) {
    const activity = PRESENCE_ACTIVITIES[presenceIndex % PRESENCE_ACTIVITIES.length];
    client.user.setPresence({ activities: [activity], status: 'online' });
    logSystemEvent('PRESENCE', 'INFO', 'discord', `Activity set to [${ActivityType[activity.type]}] ${activity.name}`);
    presenceIndex++;
}

// ===== BUILD COMMAND MAP =====
// Merge all command modules into one flat map: name -> { data, execute }
const allCommands = {
    ...utilityCommands.commands,
    ...adminCommands.commands,
    ...cs2Commands.commands,
    ...tarkovCommands.commands,
};

// ===== DISCORD CLIENT =====
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
    ],
});

// ===== CLIENT READY =====
discordClient.once(Events.ClientReady, async (client) => {
    logSystemEvent('DISCORD_READY', 'INFO', 'discord', `✅ Logged in as ${client.user.tag}`);
    console.log(`✅ Discord ready: ${client.user.tag}`);

    // Register slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const slashDefs = [
            ...Object.values(allCommands).map(cmd => cmd.data.toJSON()),
            ...musicSlashCommandDefs.map(def => def.toJSON()),
        ];
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, process.env.DISCORD_GUILD_ID),
            { body: slashDefs }
        );
        logSystemEvent('SLASH_REGISTER', 'INFO', 'discord', `Registered ${slashDefs.length} slash commands`);
        console.log(`✅ Registered ${slashDefs.length} slash commands`);
    } catch (err) {
        console.error('[SLASH REGISTER ERROR]', err);
        logSystemEvent('SLASH_REGISTER_ERROR', 'ERROR', 'discord', `Slash registration failed: ${err.message}`);
    }

    // Start presence rotation
    rotatePresence(client);
    setInterval(() => rotatePresence(client), CONFIG.PRESENCE_ROTATE_MS);
});

// ===== SLASH COMMAND HANDLER =====
discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // ── Music commands go FIRST, before any deferReply ──
    // handleMusicInteraction manages its own deferReply internally.
    // If it returns true, the command was handled — bail out immediately.
    try {
        if (await handleMusicInteraction(interaction)) return;
    } catch (err) {
        console.error('[MUSIC ERROR]', err);
        logSystemEvent('MUSIC_ERROR', 'ERROR', 'discord', `Music command failed: ${err.message}`);
        // Attempt a reply if the interaction hasn't been replied to yet
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Music command failed.', ephemeral: true });
            } else {
                await interaction.editReply('❌ Music command failed.');
            }
        } catch (_) {}
        return;
    }

    // ── All other (non-music) commands go through deferReply ──
    try {
        await interaction.deferReply();
    } catch (err) {
        // If deferReply itself fails (e.g. interaction already expired), bail silently
        console.error(`[DEFER ERROR] /${commandName}:`, err);
        return;
    }

    const cmd = allCommands[commandName];
    if (cmd) {
        try {
            await cmd.execute(interaction);
        } catch (err) {
            console.error(`[COMMAND ERROR] /${commandName}:`, err);
            logSystemEvent('COMMAND_ERROR', 'ERROR', 'discord', `/${commandName} failed: ${err.message}`);
            try { await interaction.editReply('❌ Something went wrong. Try again.'); } catch (_) {}
        }
        return;
    }

    await interaction.editReply(`❌ Unknown command: \`/${commandName}\``);
});

// ===== DISCORD MESSAGE HANDLER (non-reply messages) =====
// Prefix commands removed — all commands are slash commands only.
// This handler only processes @mentions and image attachments.
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.reference)  return; // replies handled below

    const channelId = message.channelId;
    const username  = message.author.username;

    // Only care if the bot is @mentioned
    if (!message.mentions.has(discordClient.user)) return;

    addToMemory('discord', channelId, username, message.content);
    console.log(`[DISCORD] ${username}: ${message.content}`);

    const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!userMessage && !hasImageAttachment(message)) return;

    // Wild request filter
    if (isWildRequest(userMessage)) {
        const roast = await getWildRequestResponse(userMessage, 'discord', channelId, username);
        await safeDiscordReply(message, roast);
        logCommand('discord', username, '@mention (wild)', userMessage, roast);
        return;
    }

    // Image generation request
    if (detectImageRequest(userMessage)) {
        const rateCheck = checkImageRateLimit(message.author.id);
        if (!rateCheck.allowed) {
            await safeDiscordReply(message, `⏳ Rate limit hit. Try again in ${rateCheck.timeLeft} minute(s).`);
            return;
        }
        const cleanPrompt = sanitizeImagePrompt(extractImagePrompt(userMessage));
        logCommand('discord', username, '@mention (image)', cleanPrompt, '[generating...]');
        try {
            await message.channel.sendTyping();
            const { buffer, mimeType } = await generateImage(cleanPrompt);
            const ext        = mimeType.split('/')[1] || 'png';
            const attachment = new AttachmentBuilder(buffer, { name: `generated.${ext}` });
            await message.reply({ files: [attachment] });
        } catch (imgErr) {
            await safeDiscordReply(message, `❌ Image generation failed: ${imgErr.message}`);
        }
        return;
    }

    // Image attachment analysis
    if (hasImageAttachment(message)) {
        const images   = await getImageAttachments(message);
        const response = await getAIResponse(userMessage || 'What do you see?', 'discord', channelId, username, images);
        await safeDiscordReply(message, response);
        logCommand('discord', username, '@mention (image analysis)', userMessage, response);
        return;
    }

    // Standard AI response
    const response = await getAIResponse(userMessage, 'discord', channelId, username);
    await safeDiscordReply(message, response);
    logCommand('discord', username, '@mention', userMessage, response);
});

// ===== DISCORD REPLY HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot)  return;
    if (!message.reference)  return;

    const channelId = message.channelId;
    const username  = message.author.username;

    // Only respond if the replied-to message is from the bot
    let repliedTo;
    try { repliedTo = await message.fetchReference(); } catch { return; }
    if (repliedTo.author.id !== discordClient.user.id) return;

    addToMemory('discord', channelId, username, message.content);
    console.log(`[DISCORD REPLY] ${username}: ${message.content}`);

    const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!userMessage && !hasImageAttachment(message)) return;

    // Wild request filter
    if (isWildRequest(userMessage)) {
        const roast = await getWildRequestResponse(userMessage, 'discord', channelId, username);
        await safeDiscordReply(message, roast);
        logCommand('discord', username, 'reply (wild)', userMessage, roast);
        return;
    }

    // Image attachment in reply
    if (hasImageAttachment(message)) {
        const images   = await getImageAttachments(message);
        const response = await getAIResponse(userMessage || 'What do you see?', 'discord', channelId, username, images);
        await safeDiscordReply(message, response);
        logCommand('discord', username, 'reply (image analysis)', userMessage, response);
        return;
    }

    // Standard reply AI response
    const response = await getAIResponse(userMessage, 'discord', channelId, username);
    await safeDiscordReply(message, response);
    logCommand('discord', username, 'reply', userMessage, response);
});

// ===== LOGIN =====
discordClient.login(process.env.DISCORD_TOKEN)
    .then(() => logSystemEvent('LOGIN', 'INFO', 'discord', 'Discord login successful'))
    .catch(err => {
        console.error('[LOGIN ERROR]', err);
        logSystemEvent('LOGIN_ERROR', 'ERROR', 'discord', `Discord login failed: ${err.message}`);
        process.exit(1);
    });
