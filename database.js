const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Try multiple paths in order of preference
const possiblePaths = [
  path.join(__dirname, 'data', 'bot-logs.db'),       // Best: local data directory
  path.join(__dirname, 'bot-logs.db'),                // Good: current directory
  path.join(os.tmpdir(), 'birds-bot-logs.db'),       // Fallback: system tmp (survives until reboot)
  path.join('/var/tmp', 'birds-bot-logs.db')         // Last resort: var tmp (survives reboots)
];

let db = null;
let dbPath = null;

// Try each path until one works
for (const tryPath of possiblePaths) {
  try {
    // Try to create directory if needed
    const dir = path.dirname(tryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
    
    // Try to open database
    db = new Database(tryPath);
    dbPath = tryPath;
    console.log('[DATABASE] SQLite opened successfully:', dbPath);
    break;
  } catch (err) {
    console.warn(`[DATABASE] Could not use ${tryPath}:`, err.message);
    continue;
  }
}

if (!db) {
  console.error('[DATABASE] FATAL: Could not open database at any location');
  console.error('[DATABASE] Tried paths:', possiblePaths);
  console.error('[DATABASE] Please check systemd service user permissions');
  process.exit(1);
}

// Enable WAL mode for better concurrent access
try {
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.warn('[DATABASE] Could not enable WAL mode:', err.message);
}

// Create logs table if it doesn't exist
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      command TEXT NOT NULL,
      message TEXT NOT NULL,
      response TEXT,
      image_url TEXT,
      error INTEGER DEFAULT 0
    )
  `);

  // Create system logs table for crashes, startups, shutdowns
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      log_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      stack_trace TEXT,
      metadata TEXT
    )
  `);

  // Create bot_settings table for persisting toggle states across reboots
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Tarkov seasonal wipe — characters and their up-to-3 allergies
  db.exec(`
    CREATE TABLE IF NOT EXISTS tarkov_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tarkov_allergies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      allergy TEXT NOT NULL,
      UNIQUE(character_id, allergy),
      FOREIGN KEY(character_id) REFERENCES tarkov_characters(id) ON DELETE CASCADE
    )
  `);

  // Create index for faster queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON command_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_platform ON command_logs(platform);
    CREATE INDEX IF NOT EXISTS idx_system_timestamp ON system_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_system_type ON system_logs(log_type);
    CREATE INDEX IF NOT EXISTS idx_system_severity ON system_logs(severity);
  `);

  // Multi-guild: tag command logs with the Discord guild they came from so the
  // dashboard can show each server its own logs. Additive migration — existing
  // rows keep guild_id NULL and are only visible to the superadmin.
  try {
    const cols = db.prepare("PRAGMA table_info(command_logs)").all();
    if (!cols.some(c => c.name === 'guild_id')) {
      db.exec("ALTER TABLE command_logs ADD COLUMN guild_id TEXT");
      console.log('[DATABASE] Added guild_id column to command_logs');
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_command_guild ON command_logs(guild_id)");
  } catch (err) {
    console.error('[DATABASE] guild_id migration failed:', err.message);
  }

  console.log('[DATABASE] Tables initialized successfully');
} catch (err) {
  console.error('[DATABASE] Failed to create tables:', err);
  process.exit(1);
}

// Insert log entry
const insertLog = db.prepare(`
  INSERT INTO command_logs (timestamp, platform, username, command, message, response, image_url, error, guild_id)
  VALUES (@timestamp, @platform, @username, @command, @message, @response, @image_url, @error, @guild_id)
`);

function logCommand(entry) {
  try {
    insertLog.run({
      timestamp: new Date().toISOString(),
      platform: entry.platform || 'unknown',
      username: entry.username || 'unknown',
      command: entry.command || '',
      message: entry.message || '',
      response: entry.response || null,
      image_url: entry.image_url || null,
      error: entry.error ? 1 : 0,
      guild_id: entry.guild_id || null
    });
  } catch (err) {
    console.error('[DATABASE] Insert error:', err);
  }
}

// Insert system log entry
const insertSystemLog = db.prepare(`
  INSERT INTO system_logs (timestamp, log_type, severity, component, message, stack_trace, metadata)
  VALUES (@timestamp, @log_type, @severity, @component, @message, @stack_trace, @metadata)
`);

function logSystem(entry) {
  try {
    insertSystemLog.run({
      timestamp: entry.timestamp || new Date().toISOString(),
      log_type: entry.log_type || 'INFO',
      severity: entry.severity || 'INFO',
      component: entry.component || 'system',
      message: entry.message || '',
      stack_trace: entry.stack_trace || null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null
    });
  } catch (err) {
    console.error('[DATABASE] System log insert error:', err);
  }
}

// Get recent logs with optional filters
const getLogsStmt = db.prepare(`
  SELECT * FROM command_logs
  WHERE (@platform = 'all' OR platform = @platform)
  ORDER BY id DESC
  LIMIT @limit
`);

const getLogsByGuildStmt = db.prepare(`
  SELECT * FROM command_logs
  WHERE (@platform = 'all' OR platform = @platform)
    AND guild_id = @guild_id
  ORDER BY id DESC
  LIMIT @limit
`);

function getLogs(platform = 'all', limit = 100, guildId = null) {
  try {
    if (guildId) {
      return getLogsByGuildStmt.all({ platform, guild_id: String(guildId), limit: Math.min(limit, 1000) });
    }
    return getLogsStmt.all({ platform, limit: Math.min(limit, 1000) });
  } catch (err) {
    console.error('[DATABASE] Query error:', err);
    return [];
  }
}

// Get system logs with optional filters
const getSystemLogsStmt = db.prepare(`
  SELECT * FROM system_logs
  WHERE (@log_type = 'all' OR log_type = @log_type)
    AND (@severity = 'all' OR severity = @severity)
    AND (@component = 'all' OR component = @component)
  ORDER BY id DESC
  LIMIT @limit
`);

function getSystemLogs(filters = {}) {
  try {
    const { log_type = 'all', severity = 'all', component = 'all', limit = 100 } = filters;
    return getSystemLogsStmt.all({ 
      log_type, 
      severity, 
      component, 
      limit: Math.min(limit, 1000) 
    });
  } catch (err) {
    console.error('[DATABASE] System logs query error:', err);
    return [];
  }
}

// Get total log count
const getCountStmt = db.prepare('SELECT COUNT(*) as count FROM command_logs');
const getSystemCountStmt = db.prepare('SELECT COUNT(*) as count FROM system_logs');

function getLogCount() {
  try {
    return getCountStmt.get().count;
  } catch (err) {
    console.error('[DATABASE] Count error:', err);
    return 0;
  }
}

function getSystemLogCount() {
  try {
    return getSystemCountStmt.get().count;
  } catch (err) {
    console.error('[DATABASE] System count error:', err);
    return 0;
  }
}

// Clear all logs
function clearLogs() {
  try {
    db.exec('DELETE FROM command_logs');
    db.exec('VACUUM');
    console.log('[DATABASE] All command logs cleared');
    return true;
  } catch (err) {
    console.error('[DATABASE] Clear error:', err);
    return false;
  }
}

function clearSystemLogs() {
  try {
    db.exec('DELETE FROM system_logs');
    db.exec('VACUUM');
    console.log('[DATABASE] All system logs cleared');
    return true;
  } catch (err) {
    console.error('[DATABASE] Clear system logs error:', err);
    return false;
  }
}

// Cleanup old logs (keep last 10,000 entries)
function cleanupOldLogs() {
  try {
    db.exec(`
      DELETE FROM command_logs
      WHERE id NOT IN (
        SELECT id FROM command_logs
        ORDER BY id DESC
        LIMIT 10000
      )
    `);
    const changes = db.prepare('SELECT changes() as deleted').get().deleted;
    if (changes > 0) {
      console.log(`[DATABASE] Cleaned up ${changes} old command log entries`);
      db.exec('VACUUM');
    }
  } catch (err) {
    console.error('[DATABASE] Cleanup error:', err);
  }
}

function cleanupOldSystemLogs() {
  try {
    db.exec(`
      DELETE FROM system_logs
      WHERE id NOT IN (
        SELECT id FROM system_logs
        ORDER BY id DESC
        LIMIT 5000
      )
    `);
    const changes = db.prepare('SELECT changes() as deleted').get().deleted;
    if (changes > 0) {
      console.log(`[DATABASE] Cleaned up ${changes} old system log entries`);
      db.exec('VACUUM');
    }
  } catch (err) {
    console.error('[DATABASE] System cleanup error:', err);
  }
}

// Run cleanup daily
setInterval(() => {
  cleanupOldLogs();
  cleanupOldSystemLogs();
}, 24 * 60 * 60 * 1000);

// ===== BOT SETTINGS (key/value store for persisting toggles across reboots) =====

function getSetting(key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (err) {
    console.error('[DATABASE] getSetting error:', err);
    return defaultValue;
  }
}

function setSetting(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)').run(key, String(value));
    return true;
  } catch (err) {
    console.error('[DATABASE] setSetting error:', err);
    return false;
  }
}

// ===== TARKOV SEASONAL ALLERGIES =====

const MAX_ALLERGIES = 3;

function normalizeAllergy(allergy) {
  return String(allergy || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getCharacterByUserId(userId) {
  try {
    return db.prepare('SELECT * FROM tarkov_characters WHERE user_id = ?').get(String(userId)) || null;
  } catch (err) {
    console.error('[DATABASE] getCharacterByUserId error:', err);
    return null;
  }
}

function getOrCreateCharacter(userId, name = '') {
  try {
    const existing = getCharacterByUserId(userId);
    if (existing) {
      if (name && name !== existing.name) {
        db.prepare('UPDATE tarkov_characters SET name = ? WHERE id = ?').run(name, existing.id);
        existing.name = name;
      }
      return existing;
    }
    const info = db.prepare('INSERT INTO tarkov_characters (user_id, name) VALUES (?, ?)').run(String(userId), name);
    return { id: Number(info.lastInsertRowid), user_id: String(userId), name, created_at: null };
  } catch (err) {
    console.error('[DATABASE] getOrCreateCharacter error:', err);
    return null;
  }
}

function getCharacterAllergies(userId) {
  try {
    const character = getCharacterByUserId(userId);
    if (!character) return { character, allergies: [] };
    const rows = db.prepare(
      'SELECT allergy FROM tarkov_allergies WHERE character_id = ? ORDER BY id ASC'
    ).all(character.id);
    return { character, allergies: rows.map(r => r.allergy) };
  } catch (err) {
    console.error('[DATABASE] getCharacterAllergies error:', err);
    return { character: null, allergies: [] };
  }
}

function addAllergy(userId, allergy, name = '') {
  const normalized = normalizeAllergy(allergy);
  if (!normalized) return { ok: false, message: '❌ Allergy name cannot be empty.' };

  const character = getOrCreateCharacter(userId, name);
  if (!character) return { ok: false, message: '❌ Could not create character.' };

  const { allergies } = getCharacterAllergies(userId);
  if (allergies.includes(normalized)) return { ok: false, message: `⚠️ **${normalized}** is already on your list.` };
  if (allergies.length >= MAX_ALLERGIES) {
    return {
      ok: false,
      message: `❌ You already have **${allergies.length}/${MAX_ALLERGIES}** allergies (${allergies.join(', ')}).\nUse \`/removeallergy\` first.`
    };
  }

  try {
    db.prepare('INSERT INTO tarkov_allergies (character_id, allergy) VALUES (?, ?)').run(character.id, normalized);
    return { ok: true, message: `✅ Added **${normalized}**. Allergies (${allergies.length + 1}/${MAX_ALLERGIES}): ${[...allergies, normalized].join(', ')}` };
  } catch (err) {
    console.error('[DATABASE] addAllergy error:', err);
    return { ok: false, message: '❌ Could not add allergy.' };
  }
}

function removeAllergy(userId, allergy) {
  const normalized = normalizeAllergy(allergy);
  if (!normalized) return { ok: false, message: '❌ Allergy name cannot be empty.' };

  const character = getCharacterByUserId(userId);
  if (!character) return { ok: false, message: `❌ You don't have any allergies registered.` };

  try {
    const info = db.prepare('DELETE FROM tarkov_allergies WHERE character_id = ? AND allergy = ?').run(character.id, normalized);
    if (info.changes === 0) return { ok: false, message: `❌ **${normalized}** is not on your list.` };

    const { allergies } = getCharacterAllergies(userId);
    return {
      ok: true,
      message: allergies.length > 0
        ? `✅ Removed **${normalized}**. Remaining (${allergies.length}/${MAX_ALLERGIES}): ${allergies.join(', ')}`
        : `✅ Removed **${normalized}**. You now have no allergies.`
    };
  } catch (err) {
    console.error('[DATABASE] removeAllergy error:', err);
    return { ok: false, message: '❌ Could not remove allergy.' };
  }
}

function searchAllergyHolders(allergy) {
  const normalized = normalizeAllergy(allergy);
  if (!normalized) return [];
  try {
    return db.prepare(`
      SELECT c.user_id, c.name, c.id AS character_id
      FROM tarkov_allergies a
      JOIN tarkov_characters c ON c.id = a.character_id
      WHERE a.allergy = ?
      ORDER BY c.name, c.id
    `).all(normalized);
  } catch (err) {
    console.error('[DATABASE] searchAllergyHolders error:', err);
    return [];
  }
}

function getCommonAllergies() {
  try {
    return db.prepare(`
      SELECT a.allergy, COUNT(*) AS holders
      FROM tarkov_allergies a
      GROUP BY a.allergy
      HAVING COUNT(*) >= 2
      ORDER BY holders DESC, a.allergy ASC
    `).all();
  } catch (err) {
    console.error('[DATABASE] getCommonAllergies error:', err);
    return [];
  }
}

function getAllCharacters() {
  try {
    return db.prepare(`
      SELECT c.user_id, c.name, c.id AS character_id,
             GROUP_CONCAT(a.allergy, ', ') AS allergy_list
      FROM tarkov_characters c
      LEFT JOIN tarkov_allergies a ON a.character_id = c.id
      GROUP BY c.id
      ORDER BY c.name, c.id
    `).all();
  } catch (err) {
    console.error('[DATABASE] getAllCharacters error:', err);
    return [];
  }
}

// Graceful shutdown
function closeDatabase() {
  try {
    if (db) {
      db.close();
      console.log('[DATABASE] Closed successfully');
    }
  } catch (err) {
    console.error('[DATABASE] Error closing database:', err);
  }
}

process.on('exit', closeDatabase);
process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});

module.exports = {
  db,
  dbPath,
  logCommand,
  logSystem,
  getLogs,
  getSystemLogs,
  getLogCount,
  getSystemLogCount,
  clearLogs,
  clearSystemLogs,
  getSetting,
  setSetting,
  getOrCreateCharacter,
  getCharacterAllergies,
  addAllergy,
  removeAllergy,
  searchAllergyHolders,
  getCommonAllergies,
  getAllCharacters
};
