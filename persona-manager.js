// persona-manager.js
// Runtime state manager for AI personas.
// Wraps personas.js and exposes the getters/setters used in index.js.

// personas.js exports the PERSONAS object directly (not { personas })
const PERSONAS = require('./personas.js');

// Default to the first available persona at startup
let activePersonaName = Object.keys(PERSONAS)[0];

/**
 * Get the currently active persona object.
 * Falls back to the first persona if the stored name is no longer valid.
 * @returns {object} persona object with at minimum { name, systemPrompt }
 */
function getCurrentPersona() {
    if (PERSONAS[activePersonaName]) {
        return PERSONAS[activePersonaName];
    }
    // Fallback to first available
    const firstName = Object.keys(PERSONAS)[0];
    activePersonaName = firstName;
    return PERSONAS[firstName];
}

/**
 * Switch the active persona by name.
 * @param {string} name - persona key as defined in personas.js (e.g. 'aggressive', 'nice')
 * @returns {boolean} true if the switch succeeded, false if the name was not found
 */
function setPersona(name) {
    if (PERSONAS[name]) {
        activePersonaName = name;
        console.log(`[PERSONA] Switched to: ${name}`);
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
