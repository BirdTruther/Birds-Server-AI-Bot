const express = require('express');
const cors = require('cors');
const path = require('path');

let cultistState = { enabled: true, server1Active: false, server2Active: false, server1Time: '--:--' };

// Command logs storage (circular buffer, max 500 entries)
const MAX_LOGS = 500;
let commandLogs = [];

function addLog(entry) {
  commandLogs.push({
    ...entry,
    timestamp: new Date().toISOString(),
    id: Date.now() + Math.random() // Unique ID for each log
  });
  
  // Keep only last 500 logs
  if (commandLogs.length > MAX_LOGS) {
    commandLogs = commandLogs.slice(-MAX_LOGS);
  }
}

// Export function for bot to use
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
  console.log(`[API] Cultist ${enabled ? 'ENABLED' : 'DISABLED'}`);
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

// Logs endpoint
app.get('/api/bot/logs', (req, res) => {
  const { platform, limit } = req.query;
  
  let filteredLogs = commandLogs;
  
  // Filter by platform if specified
  if (platform && platform !== 'all') {
    filteredLogs = commandLogs.filter(log => log.platform === platform);
  }
  
  // Limit results (default 100, max 500)
  const maxResults = Math.min(parseInt(limit) || 100, 500);
  const result = filteredLogs.slice(-maxResults).reverse(); // Most recent first
  
  res.json({
    success: true,
    count: result.length,
    total: commandLogs.length,
    logs: result
  });
});

// Clear logs endpoint
app.post('/api/bot/logs/clear', (req, res) => {
  commandLogs = [];
  console.log('[API] Logs cleared');
  res.json({ success: true, message: 'Logs cleared' });
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}/`);
});
