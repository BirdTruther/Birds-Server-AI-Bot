// music-player.js
// Self-contained music queue engine for ThePatrick bot.
// Uses @discordjs/voice for audio and yt-dlp (system binary) for streaming.
// Per-guild queues — each server has its own independent player state.

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    getVoiceConnection
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { spawn } = require('child_process');

// Per-guild player state map
// key: guildId, value: GuildQueue object
const queues = new Map();

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes idle before auto-disconnect
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'; // override in .env if not in PATH

// ─────────────────────────────────────────────
// GuildQueue: holds all state for one server
// ─────────────────────────────────────────────
class GuildQueue {
    constructor(guildId, voiceChannel, textChannel) {
        this.guildId = guildId;
        this.voiceChannel = voiceChannel;
        this.textChannel = textChannel;
        this.tracks = [];          // array of track objects
        this.current = null;       // currently playing track
        this.player = createAudioPlayer();
        this.connection = null;
        this.idleTimer = null;
        this.paused = false;
        this.volume = 100;
    }
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

/**
 * Resolve a YouTube URL or search query to a track info object using yt-dlp.
 * Supports: youtube.com/watch, youtu.be, YouTube Music, or plain search terms.
 */
function resolveTrack(query) {
    return new Promise((resolve, reject) => {
        // If it's not a URL, treat as a search
        const isUrl = /^https?:\/\//i.test(query);
        const input = isUrl ? query : `ytsearch1:${query}`;

        const proc = spawn(YTDLP_PATH, [
            '--dump-json',
            '--no-playlist',
            '--no-warnings',
            '--quiet',
            input
        ]);

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            if (code !== 0) return reject(new Error(`yt-dlp exited ${code}: ${stderr.trim()}`));
            try {
                // yt-dlp may return multiple JSON lines for playlists; take first
                const line = stdout.trim().split('\n')[0];
                const info = JSON.parse(line);
                resolve({
                    url: info.webpage_url || info.url,
                    title: info.title || 'Unknown Title',
                    duration: info.duration || 0,
                    thumbnail: info.thumbnail || null,
                    uploader: info.uploader || info.channel || 'Unknown',
                    requestedBy: null // filled in by caller
                });
            } catch (e) {
                reject(new Error('Failed to parse yt-dlp output: ' + e.message));
            }
        });

        proc.on('error', err => reject(new Error('yt-dlp not found or failed: ' + err.message)));
    });
}

/**
 * Create a readable stream for the audio of a YouTube URL using yt-dlp piped to ffmpeg.
 * Returns an AudioResource.
 *
 * Fix: added error handlers on ffmpeg.stdin, ytdlp.stdout, and both child processes
 * to prevent unhandled 'error' events (EPIPE) from crashing the bot when /skip tears
 * down the audio pipeline mid-stream.
 */
function createAudioResourceFromUrl(url) {
    const ytdlp = spawn(YTDLP_PATH, [
        '-f', 'bestaudio[ext=webm]/bestaudio/best',
        '--no-playlist',
        '--quiet',
        '-o', '-',
        url
    ]);

    const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    // Suppress stderr — MUST have listeners or Node will throw on 'error'
    ytdlp.stderr.on('data', () => {});
    ffmpeg.stderr.on('data', () => {});

    // Guard ffmpeg.stdin against EPIPE: when skip/stop closes the resource,
    // ffmpeg exits and its stdin becomes unwritable. Kill yt-dlp so it stops
    // trying to write into a closed pipe.
    ffmpeg.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.error('[MUSIC] ffmpeg stdin error:', err.message);
        }
        try { ytdlp.kill('SIGKILL'); } catch (_) {}
    });

    // Guard yt-dlp stdout against errors caused by early ffmpeg exit
    ytdlp.stdout.on('error', (err) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.error('[MUSIC] yt-dlp stdout error:', err.message);
        }
    });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    // When yt-dlp finishes, end ffmpeg stdin — but only if it's still writable
    ytdlp.on('close', () => {
        if (ffmpeg.stdin.writable) {
            try { ffmpeg.stdin.end(); } catch (_) {}
        }
    });

    // When ffmpeg exits (including being killed by skip), clean up yt-dlp
    ffmpeg.on('close', () => {
        try { ytdlp.kill('SIGKILL'); } catch (_) {}
    });

    ytdlp.on('error', (err) => {
        console.error('[MUSIC] yt-dlp process error:', err.message);
    });

    ffmpeg.on('error', (err) => {
        console.error('[MUSIC] ffmpeg process error:', err.message);
    });

    return createAudioResource(ffmpeg.stdout, {
        inlineVolume: false
    });
}

/**
 * Format seconds into mm:ss or hh:mm:ss.
 */
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return 'LIVE';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Build a rich "Now Playing" embed.
 */
function buildNowPlayingEmbed(track, queue) {
    const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('🎵 Now Playing')
        .setDescription(`**[${track.title}](${track.url})**`)
        .addFields(
            { name: '⏱ Duration', value: formatDuration(track.duration), inline: true },
            { name: '🎤 Artist', value: track.uploader, inline: true },
            { name: '📋 Queue', value: queue.tracks.length > 0 ? `${queue.tracks.length} track(s) up next` : 'Nothing queued', inline: true },
            { name: '👤 Requested by', value: track.requestedBy || 'Unknown', inline: true }
        )
        .setFooter({ text: 'ThePatrick Music' })
        .setTimestamp();

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    return embed;
}

/**
 * Build a "Track Added" embed.
 */
function buildAddedEmbed(track, position) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('✅ Added to Queue')
        .setDescription(`**[${track.title}](${track.url})**`)
        .addFields(
            { name: '⏱ Duration', value: formatDuration(track.duration), inline: true },
            { name: '🎤 Artist', value: track.uploader, inline: true },
            { name: '📋 Position', value: position === 0 ? 'Up next (playing now)' : `#${position + 1} in queue`, inline: true }
        )
        .setFooter({ text: 'ThePatrick Music' })
        .setTimestamp();

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    return embed;
}

// ─────────────────────────────────────────────
// Playback engine
// ─────────────────────────────────────────────

function clearIdleTimer(queue) {
    if (queue.idleTimer) { clearTimeout(queue.idleTimer); queue.idleTimer = null; }
}

function startIdleTimer(queue) {
    clearIdleTimer(queue);
    queue.idleTimer = setTimeout(() => {
        destroyQueue(queue.guildId);
    }, IDLE_TIMEOUT_MS);
}

function destroyQueue(guildId) {
    const queue = queues.get(guildId);
    if (!queue) return;
    clearIdleTimer(queue);
    try { queue.player.stop(true); } catch (_) {}
    const conn = getVoiceConnection(guildId);
    if (conn) { try { conn.destroy(); } catch (_) {} }
    queues.delete(guildId);
}

function playNext(queue) {
    if (queue.tracks.length === 0) {
        queue.current = null;
        startIdleTimer(queue);
        return;
    }

    const track = queue.tracks.shift();
    queue.current = track;
    queue.paused = false;

    try {
        const resource = createAudioResourceFromUrl(track.url);
        queue.player.play(resource);
    } catch (err) {
        console.error('[MUSIC] Error creating audio resource:', err.message);
        if (queue.textChannel) {
            queue.textChannel.send({ content: `❌ Failed to play **${track.title}**: ${err.message}` }).catch(() => {});
        }
        playNext(queue);
        return;
    }

    if (queue.textChannel) {
        queue.textChannel.send({ embeds: [buildNowPlayingEmbed(track, queue)] }).catch(() => {});
    }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Add a track to the queue and start playback if idle.
 * Returns { embed, alreadyPlaying } for the interaction reply.
 */
async function addTrack(interaction, query) {
    const { guild, member, channel } = interaction;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
        return { error: '🔇 You need to be in a voice channel first!' };
    }

    // Resolve track metadata
    let track;
    try {
        track = await resolveTrack(query);
    } catch (err) {
        return { error: `❌ Could not find track: ${err.message}` };
    }
    track.requestedBy = interaction.user.displayName || interaction.user.username;

    let queue = queues.get(guild.id);

    if (!queue) {
        // Create queue and join voice channel
        queue = new GuildQueue(guild.id, voiceChannel, channel);
        queues.set(guild.id, queue);

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator
        });
        queue.connection = connection;
        connection.subscribe(queue.player);

        // Handle disconnects
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                ]);
            } catch {
                destroyQueue(guild.id);
            }
        });

        // Wire up player events
        queue.player.on(AudioPlayerStatus.Idle, () => {
            const q = queues.get(guild.id);
            if (q) playNext(q);
        });

        queue.player.on('error', err => {
            console.error('[MUSIC] Player error:', err.message);
            const q = queues.get(guild.id);
            if (q) playNext(q);
        });
    }

    const alreadyPlaying = queue.current !== null;
    const position = queue.tracks.length;
    queue.tracks.push(track);

    if (!alreadyPlaying) {
        playNext(queue);
    }

    return {
        embed: buildAddedEmbed(track, alreadyPlaying ? position : 0),
        alreadyPlaying
    };
}

/**
 * Skip the current track.
 * Uses stop(true) to force-stop immediately and fire the Idle event once,
 * preventing a race condition with playNext.
 */
function skip(guildId) {
    const queue = queues.get(guildId);
    if (!queue || !queue.current) return { error: '❌ Nothing is playing right now.' };
    const skipped = queue.current.title;
    queue.player.stop(true); // force: true — immediately transitions to Idle
    return { message: `⏭ Skipped **${skipped}**` };
}

/**
 * Stop playback and clear the queue.
 */
function stop(guildId) {
    const queue = queues.get(guildId);
    if (!queue) return { error: '❌ Nothing is playing right now.' };
    queue.tracks = [];
    destroyQueue(guildId);
    return { message: '⏹ Stopped playback and cleared the queue.' };
}

/**
 * Pause playback.
 */
function pause(guildId) {
    const queue = queues.get(guildId);
    if (!queue || !queue.current) return { error: '❌ Nothing is playing right now.' };
    if (queue.paused) return { error: '⏸ Already paused.' };
    queue.player.pause();
    queue.paused = true;
    return { message: '⏸ Paused.' };
}

/**
 * Resume playback.
 */
function resume(guildId) {
    const queue = queues.get(guildId);
    if (!queue || !queue.current) return { error: '❌ Nothing is playing right now.' };
    if (!queue.paused) return { error: '▶ Already playing.' };
    queue.player.unpause();
    queue.paused = false;
    return { message: '▶ Resumed.' };
}

/**
 * Get a formatted queue embed.
 */
function getQueueEmbed(guildId) {
    const queue = queues.get(guildId);
    if (!queue || (!queue.current && queue.tracks.length === 0)) {
        return { error: '📭 The queue is empty.' };
    }

    const lines = [];
    if (queue.current) {
        lines.push(`**Now Playing:** [${queue.current.title}](${queue.current.url}) \`${formatDuration(queue.current.duration)}\`${queue.paused ? ' ⏸' : ' ▶'}`);
    }
    if (queue.tracks.length > 0) {
        lines.push('');
        lines.push('**Up Next:**');
        queue.tracks.slice(0, 10).forEach((t, i) => {
            lines.push(`${i + 1}. [${t.title}](${t.url}) \`${formatDuration(t.duration)}\` — ${t.requestedBy}`);
        });
        if (queue.tracks.length > 10) lines.push(`...and ${queue.tracks.length - 10} more`);
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📋 Queue')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${queue.tracks.length} track(s) in queue | ThePatrick Music` })
        .setTimestamp();

    return { embed };
}

/**
 * Get current now-playing embed.
 */
function getNowPlayingEmbed(guildId) {
    const queue = queues.get(guildId);
    if (!queue || !queue.current) return { error: '📭 Nothing is currently playing.' };
    return { embed: buildNowPlayingEmbed(queue.current, queue) };
}

/**
 * Get raw status object for the dashboard API.
 * Called via global.getMusicStatus() from dashboard-server.js.
 */
function getMusicStatus() {
    const result = {};
    for (const [guildId, queue] of queues) {
        result[guildId] = {
            guildId,
            guildName: queue.voiceChannel?.guild?.name || 'Unknown',
            voiceChannel: queue.voiceChannel?.name || 'Unknown',
            paused: queue.paused,
            current: queue.current ? {
                title: queue.current.title,
                url: queue.current.url,
                duration: formatDuration(queue.current.duration),
                thumbnail: queue.current.thumbnail,
                uploader: queue.current.uploader,
                requestedBy: queue.current.requestedBy
            } : null,
            queue: queue.tracks.map(t => ({
                title: t.title,
                url: t.url,
                duration: formatDuration(t.duration),
                requestedBy: t.requestedBy
            })),
            queueLength: queue.tracks.length
        };
    }
    return result;
}

module.exports = {
    addTrack,
    skip,
    stop,
    pause,
    resume,
    getQueueEmbed,
    getNowPlayingEmbed,
    getMusicStatus
};
