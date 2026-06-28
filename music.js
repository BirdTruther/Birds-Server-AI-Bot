// ===== MUSIC MODULE =====
// Self-contained music playback using @discordjs/voice + play-dl
// Exports: musicSlashCommandDefs, handleMusicInteraction, handleMusicPrefix

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
} = require('@discordjs/voice');
const playdl = require('play-dl');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ===== QUEUE STORE =====
// Map<guildId, GuildMusicState>
const queues = new Map();

// ===== INTERNAL HELPERS =====

function getOrCreateQueue(guildId) {
    if (!queues.has(guildId)) {
        queues.set(guildId, {
            tracks: [],          // [{ title, url, duration, requestedBy }]
            connection: null,
            player: null,
            current: null,
            paused: false,
        });
    }
    return queues.get(guildId);
}

function destroyQueue(guildId) {
    const state = queues.get(guildId);
    if (!state) return;
    try { state.player?.stop(true); } catch (_) {}
    try { state.connection?.destroy(); } catch (_) {}
    queues.delete(guildId);
}

function fmtDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '?:??';
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `${m}:${s}`;
}

async function playNext(guildId) {
    const state = queues.get(guildId);
    if (!state) return;

    if (state.tracks.length === 0) {
        state.current = null;
        // Leave after 30 s of silence so users can still queue more
        setTimeout(() => {
            const s2 = queues.get(guildId);
            if (s2 && s2.tracks.length === 0 && s2.current === null) {
                destroyQueue(guildId);
            }
        }, 30_000);
        return;
    }

    state.current = state.tracks.shift();
    state.paused  = false;

    try {
        const stream = await playdl.stream(state.current.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, {
            inputType: stream.type,
        });
        state.player.play(resource);
    } catch (err) {
        console.error('[MUSIC] stream error:', err.message);
        state.current = null;
        playNext(guildId);
    }
}

async function ensureConnected(guildId, voiceChannel) {
    let state = getOrCreateQueue(guildId);

    // Reuse existing live connection
    if (
        state.connection &&
        state.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
        return state;
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
    });

    // Wait for Ready (or timeout after 15 s)
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
        connection.destroy();
        queues.delete(guildId);
        throw new Error('Could not connect to your voice channel in time.');
    }

    const player = createAudioPlayer();
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
    player.on('error', (err) => {
        console.error('[MUSIC] player error:', err.message);
        const s = queues.get(guildId);
        if (s) { s.current = null; playNext(guildId); }
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch {
            destroyQueue(guildId);
        }
    });

    state = getOrCreateQueue(guildId);
    state.connection = connection;
    state.player     = player;
    return state;
}

// ===== COMMAND LOGIC =====

async function cmdPlay(guildId, voiceChannel, query, requestedBy) {
    if (!voiceChannel) return '❌ You must be in a voice channel to play music.';

    let trackInfo;
    try {
        // Check if it's a URL or a search term
        const isUrl = /^https?:\/\//i.test(query.trim());
        if (isUrl) {
            const info = await playdl.video_info(query);
            const d    = info.video_details;
            trackInfo  = {
                title:       d.title || 'Unknown Title',
                url:         d.url,
                duration:    d.durationInSec,
                requestedBy,
            };
        } else {
            const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });
            if (!results || results.length === 0) return `❌ No results found for **"${query}"**.`;
            const d = results[0];
            trackInfo = {
                title:       d.title || 'Unknown Title',
                url:         d.url,
                duration:    d.durationInSec,
                requestedBy,
            };
        }
    } catch (err) {
        console.error('[MUSIC] search/info error:', err.message);
        return `❌ Could not find or load that track: ${err.message}`;
    }

    let state;
    try {
        state = await ensureConnected(guildId, voiceChannel);
    } catch (err) {
        return `❌ ${err.message}`;
    }

    state.tracks.push(trackInfo);

    if (state.player.state.status === AudioPlayerStatus.Idle && state.current === null) {
        await playNext(guildId);
        return `▶️ Now playing: **${trackInfo.title}** (${fmtDuration(trackInfo.duration)})`;
    }

    return `📥 Added to queue: **${trackInfo.title}** (${fmtDuration(trackInfo.duration)}) — position #${state.tracks.length}`;
}

function cmdSkip(guildId) {
    const state = queues.get(guildId);
    if (!state || !state.current) return '❌ Nothing is playing right now.';
    const skipped = state.current.title;
    state.player.stop();
    return `⏭️ Skipped **${skipped}**.`;
}

function cmdStop(guildId) {
    const state = queues.get(guildId);
    if (!state) return '❌ The bot is not in a voice channel.';
    destroyQueue(guildId);
    return '⏹️ Stopped playback and left the voice channel.';
}

function cmdQueue(guildId) {
    const state = queues.get(guildId);
    if (!state || (!state.current && state.tracks.length === 0)) {
        return '📭 The queue is empty.';
    }
    const lines = [];
    if (state.current) {
        lines.push(`▶️ **Now playing:** ${state.current.title} (${fmtDuration(state.current.duration)}) — req. by ${state.current.requestedBy}`);
    }
    if (state.tracks.length > 0) {
        lines.push('');
        lines.push('**Up next:**');
        state.tracks.slice(0, 10).forEach((t, i) => {
            lines.push(`${i + 1}. ${t.title} (${fmtDuration(t.duration)}) — req. by ${t.requestedBy}`);
        });
        if (state.tracks.length > 10) {
            lines.push(`…and ${state.tracks.length - 10} more.`);
        }
    }
    return lines.join('\n');
}

function cmdPause(guildId) {
    const state = queues.get(guildId);
    if (!state || !state.current) return '❌ Nothing is playing.';
    if (state.paused) return '⏸️ Already paused.';
    state.player.pause();
    state.paused = true;
    return `⏸️ Paused **${state.current.title}**.`;
}

function cmdResume(guildId) {
    const state = queues.get(guildId);
    if (!state || !state.current) return '❌ Nothing is playing.';
    if (!state.paused) return '▶️ Already playing.';
    state.player.unpause();
    state.paused = false;
    return `▶️ Resumed **${state.current.title}**.`;
}

function cmdNowPlaying(guildId) {
    const state = queues.get(guildId);
    if (!state || !state.current) return '🎵 Nothing is playing right now.';
    const t = state.current;
    return `🎵 Now playing: **${t.title}** (${fmtDuration(t.duration)}) — requested by ${t.requestedBy}`;
}

// ===== SLASH COMMAND DEFINITIONS =====
// NOTE: Export as SlashCommandBuilder instances (NOT pre-serialized).
// index.js calls .toJSON() on the merged array during registration.

const musicSlashCommandDefs = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a YouTube track or add it to the queue')
        .addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current track'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop playback, clear the queue, and leave the voice channel'),
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the current music queue'),
    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pause the current track'),
    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume a paused track'),
    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show what is currently playing'),
];

// ===== SLASH HANDLER =====
// Called from index.js InteractionCreate for music command names.
async function handleMusicInteraction(interaction) {
    const { commandName } = interaction;
    const guildId      = interaction.guildId;
    const member       = interaction.member;
    const voiceChannel = member?.voice?.channel ?? null;
    const username     = interaction.user.username;

    let reply;
    try {
        switch (commandName) {
            case 'play': {
                const query = interaction.options.getString('query');
                reply = await cmdPlay(guildId, voiceChannel, query, username);
                break;
            }
            case 'skip':       reply = cmdSkip(guildId);       break;
            case 'stop':       reply = cmdStop(guildId);       break;
            case 'queue':      reply = cmdQueue(guildId);      break;
            case 'pause':      reply = cmdPause(guildId);      break;
            case 'resume':     reply = cmdResume(guildId);     break;
            case 'nowplaying': reply = cmdNowPlaying(guildId); break;
            default:           reply = '❌ Unknown music command.'; break;
        }
    } catch (err) {
        console.error('[MUSIC SLASH ERROR]', err);
        reply = `❌ Music error: ${err.message}`;
    }

    await interaction.editReply(reply);
}

// ===== PREFIX HANDLER =====
// Called from index.js MessageCreate for !play, !skip, etc.
async function handleMusicPrefix(message, cmd, args) {
    const guildId      = message.guildId;
    const voiceChannel = message.member?.voice?.channel ?? null;
    const username     = message.author.username;

    if (!guildId) {
        await message.reply('❌ Music commands only work in a server.');
        return;
    }

    let reply;
    try {
        switch (cmd) {
            case 'play': {
                if (!args) {
                    reply = '❌ Usage: `!play <song name or URL>`';
                    break;
                }
                reply = await cmdPlay(guildId, voiceChannel, args, username);
                break;
            }
            case 'skip':       reply = cmdSkip(guildId);       break;
            case 'stop':       reply = cmdStop(guildId);       break;
            case 'queue':      reply = cmdQueue(guildId);      break;
            case 'pause':      reply = cmdPause(guildId);      break;
            case 'resume':     reply = cmdResume(guildId);     break;
            case 'nowplaying': reply = cmdNowPlaying(guildId); break;
            default:           reply = '❌ Unknown music command.'; break;
        }
    } catch (err) {
        console.error('[MUSIC PREFIX ERROR]', err);
        reply = `❌ Music error: ${err.message}`;
    }

    await message.reply(reply);
}

module.exports = { musicSlashCommandDefs, handleMusicInteraction, handleMusicPrefix };
