// ===== MUSIC MODULE =====
// Self-contained music playback using @discordjs/voice + yt-dlp
// Exports: musicSlashCommandDefs, handleMusicInteraction

const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
} = require('@discordjs/voice');
const { SlashCommandBuilder } = require('discord.js');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ===== OPUS BOOT CHECK =====
try {
    require('@discordjs/opus');
    console.log('[MUSIC] ✅ @discordjs/opus loaded OK');
} catch (err) {
    console.error('[MUSIC] ❌ FATAL: @discordjs/opus failed to load:', err.message);
    console.error('[MUSIC] Run: npm rebuild @discordjs/opus');
}

// ===== WS CLOSE CODE INTERCEPTOR =====
// Monkey-patch the WebSocket class used by @discordjs/voice so we can log
// the exact close code Discord sends when it terminates the voice WS.
// This runs once at module load time.
(function patchVoiceWs() {
    try {
        const WS = require('ws');
        const origEmit = WS.prototype.emit;
        WS.prototype.emit = function(event, ...args) {
            if (event === 'close') {
                const [code, reason] = args;
                // Only log voice-related WS closes (Discord voice endpoints contain 'discord.media')
                if (this.url && this.url.includes('discord.media')) {
                    console.log(`[VOICE WS CLOSE] code=${code} reason=${reason?.toString() || '(none)'}`);
                    // Common Discord voice close codes:
                    // 4006 = Session no longer valid
                    // 4009 = Session timeout
                    // 4014 = Channel deleted / kicked
                    // 4015 = Voice server crashed (safe to resume)
                    // 1000 = Normal closure
                    // 1001 = Going away
                }
            }
            return origEmit.call(this, event, ...args);
        };
        console.log('[MUSIC] ✅ WS close code interceptor installed');
    } catch (e) {
        console.error('[MUSIC] WS patch failed:', e.message);
    }
}());

// ===== YT-DLP HELPERS =====

const YTDLP = (() => {
    const candidates = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'];
    const fs = require('fs');
    for (const p of candidates) {
        try { if (p.startsWith('/') && fs.existsSync(p)) return p; } catch (_) {}
    }
    return 'yt-dlp';
})();

console.log(`[MUSIC] yt-dlp binary: ${YTDLP}`);

async function ytdlpSearch(query) {
    console.log(`[MUSIC] Searching yt-dlp for: ${query}`);
    const args = [
        `ytsearch1:${query}`,
        '--dump-json',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
    ];
    const { stdout } = await execFileAsync(YTDLP, args, { timeout: 20000 });
    const data = JSON.parse(stdout.trim().split('\n')[0]);
    console.log(`[MUSIC] Found: ${data.title}`);
    return {
        title:    data.title || 'Unknown Title',
        url:      `https://www.youtube.com/watch?v=${data.id}`,
        duration: data.duration || 0,
    };
}

async function ytdlpInfo(url) {
    console.log(`[MUSIC] Fetching info for URL: ${url}`);
    const args = [
        url,
        '--dump-json',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
    ];
    const { stdout } = await execFileAsync(YTDLP, args, { timeout: 20000 });
    const data = JSON.parse(stdout.trim().split('\n')[0]);
    return {
        title:    data.title || 'Unknown Title',
        url:      `https://www.youtube.com/watch?v=${data.id}`,
        duration: data.duration || 0,
    };
}

function ytdlpStream(url) {
    console.log(`[MUSIC] Spawning yt-dlp + ffmpeg stream for: ${url}`);

    const ytdlp = spawn(YTDLP, [
        url,
        '-f', 'bestaudio',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '-o', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.on('error',  (err)  => console.error('[MUSIC] yt-dlp spawn error:', err.message));
    ffmpeg.on('error', (err)  => console.error('[MUSIC] ffmpeg spawn error:', err.message));
    ytdlp.on('exit',   (code) => console.log(`[MUSIC] yt-dlp exited with code ${code}`));
    ffmpeg.on('exit',  (code) => console.log(`[MUSIC] ffmpeg exited with code ${code}`));

    return { ytdlp, ffmpeg, stream: ffmpeg.stdout };
}

// ===== QUEUE STORE =====
const queues = new Map();

// ===== INTERNAL HELPERS =====

function getOrCreateQueue(guildId) {
    if (!queues.has(guildId)) {
        queues.set(guildId, {
            tracks: [],
            connection: null,
            player: null,
            current: null,
            paused: false,
            ytdlpProcess: null,
            ffmpegProcess: null,
        });
    }
    return queues.get(guildId);
}

function destroyQueue(guildId) {
    const state = queues.get(guildId);
    if (state) {
        console.log(`[MUSIC] Destroying queue for guild ${guildId}`);
        try { state.ytdlpProcess?.kill(); } catch (_) {}
        try { state.ffmpegProcess?.kill(); } catch (_) {}
        try { state.player?.stop(true); } catch (_) {}
        try { state.connection?.destroy(); } catch (_) {}
        queues.delete(guildId);
    }
    try {
        const stale = getVoiceConnection(guildId);
        if (stale) {
            console.log(`[MUSIC] Also destroying dangling @discordjs/voice connection for guild ${guildId}`);
            stale.destroy();
        }
    } catch (_) {}
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
        console.log(`[MUSIC] Queue empty for guild ${guildId}, will auto-leave in 30s`);
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
    console.log(`[MUSIC] Playing next: ${state.current.title}`);

    try {
        try { state.ytdlpProcess?.kill(); } catch (_) {}
        try { state.ffmpegProcess?.kill(); } catch (_) {}

        const { ytdlp, ffmpeg, stream } = ytdlpStream(state.current.url);
        state.ytdlpProcess  = ytdlp;
        state.ffmpegProcess = ffmpeg;

        const resource = createAudioResource(stream, {
            inputType: StreamType.Raw,
        });

        state.player.play(resource);
        console.log(`[MUSIC] Audio resource created and handed to player`);
    } catch (err) {
        console.error('[MUSIC] stream error:', err.message);
        state.current = null;
        playNext(guildId);
    }
}

async function ensureConnected(guildId, voiceChannel) {
    const existing = queues.get(guildId);
    if (
        existing?.connection &&
        existing.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
        console.log(`[MUSIC] Reusing existing connection for guild ${guildId}`);
        return existing;
    }

    const stale = getVoiceConnection(guildId);
    if (stale) {
        console.log(`[MUSIC] Found stale @discordjs/voice connection — destroying before fresh join`);
        stale.destroy();
        await new Promise(r => setTimeout(r, 1000));
        console.log(`[MUSIC] Stale connection cleared`);
    }
    queues.delete(guildId);

    console.log(`[MUSIC] Joining voice channel: ${voiceChannel.name} (${voiceChannel.id})`);

    const connection = joinVoiceChannel({
        channelId:      voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf:       true,
        debug:          true,
    });

    connection.on('stateChange', (oldState, newState) => {
        console.log(`[VOICE] ${oldState.status} → ${newState.status}`);
        if (newState.networking) {
            console.log(`[VOICE] networking state: ${newState.networking.state?.code ?? 'unknown'}`);
        }
    });
    connection.on('error', (err) => {
        console.error('[VOICE] Connection error:', err.message);
    });
    connection.on('debug', (msg) => {
        console.log(`[VOICE DEBUG] ${msg}`);
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log(`[MUSIC] ✅ Voice connection Ready`);
    } catch (err) {
        console.error('[MUSIC] ❌ Voice connection timed out:', err.message);
        connection.destroy();
        queues.delete(guildId);
        throw new Error('Could not connect to your voice channel in time.');
    }

    const player = createAudioPlayer();
    connection.subscribe(player);
    console.log(`[MUSIC] Audio player created and subscribed`);

    player.on('stateChange', (oldState, newState) => {
        console.log(`[PLAYER] ${oldState.status} → ${newState.status}`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
        console.log(`[MUSIC] Player idle — playing next track`);
        playNext(guildId);
    });

    player.on('error', (err) => {
        console.error('[MUSIC] player error:', err.message);
        const s = queues.get(guildId);
        if (s) { s.current = null; playNext(guildId); }
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log('[VOICE] Disconnected — attempting to reconnect...');
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            console.log('[VOICE] Reconnected successfully');
        } catch {
            console.log('[VOICE] Reconnect failed — destroying queue');
            destroyQueue(guildId);
        }
    });

    const state = getOrCreateQueue(guildId);
    state.connection = connection;
    state.player     = player;
    return state;
}

// ===== COMMAND LOGIC =====

async function cmdPlay(guildId, voiceChannel, query, requestedBy) {
    if (!voiceChannel) return '❌ You must be in a voice channel to play music.';

    let trackInfo;
    try {
        const isUrl = /^https?:\/\//i.test(query.trim());
        if (isUrl) {
            trackInfo = await ytdlpInfo(query.trim());
            trackInfo.requestedBy = requestedBy;
        } else {
            const result = await ytdlpSearch(query);
            trackInfo = { ...result, requestedBy };
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
        if (state.tracks.length > 10) lines.push(`…and ${state.tracks.length - 10} more.`);
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
async function handleMusicInteraction(interaction) {
    const { commandName } = interaction;
    const guildId      = interaction.guildId;
    const member       = interaction.member;
    const voiceChannel = member?.voice?.channel ?? null;
    const username     = interaction.user.username;

    await interaction.deferReply();

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

module.exports = { musicSlashCommandDefs, handleMusicInteraction };