// logger.js
// Thin wrapper around database.js that provides the call signatures
// used throughout index.js.

const { logCommand: dbLogCommand, logSystem: dbLogSystem } = require('./database.js');

/**
 * Log a command/interaction.
 *
 * @param {string} platform   - 'discord' | 'twitch'
 * @param {string} username   - display name of the user
 * @param {string} command    - command name / event type
 * @param {string} message    - original message text
 * @param {string} response   - bot response text
 * @param {boolean} [isError] - true if this was an error response
 * @param {string}  [imageUrl]- Discord CDN URL for generated images
 */
function logCommand(platform, username, command, message, response, isError = false, imageUrl = null) {
    try {
        dbLogCommand({
            platform,
            username,
            command,
            message: message ? String(message).substring(0, 2000) : '',
            response: response ? String(response).substring(0, 4000) : null,
            image_url: imageUrl || null,
            error: isError ? 1 : 0
        });
    } catch (err) {
        console.error('[LOGGER] logCommand failed:', err.message);
    }
}

/**
 * Log a system event (startup, connection, error, etc.).
 *
 * @param {string} logType    - 'STARTUP' | 'CONNECTION' | 'ERROR' | 'INFO' | 'CULTIST' | etc.
 * @param {string} severity   - 'INFO' | 'WARNING' | 'ERROR'
 * @param {string} component  - 'discord' | 'twitch' | 'ai' | 'tarkov' | 'system' | etc.
 * @param {string} message    - human-readable message
 * @param {Error}  [errorObj] - optional Error instance for stack trace
 */
function logSystemEvent(logType, severity, component, message, errorObj = null) {
    try {
        dbLogSystem({
            log_type: logType,
            severity,
            component,
            message: message ? String(message).substring(0, 2000) : '',
            stack_trace: errorObj instanceof Error ? errorObj.stack : null,
            metadata: errorObj && !(errorObj instanceof Error)
                ? { extra: JSON.stringify(errorObj).substring(0, 1000) }
                : null
        });
    } catch (err) {
        console.error('[LOGGER] logSystemEvent failed:', err.message);
    }
}

module.exports = { logCommand, logSystemEvent };
