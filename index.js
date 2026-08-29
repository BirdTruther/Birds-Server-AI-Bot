// BIRDS-SERVER-AI-BOT
// Discord + Twitch Multi-Platform Bot with AI, Tarkov & CS2 Integration

// ===== DEPENDENCIES =====
const { Client, Events, GatewayIntentBits, AttachmentBuilder, REST, Routes, ActivityType } = require('discord.js');
require('dotenv').config();

// Core modules
const { addToMemory, getContextFacts } = require('./memory.js');
const { logCommand, logSystemEvent } = require('./logger.js');
const { getSetting, setSetting } = require('./database.js');
const { musicSlashCommandDefs, handleMusicInteraction } = require('./music.js');
const { isHated, getHatedUserIds, getHateChannelId, buildHateJab, buildCallout, canPing, isOnPingCooldown } = require('./hate-manager.js');

// Services
const { getAIResponse, isWildRequest, getWildRequestResponse, generateHateRoast, consolidateChannelFacts } = require('./services/ai.js');
const { generateImage, detectImageRequest, sanitizeImagePrompt, checkImageRateLimit } = require('./services/image.js');
require('./services/twitch.js'); // self-initializing — connects on require

// Command modules
const utilityCommands = require('./commands/utility.js');
const adminCommands   = require('./commands/admin.js');
const cs2Commands     = require('./commands/cs2.js');
const tarkovCommands  = require('./commands/tarkov.js');
const allergyCommands = require('./commands/allergies.js');
const hateCommands    = require('./commands/hate.js');

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
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
    logSystemEvent('UNHANDLED_REJECTION', 'ERROR', 'system', String(reason?.message ?? reason));
});

// ===== TOP-LEVEL UNCAUGHT EXCEPTION GUARD =====
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
        console.warn('[STREAM TEARDOWN]', err.code, err.message);
        logSystemEvent('STREAM_TEARDOWN', 'WARN', 'music', `Stream teardown: ${err.code} — ${err.message}`);
        return;
    }
    console.error('[UNCAUGHT EXCEPTION]', err);
    logSystemEvent('UNCAUGHT_EXCEPTION', 'ERROR', 'system', `${err.code ?? 'NO_CODE'}: ${err.message}`);
});

// ===== CONFIG =====
const CONFIG = {
    PRESENCE_ROTATE_MS: 5 * 60 * 1000,
    // Gemini image generation can take 10-15s; give the REST client
    // 60s total so the subsequent file upload doesn't get aborted.
    REST_TIMEOUT_MS: 60_000,
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
const allCommands = {
    ...utilityCommands.commands,
    ...adminCommands.commands,
    ...cs2Commands.commands,
    ...tarkovCommands.commands,
    ...allergyCommands.commands,
    ...hateCommands.commands,
};

// ===== DISCORD CLIENT =====
// restRequestTimeout raises the AbortController deadline for every REST
// call this client makes, including file uploads after /imagine.
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
    ],
    rest: {
        timeout: CONFIG.REST_TIMEOUT_MS,
    },
});

// ===== CLIENT READY =====
discordClient.once(Events.ClientReady, async (client) => {
    logSystemEvent('DISCORD_READY', 'INFO', 'discord', `✅ Logged in as ${client.user.tag}`);
    console.log(`✅ Discord ready: ${client.user.tag}`);

    // Register slash commands
    try {
        const rest = new REST({ version: '10', timeout: CONFIG.REST_TIMEOUT_MS })
            .setToken(process.env.DISCORD_TOKEN);
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

    rotatePresence(client);
    setInterval(() => rotatePresence(client), CONFIG.PRESENCE_ROTATE_MS);

    // Give the dashboard server a live handle on the Discord client so its
    // endpoints (hate-list announcements, exports) can send messages.
    try {
        global.setDiscordClientForExport(client);
        console.log('[DASHBOARD] Discord client registered with dashboard server');
    } catch (err) {
        console.error('[DASHBOARD] Failed to register Discord client:', err.message);
    }

    startHateTimer(client);
    console.log('[HATE] Proactive hate timer started');

    // Long-term memory: hourly, turn recent server chat into one durable,
    // AI-maintained fact sheet ("Patrick learns").
    const consolidateMemory = async () => {
        try {
            await consolidateChannelFacts('discord', 'global');
        } catch (err) {
            console.error('[MEMORY] Consolidation timer error:', err.message);
            logSystemEvent('MEMORY_CONSOLIDATE', 'ERROR', 'memory', `Consolidation sweep failed: ${err.message}`, err);
        }
    };
    consolidateMemory();
    setInterval(consolidateMemory, 60 * 60 * 1000);
    console.log('[MEMORY] Long-term memory consolidation timer started (hourly)');
});

// ===== SLASH COMMAND HANDLER =====
discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // Music commands manage their own deferReply internally
    try {
        if (await handleMusicInteraction(interaction)) return;
    } catch (err) {
        console.error('[MUSIC ERROR]', err);
        logSystemEvent('MUSIC_ERROR', 'ERROR', 'discord', `Music command failed: ${err.message}`);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Music command failed.', ephemeral: true });
            } else {
                await interaction.editReply('❌ Music command failed.');
            }
        } catch (_) {}
        return;
    }

    // All other commands defer first so the token stays alive during slow ops
    try {
        await interaction.deferReply();
    } catch (err) {
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

// ===== HATE LIST AUGMENTATION =====
// Adds the bot's "hated user" flavor to replies and random callouts.

// Append a roast jab to an AI reply for a hated user (rate-limited so spam
// mentioners don't burn extra AI calls on the sass every single message).
function augmentReplyWithHate(userId, username, response) {
    if (!isHated(userId)) return response;
    if (!canPing(userId)) return response;
    const jab = buildHateJab(username, userId);
    const room = 2000 - response.length - jab.length - 3;
    if (room > 10) return `${response}\n\n${jab}`;
    return response;
}

// Fire a roast at a hated user's general-chat message. High chance so it
// actually happens a lot, but gated by canPing so we don't spam them 5x in a
// row while they type.
function maybeRandomCallout(userId, username, channel) {
    if (!isHated(userId)) return;
    if (!canPing(userId)) return;
    // ~40% chance — the bot reacts a lot when they talk.
    if (Math.random() > 0.40) return;
    const callout = buildCallout(username, userId, true);
    safeDiscordSend(channel, callout);
    logCommand('discord', username, 'hate callout', '', callout);
}

// ===== HATE CALLOUT HANDLER =====
// Reacts when a hated user chats in general (no mention/reply needed). Menions
// and replies are skipped here because they already get an augmented AI reply.
discordClient.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.mentions.has(discordClient.user)) return;
    if (message.reference) return;
    maybeRandomCallout(message.author.id, message.author.username, message.channel);
});

// ===== PROACTIVE HATE TIMER =====
// Once per hour, with a HEAVY chance (~70%), the bot randomly picks a hated
// user and has the AI generate a fresh, random tagged roast into the channel.
// The check-in is fed into the AI so the roast is varied, not a canned line.
function startHateTimer(client) {
    setInterval(async () => {
        try {
            const hated = getHatedUserIds();
            if (hated.length === 0) return;

            const channelId = getHateChannelId();
            if (!channelId) return;
            const channel = client.channels.cache.get(channelId);
            if (!channel?.isTextBased()) return;

            // Heavy chance this hour that the bot actually fires.
            if (Math.random() > 0.70) return;

            // Pick a target not on cooldown.
            const targets = hated.filter(uid => !isOnPingCooldown(uid));
            if (targets.length === 0) return;
            const target = targets[Math.floor(Math.random() * targets.length)];
            if (!canPing(target)) return;

            const member = channel.guild?.members?.cache?.get(target);
            const name = member?.displayName || `<@${target}>`;

            // Ammunition: facts remembered about THIS user, so the roast hits
            // where it hurts. Filter by their Discord username first, then any.
            const targetUsername = member?.user?.username?.toLowerCase();
            const targetFacts = targetUsername
                ? getContextFacts('discord', 'global', targetUsername)
                : '';
            const roastFacts = targetFacts || getContextFacts('discord', 'global');

            await channel.sendTyping();
            const roast = await generateHateRoast(name, target, 'roasting the member randomly, unprompted, just because they are on the hate list', roastFacts);

            safeDiscordSend(channel, roast);
            logSystemEvent('HATE', 'INFO', 'discord', `Proactive AI roast fired at ${target}: ${roast}`);
            logCommand('discord', name, 'hate proactive', '', roast);
        } catch (err) {
            console.error('[HATE] Proactive timer error:', err.message);
            logSystemEvent('HATE_ERROR', 'WARNING', 'discord', `Proactive hate timer failed: ${err.message}`);
        }
    }, 60 * 60 * 1000); // every 1 hour
}

// ===== DISCORD MESSAGE HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.reference)  return;

    const channelId = message.channelId;
    const username  = message.author.username;

    if (!message.mentions.has(discordClient.user)) return;

    addToMemory('discord', channelId, username, message.content);
    console.log(`[DISCORD] ${username}: ${message.content}`);

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
            await safeDiscordReply(message, `⏳ Rate limit hit. Try again in ${rateCheck.timeLeft} minute(s).`);
            return;
        }
        const cleanPrompt = sanitizeImagePrompt(extractImagePrompt(userMessage));
        logCommand('discord', username, '@mention (image)', cleanPrompt, '[generating...]');
        try {
            await message.channel.sendTyping();
            const result = await generateImage(cleanPrompt, message.author.id);
            if (!result.success) {
                await safeDiscordReply(message, result.error);
                return;
            }
            const ext        = result.mimeType ? result.mimeType.split('/')[1] || 'png' : 'png';
            const attachment = new AttachmentBuilder(result.buffer, { name: `generated.${ext}` });
            await message.reply({ files: [attachment] });
        } catch (imgErr) {
            await safeDiscordReply(message, `❌ Image generation failed: ${imgErr.message}`);
        }
        return;
    }

    if (hasImageAttachment(message)) {
        const images   = await getImageAttachments(message);
        let response = await getAIResponse(userMessage || 'What do you see?', 'discord', channelId, username, images);
        response = augmentReplyWithHate(message.author.id, username, response);
        await safeDiscordReply(message, response);
        logCommand('discord', username, '@mention (image analysis)', userMessage, response);
        return;
    }

    let response = await getAIResponse(userMessage, 'discord', channelId, username);
    response = augmentReplyWithHate(message.author.id, username, response);
    await safeDiscordReply(message, response);
    logCommand('discord', username, '@mention', userMessage, response);
});

// ===== DISCORD REPLY HANDLER =====
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot)  return;
    if (!message.reference)  return;

    const channelId = message.channelId;
    const username  = message.author.username;

    let repliedTo;
    try { repliedTo = await message.fetchReference(); } catch { return; }
    if (repliedTo.author.id !== discordClient.user.id) return;

    addToMemory('discord', channelId, username, message.content);
    console.log(`[DISCORD REPLY] ${username}: ${message.content}`);

    const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!userMessage && !hasImageAttachment(message)) return;

    if (isWildRequest(userMessage)) {
        const roast = await getWildRequestResponse(userMessage, 'discord', channelId, username);
        await safeDiscordReply(message, roast);
        logCommand('discord', username, 'reply (wild)', userMessage, roast);
        return;
    }

    if (hasImageAttachment(message)) {
        const images   = await getImageAttachments(message);
        let response = await getAIResponse(userMessage || 'What do you see?', 'discord', channelId, username, images);
        response = augmentReplyWithHate(message.author.id, username, response);
        await safeDiscordReply(message, response);
        logCommand('discord', username, 'reply (image analysis)', userMessage, response);
        return;
    }

    let response = await getAIResponse(userMessage, 'discord', channelId, username);
    response = augmentReplyWithHate(message.author.id, username, response);
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
