const { db } = require('./database.js');
const { logSystemEvent } = require('./logger.js');

// Create conversation memory table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_bot_response INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_timestamp ON conversation_memory(platform, channel_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_user ON conversation_memory(username);
  `);

  console.log('[MEMORY] Conversation memory tables initialized');
} catch (err) {
  console.error('[MEMORY] Table creation error:', err);
  logSystemEvent('MEMORY_INIT', 'ERROR', 'memory', `Table creation failed: ${err.message}`, err);
}

// Configuration
const CONFIG = {
  MAX_CONTEXT_MESSAGES: 8,        // How many messages to send to AI (reduced from unlimited)
  USER_MESSAGE_WEIGHT: 2,         // Prioritize user messages over bot responses
  RECENT_MESSAGES_COUNT: 5,       // Always include N most recent messages
  CLEANUP_AFTER_MESSAGES: 1000,   // Keep last N messages per channel
  MAX_MESSAGE_AGE_HOURS: 24       // Don't pull context older than this
};

// Store a message in memory
const storeMessage = db.prepare(`
  INSERT INTO conversation_memory (platform, channel_id, username, message, timestamp, is_bot_response)
  VALUES (@platform, @channel_id, @username, @message, @timestamp, @is_bot_response)
`);

function addToMemory(platform, channelId, username, message, isBotResponse = false) {
  try {
    storeMessage.run({
      platform,
      channel_id: channelId,
      username,
      message: message.substring(0, 500), // Truncate long messages
      timestamp: new Date().toISOString(),
      is_bot_response: isBotResponse ? 1 : 0
    });
  } catch (err) {
    console.error('[MEMORY] Store error:', err);
    logSystemEvent('MEMORY_STORE', 'ERROR', 'memory', `Failed to store message for ${platform}:${channelId}: ${err.message}`, err);
  }
}

// Get smart context - prioritize recent messages and user messages over bot responses
const getRecentMessages = db.prepare(`
  SELECT username, message, is_bot_response
  FROM conversation_memory
  WHERE platform = @platform
    AND channel_id = @channel_id
    AND datetime(timestamp) > datetime('now', '-' || @max_hours || ' hours')
  ORDER BY id DESC
  LIMIT @limit
`);

function getSmartContext(platform, channelId, currentUsername) {
  try {
    const messages = getRecentMessages.all({
      platform,
      channel_id: channelId,
      max_hours: CONFIG.MAX_MESSAGE_AGE_HOURS,
      limit: CONFIG.MAX_CONTEXT_MESSAGES * 2 // Get extra, then filter
    });

    if (messages.length === 0) {
      return 'This is the start of the conversation.';
    }

    // Reverse to chronological order
    messages.reverse();

    // Build context - format messages clearly
    const contextLines = messages.map(msg => {
      if (msg.is_bot_response) {
        return `ThePatrick: ${msg.message}`;
      }
      return `${msg.username}: ${msg.message}`;
    });

    // Take only the most recent messages to keep token usage low
    const recentContext = contextLines.slice(-CONFIG.MAX_CONTEXT_MESSAGES);

    return recentContext.join('\n');
  } catch (err) {
    console.error('[MEMORY] Context retrieval error:', err);
    logSystemEvent('MEMORY_CONTEXT', 'ERROR', 'memory', `Context retrieval failed for ${platform}:${channelId}: ${err.message}`, err);
    return 'Error loading conversation history.';
  }
}

// Get conversation statistics
const getMessageCount = db.prepare(`
  SELECT COUNT(*) as count
  FROM conversation_memory
  WHERE platform = @platform AND channel_id = @channel_id
`);

function getConversationStats(platform, channelId) {
  try {
    const result = getMessageCount.get({ platform, channel_id: channelId });
    return result.count;
  } catch (err) {
    console.error('[MEMORY] Stats error:', err);
    logSystemEvent('MEMORY_STATS', 'ERROR', 'memory', `Stats query failed for ${platform}:${channelId}: ${err.message}`, err);
    return 0;
  }
}

// Prepared statement for cleanupOldMemory — parameterized to prevent SQL injection
const cleanupOldMessages = db.prepare(`
  DELETE FROM conversation_memory
  WHERE id IN (
    SELECT id FROM conversation_memory
    WHERE platform = ? AND channel_id = ?
    ORDER BY id DESC
    LIMIT -1 OFFSET ?
  )
`);

// Clean up old messages (keep last N per channel)
function cleanupOldMemory(platform, channelId) {
  try {
    const count = getConversationStats(platform, channelId);

    if (count > CONFIG.CLEANUP_AFTER_MESSAGES) {
      const result = cleanupOldMessages.run(platform, channelId, CONFIG.CLEANUP_AFTER_MESSAGES);
      const msg = `Channel cleanup completed — ${result.changes} old messages removed for ${platform}:${channelId}`;
      console.log(`[MEMORY] ${msg}`);
      logSystemEvent('MEMORY_CLEANUP', 'INFO', 'memory', msg);
    }
  } catch (err) {
    console.error('[MEMORY] Cleanup error:', err);
    logSystemEvent('MEMORY_CLEANUP', 'ERROR', 'memory', `Channel cleanup failed for ${platform}:${channelId}: ${err.message}`, err);
  }
}

// Clear all memory for a channel
function clearChannelMemory(platform, channelId) {
  try {
    const result = db.prepare(`
      DELETE FROM conversation_memory
      WHERE platform = @platform AND channel_id = @channel_id
    `).run({ platform, channel_id: channelId });

    const msg = `Cleared ${result.changes} messages from ${platform}:${channelId}`;
    console.log(`[MEMORY] ${msg}`);
    logSystemEvent('MEMORY_CLEAR', 'INFO', 'memory', msg);
    return result.changes;
  } catch (err) {
    console.error('[MEMORY] Clear error:', err);
    logSystemEvent('MEMORY_CLEAR', 'ERROR', 'memory', `Clear failed for ${platform}:${channelId}: ${err.message}`, err);
    return 0;
  }
}

// Prepared statement for periodic cleanup
const purgeAgedMessages = db.prepare(`
  DELETE FROM conversation_memory
  WHERE datetime(timestamp) < datetime('now', '-7 days')
`);

// Periodic cleanup - run every hour
setInterval(() => {
  try {
    const result = purgeAgedMessages.run();
    const deleted = result.changes;
    const severity = deleted === 0 ? 'WARNING' : 'INFO';
    const msg = deleted === 0
      ? 'Periodic cleanup ran — 0 rows deleted (nothing aged out yet)'
      : `Periodic cleanup completed — ${deleted} aged messages removed`;
    console.log(`[MEMORY] ${msg}`);
    logSystemEvent('MEMORY_PERIODIC_CLEANUP', severity, 'memory', msg);
  } catch (err) {
    console.error('[MEMORY] Periodic cleanup error:', err);
    logSystemEvent('MEMORY_PERIODIC_CLEANUP', 'ERROR', 'memory', `Periodic cleanup failed: ${err.message}`, err);
  }
}, 60 * 60 * 1000); // Every hour

module.exports = {
  addToMemory,
  getSmartContext,
  getConversationStats,
  cleanupOldMemory,
  clearChannelMemory
};
