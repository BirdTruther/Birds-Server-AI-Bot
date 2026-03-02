const { db } = require('./database.js');

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
    return 0;
  }
}

// Clean up old messages (keep last N per channel)
function cleanupOldMemory(platform, channelId) {
  try {
    const count = getConversationStats(platform, channelId);

    if (count > CONFIG.CLEANUP_AFTER_MESSAGES) {
      db.exec(`
        DELETE FROM conversation_memory
        WHERE id IN (
          SELECT id FROM conversation_memory
          WHERE platform = '${platform}' AND channel_id = '${channelId}'
          ORDER BY id DESC
          LIMIT -1 OFFSET ${CONFIG.CLEANUP_AFTER_MESSAGES}
        )
      `);

      console.log(`[MEMORY] Cleaned up old messages for ${platform}:${channelId}`);
    }
  } catch (err) {
    console.error('[MEMORY] Cleanup error:', err);
  }
}

// Clear all memory for a channel
function clearChannelMemory(platform, channelId) {
  try {
    const result = db.prepare(`
      DELETE FROM conversation_memory
      WHERE platform = @platform AND channel_id = @channel_id
    `).run({ platform, channel_id: channelId });

    console.log(`[MEMORY] Cleared ${result.changes} messages from ${platform}:${channelId}`);
    return result.changes;
  } catch (err) {
    console.error('[MEMORY] Clear error:', err);
    return 0;
  }
}

// Periodic cleanup - run every hour
setInterval(() => {
  try {
    // Clean up very old messages (older than 7 days)
    const result = db.exec(`
      DELETE FROM conversation_memory
      WHERE datetime(timestamp) < datetime('now', '-7 days')
    `);

    console.log('[MEMORY] Periodic cleanup completed');
  } catch (err) {
    console.error('[MEMORY] Periodic cleanup error:', err);
  }
}, 60 * 60 * 1000); // Every hour

module.exports = {
  addToMemory,
  getSmartContext,
  getConversationStats,
  cleanupOldMemory,
  clearChannelMemory
};
