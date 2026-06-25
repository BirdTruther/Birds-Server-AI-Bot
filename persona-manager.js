// persona-manager.js
// Runtime state manager for AI personas.

const PERSONAS = require('./personas.js');

// Use a Map to track the active persona per Discord Guild (Server)
const guildPersonas = new Map();
const defaultPersonaName = Object.keys(PERSONAS)[0];

/**
 * Get the currently active persona object for a specific guild.
 * @param {string} guildId - The Discord Server ID
 * @returns {object} persona object
 */
function getCurrentPersona(guildId) {
    const activeName = guildPersonas.get(guildId) || defaultPersonaName;
    return PERSONAS[activeName] || PERSONAS[defaultPersonaName];
}

/**
 * Switch the active persona for a specific guild.
 * @param {string} guildId - The Discord Server ID
 * @param {string} name - persona key as defined in personas.js
 * @returns {boolean} true if successful
 */
function setPersona(guildId, name) {
    if (PERSONAS[name]) {
        guildPersonas.set(guildId, name);
        console.log(`[PERSONA] Guild ${guildId} switched to: ${name}`);
        return true;
    }
    console.warn(`[PERSONA] Unknown persona: "${name}".`);
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
 * Generates an error message that matches the current persona's vibe.
 * @param {string} guildId - The Discord Server ID
 * @param {string} type - 'rate_limit', 'image_gen', 'image_read', 'general'
 * @returns {string|function}
 */
function getPersonaErrorMessage(guildId, type) {
    const currentName = guildPersonas.get(guildId) || defaultPersonaName;
    
    // You can expand this to include custom errors for every persona
    const isAggressive = currentName === 'aggressive';
    const isSleepy = currentName === 'sleepy';

    switch (type) {
        case 'rate_limit':
            return (minutesLeft) => {
                if (isAggressive) return `rate limited. try again in ${minutesLeft} mins and stop spamming 💀`;
                if (isSleepy) return `too many images... wait like ${minutesLeft} minutes or something 😴`;
                return `Whoa, slow down! Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}. 🖼️`;
            };

        case 'image_gen':
            if (isAggressive) return `image gen failed. skill issue tbh 🤡`;
            if (isSleepy) return `tried to make that image but... i lost it. try again later 🌿`;
            return `Something went wrong generating that image. Try again in a moment. 🎨`;

        case 'image_read':
            if (isAggressive) return `i can't read that format. send a normal JPG or PNG next time 🙄`;
            if (isSleepy) return `what even is this file... i can only read jpgs and pngs man 🤷‍♂️`;
            return `I couldn't read that image. Make sure it's a supported format (JPG, PNG, GIF, WebP). 🔍`;

        case 'general':
        default:
            if (isAggressive) return `it broke. don't look at me, you probably typed it wrong 😤`;
            if (isSleepy) return `something crashed... give me a second to reboot my brain ✌️`;
            return `Oops, I ran into an error. Try again in a second! ⚡`;
    }
}

module.exports = {
    getCurrentPersona,
    setPersona,
    getAvailablePersonas,
    getPersonaErrorMessage
};