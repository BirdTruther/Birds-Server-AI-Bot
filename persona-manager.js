// persona-manager.js
// Runtime state manager for AI personas.
// Wraps personas.js and exposes the getters/setters used in index.js.
//
// NOTE: activePersonaName is persisted to the shared SQLite database via
// getSetting/setSetting so that index.js (Discord/Twitch process) and
// dashboard-server.js (Express process) always share the same persona state.
// Without this, each process holds its own in-memory copy and they diverge.

const PERSONAS = require('./personas.js');
const { getSetting, setSetting } = require('./database.js');

const defaultPersonaName = Object.keys(PERSONAS)[0];

// Personas can be set per Discord server (guild) so each community picks its
// own vibe (e.g. funny vs. rude). Non-Discord surfaces (Twitch, DMs) and any
// guild without an override fall back to the global `activePersona` setting.
function personaKey(guildId) {
    return guildId ? `activePersona:${guildId}` : 'activePersona';
}

/**
 * Get the currently active persona key from the shared database.
 * @param {string|null} guildId - Discord guild to read the override for
 * @returns {string} persona key (e.g. 'aggressive')
 */
function getActivePersonaName(guildId = null) {
    const stored = guildId
        ? getSetting(personaKey(guildId), null) ?? getSetting('activePersona', defaultPersonaName)
        : getSetting('activePersona', defaultPersonaName);
    // Validate it's still a real key (in case personas.js changed)
    return PERSONAS[stored] ? stored : defaultPersonaName;
}

/**
 * Get the currently active persona object.
 * Returns the persona object extended with a `key` property so callers
 * don't need to do fragile name-matching to figure out the active key.
 * @param {string|null} guildId
 * @returns {object} persona object with .key plus all fields from personas.js
 */
function getCurrentPersona(guildId = null) {
    const key = getActivePersonaName(guildId);
    return { key, ...PERSONAS[key] };
}

/**
 * Switch the active persona by key name.
 * Persists the change to the database so both processes see it immediately.
 * @param {string} name - persona key as defined in personas.js (e.g. 'aggressive', 'nice')
 * @param {string|null} guildId - set per-guild, or null for the global default
 * @returns {boolean} true if the switch succeeded, false if the name was not found
 */
function setPersona(name, guildId = null) {
    if (PERSONAS[name]) {
        setSetting(personaKey(guildId), name);
        console.log(`[PERSONA] Switched to: ${name}${guildId ? ` (guild ${guildId})` : ' (global)'}`);
        return true;
    }
    console.warn(`[PERSONA] Unknown persona: "${name}". Available: ${Object.keys(PERSONAS).join(', ')}`);
    return false;
}

/**
 * Return an array of available persona keys.
 * @returns {string[]}
 */
function getAvailablePersonas() {
    return Object.keys(PERSONAS);
}

/**
 * Return a ready-to-send error message string for the given error context.
 *
 * Call sites in index.js:
 *   getPersonaErrorMessage('general')          -> string
 *   getPersonaErrorMessage('rate_limit')(mins)  -> string  (curried)
 *   getPersonaErrorMessage('image_gen')         -> string
 *   getPersonaErrorMessage('image_read')        -> string
 *
 * @param {string} type
 * @returns {string|function}
 */
function getPersonaErrorMessage(type) {
    switch (type) {
        case 'rate_limit':
            return (minutesLeft) =>
                `Whoa, slow down! You've hit the image generation limit. ` +
                `Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}. \uD83D\uDDBC\uFE0F`;

        case 'image_gen':
            return `Something went wrong generating that image. Try again in a moment. \uD83C\uDFA8`;

        case 'image_read':
            return `I couldn't read that image. Make sure it's a supported format (JPG, PNG, GIF, WebP) and try again. \uD83D\uDD0D`;

        case 'general':
        default:
            return `Oops, I ran into an error. Try again in a second! \u26A1`;
    }
}

module.exports = {
    getCurrentPersona,
    setPersona,
    getAvailablePersonas,
    getPersonaErrorMessage
};
