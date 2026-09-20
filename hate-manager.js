// hate-manager.js
// Tracks a "hate list" of Discord users the bot treats with extra venom, and
// proactively roasts them. Persisted in the bot_settings key/value store
// (SQLite) so it survives reboots.
//
// This is a purely cosmetic/roleplay feature — the listed users still have full
// access to the bot; they just get roasted a lot more.

const { getSetting, setSetting } = require('./database.js');

const HATE_KEY = 'hateList';
const HATE_CHANNEL_KEY = 'hateChannelId';

// Multi-guild support: the hate list + roast channel + ping toggle are
// per-Discord-server, so each community decides its own local villain while the
// persona + facts stay global ("one Patrick everywhere"). Keys are namespaced
// by guild. When `guildId` is null (legacy rows / single-guild installs) we
// fall back to the original global key so nothing breaks.
function hateListKey(guildId)   { return guildId ? `hateList:${guildId}` : HATE_KEY; }
function hateChannelKey(guildId){ return guildId ? `hateChannelId:${guildId}` : HATE_CHANNEL_KEY; }

function getHatedUserIds(guildId = null) {
    try {
        const raw = guildId
            ? getSetting(hateListKey(guildId), null) ?? getSetting(HATE_KEY, '[]')
            : getSetting(HATE_KEY, '[]');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch (err) {
        console.error('[HATE] Failed to parse hate list:', err.message);
        return [];
    }
}

function saveHatedUserIds(ids, guildId = null) {
    try {
        setSetting(hateListKey(guildId), JSON.stringify(ids));
        return true;
    } catch (err) {
        console.error('[HATE] Failed to save hate list:', err.message);
        return false;
    }
}

function addToHateList(userId, guildId = null) {
    const ids = getHatedUserIds(guildId);
    const id = String(userId);
    if (ids.includes(id)) return { ok: false, message: '⚠️ That user is already on the hate list.' };
    ids.push(id);
    saveHatedUserIds(ids, guildId);
    return { ok: true, message: '😈 Added to the hate list.' };
}

function removeFromHateList(userId, guildId = null) {
    const ids = getHatedUserIds(guildId);
    const id = String(userId);
    if (!ids.includes(id)) return { ok: false, message: "That user isn't on the hate list." };
    const remaining = ids.filter(x => x !== id);
    saveHatedUserIds(remaining, guildId);
    return { ok: true, message: '😇 Removed from the hate list.' };
}

function isHated(userId, guildId = null) {
    return getHatedUserIds(guildId).includes(String(userId));
}

function getHateChannelId(guildId = null) {
    return guildId
        ? getSetting(hateChannelKey(guildId), null) ?? getSetting(HATE_CHANNEL_KEY, '')
        : getSetting(HATE_CHANNEL_KEY, '');
}

function setHateChannelId(channelId, guildId = null) {
    return setSetting(hateChannelKey(guildId), String(channelId));
}

// ===== ROAST LINES =====
// {name} = display name, {ping} = raw <@id> mention.
const JABS = [
    "Also, {ping} nobody asked you. Ever.",
    "And {ping}? Still the weakest link. Don't @ me.",
    "Now {ping}, I know reading is hard for you, but try to keep up.",
    "{ping} would find a way to die to a marked room scav.",
    "For the record, {ping}, this is why nobody tables you for squads.",
    "{ping} thinks they're the main character. They're the tutorial.",
    "Try not to choke on your keyboard again, {ping}.",
    "{ping}'s stash is a crime against Tarkov.",
];

const CALL_OUTS = [
    "Ah look, {ping} crawled out of their JPG hole.",
    "Did {ping} actually just say something? Pinch me, I must be dreaming.",
    "Who let {ping} near the keyboard again.",
    "{ping} talking like anyone asked. Classic.",
    "Every time {ping} speaks, the lobby drops an FPS.",
    "Can someone mute {ping}? I'm trying to prep a raid here.",
    "Somebody get {ping} a map, they're lost again.",
    "{ping}'s aim is a war crime.",
];

const PROACTIVE = [
    "Hey {ping}, still lurking? Get better, then we talk.",
    "You know {ping}, I've been thinking... about how much you suck. A lot.",
    "Random check-in: {ping} still can't win a single fight. Confirmed.",
    "{ping}'s just here to feed the scavs I guess.",
    "Noticed {ping} being quiet. Probably busy dying to a pistol scav.",
    "Somebody remind {ping} that alt-F4 doesn't count as extracting.",
    "{ping} out here collecting deaths like they're loot.",
];

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function format(line, username, userId) {
    return line
        .replaceAll('{name}', username)
        .replaceAll('{ping}', `<@${userId}>`);
}

function buildHateJab(username, userId) {
    return format(pickRandom(JABS), username, userId);
}

function buildCallout(username, userId, tag = true) {
    // tag=true -> use {ping}; tag=false -> use {name}
    return format(pickRandom(CALL_OUTS), username, tag ? userId : '');
}

function buildProactiveRoast(username, userId) {
    return format(pickRandom(PROACTIVE), username, userId);
}

// ===== ABUSE-PROOF RATE LIMITING =====
// Tracks how often a single hated user gets targeted so the timer can't spam
// the same person over and over while they're online. Generous but sane.

const rateStore = new Map();

// Per-user global targetting cap: don't ping the same person more than ~4x /
// 10 min, and at least 45s between pings at anyone.
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PINGS_PER_WINDOW = 4;
const MIN_GAP_MS = 45_000;
let lastAnyPingAt = 0;

// Prune stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of rateStore) {
        if (now - data.windowStart > RATE_WINDOW_MS) rateStore.delete(userId);
    }
}, 5 * 60 * 1000);

function getRate(userId) {
    const now = Date.now();
    let data = rateStore.get(userId);
    if (!data || now - data.windowStart > RATE_WINDOW_MS) {
        data = { pings: 0, lastPingAt: 0, windowStart: now };
        rateStore.set(userId, data);
    }
    return data;
}

// True if this user is "on cooldown" — recently pinged a lot. Not resetting
// the counter here; that happens only when a ping is actually fired.
function isOnPingCooldown(userId) {
    const now = Date.now();
    const rate = getRate(userId);
    if (rate.pings >= MAX_PINGS_PER_WINDOW) return true;
    if (now - rate.lastPingAt < MIN_GAP_MS) return true;
    if (now - lastAnyPingAt < MIN_GAP_MS) return true;
    return false;
}

// Mark a ping as fired. Returns false if it shouldn't fire.
function canPing(userId) {
    if (isOnPingCooldown(userId)) return false;
    const rate = getRate(userId);
    rate.pings += 1;
    rate.lastPingAt = Date.now();
    lastAnyPingAt = Date.now();
    return true;
}

// ===== EXPORTS =====
module.exports = {
    HATE_KEY,
    HATE_CHANNEL_KEY,
    getHatedUserIds,
    isHated,
    addToHateList,
    removeFromHateList,
    getHateChannelId,
    setHateChannelId,
    buildHateJab,
    buildCallout,
    buildProactiveRoast,
    canPing,
    isOnPingCooldown,
};
