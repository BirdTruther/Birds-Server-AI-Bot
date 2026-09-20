// services/cultist.js
// Tarkov cultist-spawn alerts, per Discord server.
//
// Cultists only spawn during the in-game night window. Tarkov runs at 7x real
// time, so we convert real time to in-game time and post an alert when the
// window opens/closes. Each Discord server opts in with its own channel and
// (optionally) a role to ping; the Tarkov clock itself is global.
//
// This restores the original single-server monitor (see git commit e7a3e93)
// and makes it multi-guild: config + transition state are per guild.

const { getSetting, setSetting } = require('../database.js');
const { logSystemEvent } = require('../logger.js');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// ===== TARKOV TIME =====
// Tarkov time = (real epoch + 3h Moscow offset) * 7, wrapped to 24h.
function getCurrentTarkovTime() {
    const oneDay = 24 * 60 * 60 * 1000;
    const russia = 3 * 60 * 60 * 1000;
    const tarkovRatio = 7;
    const now = Date.now();
    const tarkovTime = (russia + (now * tarkovRatio)) % oneDay;
    const totalMinutes = Math.floor(tarkovTime / (60 * 1000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return { hours, minutes };
}

// Night window: 22:00–07:00 in-game.
function isCultistTime(hour) {
    return hour >= 22 || hour < 7;
}

function formatTime(hours, minutes) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function snapshot() {
    const { hours, minutes } = getCurrentTarkovTime();
    const server1Hours = hours;
    const server2Hours = (hours + 12) % 24;
    return {
        server1Time: formatTime(server1Hours, minutes),
        server2Time: formatTime(server2Hours, minutes),
        server1Active: isCultistTime(server1Hours),
        server2Active: isCultistTime(server2Hours),
    };
}

// ===== PER-GUILD CONFIG =====
function key(base, guildId) {
    return guildId ? `${base}:${guildId}` : base;
}

function isCultistEnabled(guildId = null) {
    const value = guildId
        ? getSetting(key('cultistEnabled', guildId), null) ?? getSetting('cultistEnabled', 'true')
        : getSetting('cultistEnabled', 'true');
    return value !== 'false';
}

function getCultistChannelId(guildId = null) {
    return guildId
        ? getSetting(key('cultistChannelId', guildId), null) ?? getSetting('cultistChannelId', '')
        : getSetting('cultistChannelId', '');
}

function getCultistRoleId(guildId = null) {
    return guildId
        ? getSetting(key('cultistRoleId', guildId), null) ?? getSetting('cultistRoleId', '')
        : getSetting('cultistRoleId', '');
}

function setCultistEnabled(guildId, enabled) {
    return setSetting(key('cultistEnabled', guildId), enabled ? 'true' : 'false');
}

function setCultistChannelId(guildId, channelId) {
    return setSetting(key('cultistChannelId', guildId), String(channelId || ''));
}

function setCultistRoleId(guildId, roleId) {
    return setSetting(key('cultistRoleId', guildId), String(roleId || ''));
}

// ===== MONITOR =====
// guildId -> { server1: boolean, server2: boolean, initialized: boolean }
const guildStates = new Map();

function stateFor(guildId, snap) {
    let st = guildStates.get(guildId);
    if (!st) {
        // First time we've seen this guild this process: adopt the current
        // window silently so a restart mid-window doesn't re-announce.
        st = { server1: snap.server1Active, server2: snap.server2Active, initialized: false };
        guildStates.set(guildId, st);
    }
    return st;
}

async function checkCultistActivity(client) {
    const snap = snapshot();
    console.log(`[CULTIST] Check — S1:${snap.server1Time}(${snap.server1Active}) S2:${snap.server2Time}(${snap.server2Active})`);

    for (const [guildId] of client.guilds.cache) {
        try {
            if (!isCultistEnabled(guildId)) continue;

            const channelId = getCultistChannelId(guildId);
            if (!channelId) continue;
            const channel = client.channels.cache.get(channelId);
            if (!channel?.isTextBased()) continue;

            const roleId = getCultistRoleId(guildId);
            const tag = roleId ? `<@&${roleId}> ` : '';
            const st = stateFor(guildId, snap);

            // On the very first check for a guild, just record state.
            if (!st.initialized) {
                st.initialized = true;
                continue;
            }

            if (snap.server1Active && !st.server1) {
                channel.send(`${tag}🌙 **Cultists are now active! (Server 1)** In-game time: ${snap.server1Time}`).catch(() => {});
                st.server1 = true;
                console.log(`[CULTIST] Server 1 active at ${snap.server1Time} (guild ${guildId})`);
            } else if (!snap.server1Active && st.server1) {
                channel.send(`${tag}☀️ **Cultists despawned. (Server 1)** In-game time: ${snap.server1Time}`).catch(() => {});
                st.server1 = false;
                console.log(`[CULTIST] Server 1 inactive at ${snap.server1Time} (guild ${guildId})`);
            }

            if (snap.server2Active && !st.server2) {
                channel.send(`${tag}🌙 **Cultists are now active! (Server 2)** In-game time: ${snap.server2Time}`).catch(() => {});
                st.server2 = true;
                console.log(`[CULTIST] Server 2 active at ${snap.server2Time} (guild ${guildId})`);
            } else if (!snap.server2Active && st.server2) {
                channel.send(`${tag}☀️ **Cultists despawned. (Server 2)** In-game time: ${snap.server2Time}`).catch(() => {});
                st.server2 = false;
                console.log(`[CULTIST] Server 2 inactive at ${snap.server2Time} (guild ${guildId})`);
            }
        } catch (error) {
            console.error('[CULTIST] Monitoring error:', error.message);
            logSystemEvent('CULTIST_ERROR', 'WARNING', 'cultist', `Cultist monitoring error (guild ${guildId}): ${error.message}`, error);
        }
    }
}

function startCultistMonitor(client) {
    console.log('[CULTIST] Starting monitoring system...');
    logSystemEvent('STARTUP', 'INFO', 'cultist', 'Cultist monitoring system started');
    checkCultistActivity(client);
    setInterval(() => checkCultistActivity(client), CHECK_INTERVAL_MS);
    console.log(`[CULTIST] Monitoring every ${CHECK_INTERVAL_MS / 60000} minutes`);
}

module.exports = {
    getCurrentTarkovTime,
    isCultistTime,
    snapshot,
    isCultistEnabled,
    getCultistChannelId,
    getCultistRoleId,
    setCultistEnabled,
    setCultistChannelId,
    setCultistRoleId,
    checkCultistActivity,
    startCultistMonitor,
};
