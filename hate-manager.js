// hate-manager.js
// Tracks a "hate list" of Discord users the bot treats with extra venom.
// Persisted in the bot_settings key/value store (SQLite) so it survives reboots.
//
// This is a purely cosmetic/roleplay feature — the listed users still have full
// access to the bot; they just get roasted more.

const { getSetting, setSetting } = require('./database.js');

const HATE_KEY = 'hateList';

function getHatedUserIds() {
    try {
        const raw = getSetting(HATE_KEY, '[]');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch (err) {
        console.error('[HATE] Failed to parse hate list:', err.message);
        return [];
    }
}

function saveHatedUserIds(ids) {
    try {
        setSetting(HATE_KEY, JSON.stringify(ids));
        return true;
    } catch (err) {
        console.error('[HATE] Failed to save hate list:', err.message);
        return false;
    }
}

function isHated(userId) {
    return getHatedUserIds().includes(String(userId));
}

function addToHateList(userId) {
    const ids = getHatedUserIds();
    const id = String(userId);
    if (ids.includes(id)) return { ok: false, message: '⚠️ That user is already on the hate list.' };
    ids.push(id);
    saveHatedUserIds(ids);
    return { ok: true, message: '😈 Added to the hate list.' };
}

function removeFromHateList(userId) {
    const ids = getHatedUserIds();
    const id = String(userId);
    if (!ids.includes(id)) return { ok: false, message: "That user isn't on the hate list." };
    const remaining = ids.filter(x => x !== id);
    saveHatedUserIds(remaining);
    return { ok: true, message: '😇 Removed from the hate list.' };
}

// ===== ROAST JABS =====
// Used on AI replies and random callouts. {name} is the user's display name.

const JABS = [
    "Also, {name}, nobody asked you. Ever.",
    "And {name}? Still the weakest link. Don't @ me.",
    "Now {name}, I know reading is hard for you, but try to keep up.",
    "{name} would find a way to die to a marked room scav.",
    "For the record, {name}, this is why nobody tables you for squads.",
    "{name} thinks they're the main character. They're the tutorial.",
    "Try not to choke on your keyboard again, {name}.",
    "{name}'s Lara Croft quote is 'get looted'. Bum.",
];

const CALL_OUTS = [
    "Ah look, {name} crawled out of their JPG hole.",
    "Did {name} actually just say something? Pinch me, I must be dreaming.",
    "Who let {name} near the keyboard again.",
    "{name} talking like anyone asked. Classic.",
    "Every time {name} speaks, the lobby drops a FPS.",
    "Can someone mute {name}? I'm trying to prep a raid here.",
];

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function buildHateJab(username) {
    return pickRandom(JABS).replaceAll('{name}', username);
}

function buildCallout(username) {
    return pickRandom(CALL_OUTS).replaceAll('{name}', username);
}

// ===== EXPORTS =====
module.exports = {
    HATE_KEY,
    getHatedUserIds,
    isHated,
    addToHateList,
    removeFromHateList,
    buildHateJab,
    buildCallout,
};
