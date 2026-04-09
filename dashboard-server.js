const express = require('express');
const cors = require('cors');
const path = require('path');
const { getLogs, getLogCount, clearLogs, getSystemLogs, getSystemLogCount, clearSystemLogs, logCommand: dbLogCommand, getSetting, setSetting } = require('./database.js');

// Load cultist enabled state from DB on startup (persists across reboots)
let cultistState = {
  enabled: getSetting('cultistEnabled', 'true') === 'true',
  server1Active: false,
  server2Active: false,
  server1Time: '--:--'
};
console.log(`[DASHBOARD] Cultist monitoring loaded as: ${cultistState.enabled ? 'ENABLED' : 'DISABLED'}`);

// Expose getter so index.js can always read the live value
global.getCultistEnabled = () => cultistState.enabled;

// Persona state management
let botPersona = {
  current: 'aggressive',
  lastChanged: new Date().toISOString()
};

// Export function for bot to access current persona
global.getBotPersona = () => botPersona.current;

// Command logs storage (in-memory cache for real-time updates, max 500 entries)
const MAX_LOGS = 500;
let commandLogs = [];

// Load existing logs from database on startup
function loadLogsFromDatabase() {
  try {
    const dbLogs = getLogs('all', MAX_LOGS);
    // Convert DB logs to dashboard format
    commandLogs = dbLogs.map(log => ({
      platform: log.platform,
      username: log.username,
      command: log.command,
      message: log.message,
      response: log.response,
      image_url: log.image_url,
      error: log.error === 1,
      timestamp: log.timestamp,
      id: log.id
    })).reverse(); // Reverse to maintain chronological order
    console.log(`[DASHBOARD] Loaded ${commandLogs.length} logs from database`);
  } catch (error) {
    console.error('[DASHBOARD] Error loading logs from database:', error);
  }
}

// Load logs on startup
loadLogsFromDatabase();

function addLog(entry) {
  commandLogs.push({
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
    id: entry.id || Date.now() + Math.random()
  });
  
  if (commandLogs.length > MAX_LOGS) {
    commandLogs = commandLogs.slice(-MAX_LOGS);
  }
  
  // Also save to database (this happens in index.js via dbLogCommand now)
  // But keep this as a backup for any direct dashboard logging
}

global.dashboardLogCommand = addLog;

// Real Tarkov time functions
function getCurrentTarkovTime() {
  const oneDay = 24 * 60 * 60 * 1000;
  const russia = 3 * 60 * 60 * 1000;
  const tarkovRatio = 7;
  const now = Date.now();
  const tarkovTime = (russia + (now * tarkovRatio)) % oneDay;
  const totalMinutes = Math.floor(tarkovTime / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return { hours, minutes };
}

function isCultistTime(hour) {
  return hour >= 22 || hour < 7;
}

// Update status every 30s
setInterval(() => {
  const { hours, minutes } = getCurrentTarkovTime();
  const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  
  cultistState.server1Time = timeStr;
  cultistState.server1Active = isCultistTime(hours);
  cultistState.server2Active = isCultistTime((hours + 12) % 24);
}, 30000);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/cultist/status', (req, res) => {
  res.json(cultistState);
});

app.post('/api/cultist/toggle', (req, res) => {
  const { enabled } = req.body;
  cultistState.enabled = enabled;
  setSetting('cultistEnabled', enabled); // Persist to DB so it survives reboots
  console.log(`[API] Cultist ${enabled ? 'ENABLED' : 'DISABLED'} (saved to database)`);
  res.json({ success: true, enabled });
});

// Bot status endpoint
app.get('/api/bot/status', (req, res) => {
  const uptimeSeconds = process.uptime();
  const uptimeStr = new Date(uptimeSeconds * 1000).toISOString().substr(11, 8);
  
  res.json({
    status: 'ONLINE',
    uptime: uptimeStr,
    lastCheck: new Date().toLocaleTimeString(),
    memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1) + ' MB'
  });
});

// Persona endpoints
app.get('/api/persona/current', (req, res) => {
  res.json({
    success: true,
    persona: botPersona.current,
    lastChanged: botPersona.lastChanged
  });
});

app.post('/api/persona/set', (req, res) => {
  const { persona } = req.body;
  
  const validPersonas = ['aggressive', 'sassy', 'nice', 'conspiracy', 'sleepy'];
  
  if (!validPersonas.includes(persona)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid persona. Valid options: ' + validPersonas.join(', ')
    });
  }
  
  botPersona.current = persona;
  botPersona.lastChanged = new Date().toISOString();
  
  console.log(`[API] Persona changed to: ${persona}`);
  
  res.json({
    success: true,
    persona: botPersona.current,
    lastChanged: botPersona.lastChanged
  });
});

// Logs endpoint - now pulls from database
app.get('/api/bot/logs', (req, res) => {
  const { platform, limit } = req.query;
  
  const maxResults = Math.min(parseInt(limit) || 100, 1000);
  
  try {
    // Get logs from database instead of memory
    const dbLogs = getLogs(platform || 'all', maxResults);
    const totalCount = getLogCount();
    
    // Format logs for dashboard
    const formattedLogs = dbLogs.map(log => ({
      platform: log.platform,
      username: log.username,
      command: log.command,
      message: log.message,
      response: log.response,
      image_url: log.image_url,
      error: log.error === 1,
      timestamp: log.timestamp,
      id: log.id
    }));
    
    res.json({
      success: true,
      count: formattedLogs.length,
      total: totalCount,
      logs: formattedLogs
    });
  } catch (error) {
    console.error('[API] Error fetching logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch logs'
    });
  }
});

// System logs endpoint
app.get('/api/bot/system-logs', (req, res) => {
  const { log_type, severity, component, limit } = req.query;
  
  try {
    const filters = {
      log_type: log_type || 'all',
      severity: severity || 'all',
      component: component || 'all',
      limit: Math.min(parseInt(limit) || 100, 1000)
    };
    
    const systemLogs = getSystemLogs(filters);
    const totalCount = getSystemLogCount();
    
    // Parse metadata JSON if present
    const formattedLogs = systemLogs.map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      log_type: log.log_type,
      severity: log.severity,
      component: log.component,
      message: log.message,
      stack_trace: log.stack_trace,
      metadata: log.metadata ? JSON.parse(log.metadata) : null
    }));
    
    res.json({
      success: true,
      count: formattedLogs.length,
      total: totalCount,
      logs: formattedLogs
    });
  } catch (error) {
    console.error('[API] Error fetching system logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch system logs'
    });
  }
});

// Clear logs endpoint - now clears database
app.post('/api/bot/logs/clear', (req, res) => {
  try {
    const success = clearLogs();
    if (success) {
      commandLogs = []; // Also clear in-memory cache
      console.log('[API] Logs cleared (database + memory)');
      res.json({ success: true, message: 'Logs cleared' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to clear logs' });
    }
  } catch (error) {
    console.error('[API] Error clearing logs:', error);
    res.status(500).json({ success: false, error: 'Failed to clear logs' });
  }
});

// Clear system logs endpoint
app.post('/api/bot/system-logs/clear', (req, res) => {
  try {
    const success = clearSystemLogs();
    if (success) {
      console.log('[API] System logs cleared');
      res.json({ success: true, message: 'System logs cleared' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to clear system logs' });
    }
  } catch (error) {
    console.error('[API] Error clearing system logs:', error);
    res.status(500).json({ success: false, error: 'Failed to clear system logs' });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}/`);
  console.log(`Current persona: ${botPersona.current}`);
});
