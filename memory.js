const { db, getSetting, setSetting } = require('./database.js');
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

// ===== LONG-TERM FACT SHEET =====
// Durable, AI-maintained facts for the server. Stored as a JSON blob in
// bot_settings (same pattern as the hate list). The AI rewrites the whole
// sheet each consolidation pass, so facts can be added, changed, or removed.
const FACT_MAX        = 25;   // Max facts stored for the server
const FACT_MAX_LEN    = 140;  // Max chars per fact
const FACT_TOPIC_MAX  = 8;    // Max topics per fact
const MIN_NEW_MESSAGES = 5;   // Consolidation skips unless this many new msgs

// Facts are server-wide. Keep the key names stable so the sheet survives
// restarts and future config changes.
const FACTS_SCOPE = 'global';
function factsKey()       { return `memoryFacts:${FACTS_SCOPE}`; }
function factsLastIdKey() { return `memoryFactsLastId:${FACTS_SCOPE}`; }

// Get server facts, optionally filtered to one topic (e.g. a username).
function getLongTermFacts(platform, channelId, filterTopic) {
  try {
    let facts = [];
    const stored = getSetting(factsKey(), null);
    try { facts = JSON.parse(stored || '[]'); }
    catch { facts = []; }
    if (!Array.isArray(facts)) facts = [];

    // Migrate existing channel sheets into the new server-wide sheet on the
    // first read, without deleting the old settings until consolidation saves.
    if (!stored) {
      const legacyRows = db.prepare("SELECT value FROM bot_settings WHERE key LIKE 'memoryFacts:%' AND key != ?").all(factsKey());
      for (const row of legacyRows) {
        try {
          const legacy = JSON.parse(row.value);
          if (Array.isArray(legacy)) facts.push(...legacy);
        } catch { /* ignore malformed legacy sheets */ }
      }
    }
    if (filterTopic) {
      const t = String(filterTopic).toLowerCase();
      const norm = t.replace(/[^a-z0-9]/g, '');
      facts = facts.filter(f => (f.topics || []).some(x => {
        const xt = String(x).toLowerCase();
        // Exact match, or a normalized (alphanumeric-only) containment so a
        // stored username like "stoutirish" matches a queried display name
        // like "stout_irish" / "Jeff (Stout_Irish)".
        if (xt === t) return true;
        if (!norm) return false;
        const xnorm = xt.replace(/[^a-z0-9]/g, '');
        return xnorm && (xnorm.includes(norm) || norm.includes(xnorm));
      }));
    }
    return facts;
  } catch (err) {
    console.error('[MEMORY] getFacts error:', err);
    logSystemEvent('MEMORY_FACTS', 'ERROR', 'memory', `Failed to load facts for ${channelId}: ${err.message}`, err);
    return [];
  }
}

// Normalize a single fact into a safe shape, preserving the pinned flag.
function normalizeFact(f) {
  return {
    fact:   String((f && f.fact) || '').substring(0, FACT_MAX_LEN).trim(),
    topics: Array.isArray(f && f.topics)
      ? (f.topics).slice(0, FACT_TOPIC_MAX).map(String).filter(t => t.trim())
      : [],
    pinned: !!(f && f.pinned),
  };
}

// Manually-added facts are pinned and must outlive AI consolidation.
function isPinned(f) { return !!(f && f.pinned); }

// Determine whether two facts plausibly describe the same thing (used to
// decide if a disk-pinned fact has been replaced by a newer pinned version).
function factsOverlap(a, b) {
  if (a.fact.toLowerCase() === b.fact.toLowerCase()) return true;
  const at = (a.topics || []).map(String).map(t => t.toLowerCase());
  const bt = (b.topics || []).map(String).map(t => t.toLowerCase());
  return at.some(t => bt.includes(t));
}

// Validate + cap a fact array, then persist it. Pinned facts are never
// dropped: whatever the caller (or the AI) returns, any fact already pinned
// in the stored sheet is re-merged before saving, so a manual fact can't be
// lost to consolidation, the 25-fact cap, or model omission. When the AI
// returns a newer pinned version of a pinned fact (edit/rename), the newer
// version wins. Duplicates are resolved in favour of the incoming entry.
function saveFacts(platform, channelId, facts) {
  const incoming = Array.isArray(facts)
    ? facts.map(normalizeFact).filter(f => f.fact)
    : [];

  // Pinned facts currently on disk — these must survive.
  const stored = getLongTermFacts(platform, channelId);
  const storedPinned = stored.filter(isPinned);

  // Re-merge pinned facts from disk. The AI never sets "pinned" on its
  // output, so if it regenerates text that matches a disk-pinned fact,
  // the unpinned copy would win dedup (first-in) and silently kill the pin.
  // Fix: when a disk-pinned fact is covered by an incoming fact (same text
  // or overlapping topics), REPLACE the incoming version with the pinned
  // copy so the flag survives. When not covered, push it as before.
  for (const sp of storedPinned) {
    const coveredIdx = incoming.findIndex(inc => factsOverlap(sp, inc));
    if (coveredIdx !== -1) {
      incoming[coveredIdx] = { ...sp, fact: incoming[coveredIdx].fact };
    } else {
      incoming.push(sp);
    }
  }

  // De-duplicate by fact text (case-insensitive), keeping the first.
  const seen = new Set();
  const deduped = incoming.filter(inc => {
    const key = inc.fact.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cap. Pinned facts are prioritised so they can't be pushed out by overflow.
  const pinnned = deduped.filter(isPinned);
  const unpinned = deduped.filter(f => !isPinned(f));
  const trimmed = [...pinnned, ...unpinned].slice(0, FACT_MAX);

  setSetting(factsKey(), JSON.stringify(trimmed));
  return trimmed;
}

// Low-level writer used by explicit admin operations (edit/delete/pin).
// Unlike saveFacts, this does NOT re-merge existing pinned facts from disk —
// the caller has decided the exact final set, so we write it verbatim
// (normalized, deduped, capped). Pinned flags on the passed facts are kept.
function replaceFacts(platform, channelId, facts) {
  const incoming = Array.isArray(facts)
    ? facts.map(normalizeFact).filter(f => f.fact)
    : [];
  const seen = new Set();
  const deduped = incoming.filter(inc => {
    const key = inc.fact.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const pinnned = deduped.filter(isPinned);
  const unpinned = deduped.filter(f => !isPinned(f));
  const trimmed = [...pinnned, ...unpinned].slice(0, FACT_MAX);
  setSetting(factsKey(), JSON.stringify(trimmed));
  return trimmed;
}

function getLastConsolidatedId(channelId) {
  return parseInt(getSetting(factsLastIdKey(), '0'), 10) || 0;
}

function setLastConsolidatedId(channelId, id) {
  setSetting(factsLastIdKey(), String(id));
}

// Pull new messages since a given id (bounded) — used to feed consolidation.
const getMessagesSince = db.prepare(`
  SELECT id, username, message, is_bot_response
  FROM conversation_memory
  WHERE platform = @platform AND id > @after
  ORDER BY id ASC
  LIMIT @limit
`);

function getNewMessagesSince(platform, channelId, afterId, limit = 100) {
  return getMessagesSince.all({ platform, channel_id: channelId, after: afterId, limit });
}

// Render facts as a ready-to-inject block string (empty if none).
// Optional filterTopic narrows to facts whose topics include that value.
function getContextFacts(platform, channelId, filterTopic) {
  const facts = getLongTermFacts(platform, channelId, filterTopic);
  if (!facts.length) return '';
  return facts
    .map((f, i) => `${i + 1}. ${f.fact}` + (f.topics && f.topics.length ? ` [${f.topics.join(', ')}]` : ''))
    .join('\n');
}

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

    // Build context - format messages clearly. Strip the <proactive> marker
    // from stored proactive roasts so it doesn't leak into conversation
    // context, but keep the roast itself for recall.
    const contextLines = messages.map(msg => {
      if (msg.is_bot_response) {
        const text = String(msg.message).replace(/^<proactive>/, '');
        return `ThePatrick: ${text}`;
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
  clearChannelMemory,
  // Long-term facts
  getLongTermFacts,
  saveFacts,
  getLastConsolidatedId,
  setLastConsolidatedId,
  getNewMessagesSince,
  getContextFacts,
  MIN_NEW_MESSAGES,
  FACT_MAX,
  FACT_MAX_LEN,
  isPinned,
  normalizeFact,
  replaceFacts,
};
