// persona-manager.js
// Runtime state manager for AI personas.
// Wraps personas.js and exposes the getters/setters used in index.js.

const { personas } = require('./personas.js');

// Default to the first available persona at startup
let activePersonaName = Object.keys(personas)[0];

/**
 * Get the currently active persona object.
 * Falls back to the first persona if the stored name is no longer valid.
 * @returns {object} persona object with at minimum { name, systemPrompt }
 */
function getCurrentPersona() {
    if (personas[activePersonaName]) {
        return personas[activePersonaName];
    }
    // Fallback to first available
    const firstName = Object.keys(personas)[0];
    activePersonaName = firstName;
    return personas[firstName];
}

/**
 * Switch the active persona by name.
 * @param {string} name - persona key as defined in personas.js
 * @returns {boolean} true if the switch succeeded, false if the name was not found
 */
function setPersona(name) {
    if (personas[name]) {
        activePersonaName = name;
        console.log(`[PERSONA] Switched to: ${name}`);
        return true;
    }
    console.warn(`[PERSONA] Unknown persona: "${name}". Available: ${Object.keys(personas).join(', ')}`);
    return false;
}

/**
 * Return a sorted array of available persona names.
 * @returns {string[]}
 */
function getAvailablePersonas() {
    return Object.keys(personas);
}

/**
 * Return a ready-to-send error message string appropriate for the given
 * error context.  Matches the call sites in index.js:
 *
 *   getPersonaErrorMessage('general')          -> string
 *   getPersonaErrorMessage('rate_limit')(mins)  -> string  (curried)
 *   getPersonaErrorMessage('image_gen')         -> string
 *   getPersonaErrorMessage('image_read')        -> string
 *
 * @param {string} type - 'general' | 'rate_limit' | 'image_gen' | 'image_read'
 * @returns {string|function}
 */
function getPersonaErrorMessage(type) {
    const persona = getCurrentPersona();
    const name = persona.name || 'ThePatrick';

    switch (type) {
        case 'rate_limit':
            // Returns a curried function: getPersonaErrorMessage('rate_limit')(minutesLeft)
            return (minutesLeft) =>
                `Whoa, slow down! You've hit the image generation limit. ` +
                `Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}. 🖼️`;

        case 'image_gen':
            return `Something went wrong generating that image. Try again in a moment. 🎨`;

        case 'image_read':
            return `I couldn't read that image. Make sure it's a supported format (JPG, PNG, GIF, WebP) and try again. 🔍`;

        case 'general':
        default:
            return `Oops, I ran into an error. Try again in a second! ⚡`;
    }
}

module.exports = {
    getCurrentPersona,
    setPersona,
    getAvailablePersonas,
    getPersonaErrorMessage
};
