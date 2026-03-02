const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists with proper permissions
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    console.log('[DATABASE] Created data directory:', dataDir);
  } catch (err) {
    console.error('[DATABASE] Failed to create data directory:', err);
    console.error('[DATABASE] Falling back to current directory');
  }
}

// Initialize SQLite database in data directory (or fallback to current dir)
const dbPath = fs.existsSync(dataDir) 
  ? path.join(dataDir, 'bot-logs.db')
  : path.join(__dirname, 'bot-logs.db');

let db;
try {
  db = new Database(dbPath);
  console.log('[DATABASE] SQLite initialized -', dbPath);
} catch (err) {
  console.error('[DATABASE] Failed to open database:', err);
  console.error('[DATABASE] Please ensure the directory has write permissions');
  process.exit(1);
}

// Enable WAL mode for better concurrent access
try {
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.warn('[DATABASE] Could not enable WAL mode:', err);
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

  // Create index for faster queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON command_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_platform ON command_logs(platform);
  `);
} catch (err) {
  console.error('[DATABASE] Failed to create tables:', err);
  process.exit(1);
}

console.log('[DATABASE] Tables initialized successfully');

// Insert log entry
const insertLog = db.prepare(`
  INSERT INTO command_logs (timestamp, platform, username, command, message, response, image_url, error)
  VALUES (@timestamp, @platform, @username, @command, @message, @response, @image_url, @error)
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
      error: entry.error ? 1 : 0
    });
  } catch (err) {
    console.error('[DATABASE] Insert error:', err);
  }
}

// Get recent logs with optional filters
const getLogsStmt = db.prepare(`
  SELECT * FROM command_logs
  WHERE (@platform = 'all' OR platform = @platform)
  ORDER BY id DESC
  LIMIT @limit
`);

function getLogs(platform = 'all', limit = 100) {
  try {
    return getLogsStmt.all({ platform, limit: Math.min(limit, 1000) });
  } catch (err) {
    console.error('[DATABASE] Query error:', err);
    return [];
  }
}

// Get total log count
const getCountStmt = db.prepare('SELECT COUNT(*) as count FROM command_logs');

function getLogCount() {
  try {
    return getCountStmt.get().count;
  } catch (err) {
    console.error('[DATABASE] Count error:', err);
    return 0;
  }
}

// Clear all logs
function clearLogs() {
  try {
    db.exec('DELETE FROM command_logs');
    db.exec('VACUUM');
    console.log('[DATABASE] All logs cleared');
    return true;
  } catch (err) {
    console.error('[DATABASE] Clear error:', err);
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
      console.log(`[DATABASE] Cleaned up ${changes} old log entries`);
      db.exec('VACUUM');
    }
  } catch (err) {
    console.error('[DATABASE] Cleanup error:', err);
  }
}

// Run cleanup daily
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

// Graceful shutdown
process.on('exit', () => {
  try {
    db.close();
  } catch (err) {
    console.error('[DATABASE] Error closing database:', err);
  }
});

process.on('SIGINT', () => {
  try {
    db.close();
  } catch (err) {
    console.error('[DATABASE] Error closing database:', err);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  try {
    db.close();
  } catch (err) {
    console.error('[DATABASE] Error closing database:', err);
  }
  process.exit(0);
});

module.exports = {
  db,
  logCommand,
  getLogs,
  getLogCount,
  clearLogs
};
