const express = require('express');
const cors = require('cors');
const path = require('path');
const { getLogs, getLogCount, clearLogs, getSystemLogs, getSystemLogCount, clearSystemLogs, logCommand: dbLogCommand, logSystem, getSetting, setSetting } = require('./database.js');

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
    })).reverse();
    console.log(`[DASHBOARD] Loaded ${commandLogs.length} logs from database`);
  } catch (error) {
    console.error('[DASHBOARD] Error loading logs from database:', error);
  }
}

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
}

global.dashboardLogCommand = addLog;

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

app.get('/api/cultist/status', (req, res) => { res.json(cultistState); });

app.post('/api/cultist/toggle', (req, res) => {
  const { enabled } = req.body;
  cultistState.enabled = enabled;
  setSetting('cultistEnabled', enabled);
  console.log(`[API] Cultist ${enabled ? 'ENABLED' : 'DISABLED'} (saved to database)`);
  res.json({ success: true, enabled });
});

app.get('/api/bot/status', (req, res) => {
  const uptimeSeconds = process.uptime();
  const uptimeStr = new Date(uptimeSeconds * 1000).toISOString().substr(11, 8);
  res.json({ status: 'ONLINE', uptime: uptimeStr, lastCheck: new Date().toLocaleTimeString(), memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1) + ' MB' });
});

app.get('/api/persona/current', (req, res) => {
  res.json({ success: true, persona: botPersona.current, lastChanged: botPersona.lastChanged });
});

app.post('/api/persona/set', (req, res) => {
  const { persona } = req.body;
  const validPersonas = ['aggressive', 'sassy', 'nice', 'conspiracy', 'sleepy'];
  if (!validPersonas.includes(persona)) {
    return res.status(400).json({ success: false, error: 'Invalid persona. Valid options: ' + validPersonas.join(', ') });
  }
  botPersona.current = persona;
  botPersona.lastChanged = new Date().toISOString();
  console.log(`[API] Persona changed to: ${persona}`);
  res.json({ success: true, persona: botPersona.current, lastChanged: botPersona.lastChanged });
});

app.get('/api/bot/logs', (req, res) => {
  const { platform, limit } = req.query;
  const maxResults = Math.min(parseInt(limit) || 100, 1000);
  try {
    const dbLogs = getLogs(platform || 'all', maxResults);
    const totalCount = getLogCount();
    const formattedLogs = dbLogs.map(log => ({
      platform: log.platform, username: log.username, command: log.command,
      message: log.message, response: log.response, image_url: log.image_url,
      error: log.error === 1, timestamp: log.timestamp, id: log.id
    }));
    res.json({ success: true, count: formattedLogs.length, total: totalCount, logs: formattedLogs });
  } catch (error) {
    console.error('[API] Error fetching logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

app.get('/api/bot/system-logs', (req, res) => {
  const { log_type, severity, component, limit } = req.query;
  try {
    const filters = { log_type: log_type || 'all', severity: severity || 'all', component: component || 'all', limit: Math.min(parseInt(limit) || 100, 1000) };
    const systemLogs = getSystemLogs(filters);
    const totalCount = getSystemLogCount();
    const formattedLogs = systemLogs.map(log => ({
      id: log.id, timestamp: log.timestamp, log_type: log.log_type, severity: log.severity,
      component: log.component, message: log.message, stack_trace: log.stack_trace,
      metadata: log.metadata ? JSON.parse(log.metadata) : null
    }));
    res.json({ success: true, count: formattedLogs.length, total: totalCount, logs: formattedLogs });
  } catch (error) {
    console.error('[API] Error fetching system logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch system logs' });
  }
});

app.post('/api/bot/logs/clear', (req, res) => {
  try {
    const success = clearLogs();
    if (success) { commandLogs = []; res.json({ success: true, message: 'Logs cleared' }); }
    else res.status(500).json({ success: false, error: 'Failed to clear logs' });
  } catch (error) { res.status(500).json({ success: false, error: 'Failed to clear logs' }); }
});

app.post('/api/bot/system-logs/clear', (req, res) => {
  try {
    const success = clearSystemLogs();
    if (success) res.json({ success: true, message: 'System logs cleared' });
    else res.status(500).json({ success: false, error: 'Failed to clear system logs' });
  } catch (error) { res.status(500).json({ success: false, error: 'Failed to clear system logs' }); }
});

// ===== MEMORIAL MESSAGE EXPORT =====
let discordClientRef = null;
global.setDiscordClientForExport = (client) => {
  discordClientRef = client;
  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: 'Discord client registered for memorial message export — bot is online and ready to export'
  });
  console.log('[EXPORT] Discord client registered for memorial message export');
};

const exportJobs = {};

async function runMessageExport(userId, jobId) {
  const job = exportJobs[jobId];

  if (!discordClientRef) {
    const errMsg = 'Discord client not available — make sure the bot is online and index.js calls setDiscordClientForExport(client)';
    job.status = 'error';
    job.error = errMsg;
    logSystem({
      log_type: 'EXPORT',
      severity: 'ERROR',
      component: 'export',
      message: `Export job ${jobId} failed to start: ${errMsg}`,
      metadata: { jobId, userId }
    });
    console.error('[EXPORT]', errMsg);
    return;
  }

  job.status = 'running';
  const messages = [];

  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: `Export job ${jobId} started for user ${userId}`,
    metadata: { jobId, userId }
  });

  try {
    for (const [, guild] of discordClientRef.guilds.cache) {
      job.progress = `Scanning: ${guild.name}`;
      logSystem({
        log_type: 'EXPORT',
        severity: 'INFO',
        component: 'export',
        message: `Job ${jobId} — scanning guild: ${guild.name} (${guild.id})`,
        metadata: { jobId, guildId: guild.id, guildName: guild.name }
      });

      let channels;
      try {
        channels = await guild.channels.fetch();
      } catch (e) {
        logSystem({
          log_type: 'EXPORT',
          severity: 'WARNING',
          component: 'export',
          message: `Job ${jobId} — could not fetch channels for guild ${guild.name}: ${e.message}`,
          stack_trace: e.stack,
          metadata: { jobId, guildId: guild.id }
        });
        continue;
      }

      for (const [, channel] of channels) {
        if (!channel || channel.type !== 0) continue;
        let perms;
        try { perms = channel.permissionsFor(guild.members.me); } catch (e) { continue; }
        if (!perms || !perms.has('ViewChannel') || !perms.has('ReadMessageHistory')) continue;

        let lastId = null;
        let fetched;
        let channelErrors = 0;
        do {
          try {
            const opts = { limit: 100 };
            if (lastId) opts.before = lastId;
            fetched = await channel.messages.fetch(opts);
          } catch (e) {
            channelErrors++;
            logSystem({
              log_type: 'EXPORT',
              severity: 'WARNING',
              component: 'export',
              message: `Job ${jobId} — error reading #${channel.name} in ${guild.name}: ${e.message}`,
              stack_trace: e.stack,
              metadata: { jobId, channelId: channel.id, channelName: channel.name, guildName: guild.name }
            });
            break;
          }

          for (const [, msg] of fetched) {
            if (msg.author.id === userId) {
              messages.push({
                id: msg.id,
                timestamp: msg.createdAt.toISOString(),
                guild: guild.name,
                channel: channel.name,
                channel_id: channel.id,
                content: msg.content,
                attachments: msg.attachments.map(a => a.url),
                jump_url: `https://discord.com/channels/${guild.id}/${channel.id}/${msg.id}`
              });
            }
          }
          lastId = fetched.size === 100 ? fetched.last().id : null;
        } while (fetched.size === 100);
      }
    }

    job.status = 'done';
    job.progress = `Complete \u2014 ${messages.length} messages found`;
    job.messages = messages;
    job.count = messages.length;
    job.completedAt = new Date().toISOString();

    logSystem({
      log_type: 'EXPORT',
      severity: 'INFO',
      component: 'export',
      message: `Export job ${jobId} completed successfully — ${messages.length} messages found for user ${userId}`,
      metadata: { jobId, userId, messageCount: messages.length }
    });
    console.log(`[EXPORT] Job ${jobId} complete: ${messages.length} messages for user ${userId}`);

  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    logSystem({
      log_type: 'EXPORT',
      severity: 'ERROR',
      component: 'export',
      message: `Export job ${jobId} threw an unexpected error: ${err.message}`,
      stack_trace: err.stack,
      metadata: { jobId, userId }
    });
    console.error(`[EXPORT] Job ${jobId} failed:`, err.message);
  }
}

app.post('/api/export/start', (req, res) => {
  const { userId } = req.body;
  if (!userId || !/^\d{17,20}$/.test(userId)) {
    return res.status(400).json({ success: false, error: 'Invalid Discord user ID \u2014 must be 17-20 digits' });
  }
  const jobId = Date.now().toString();
  exportJobs[jobId] = { status: 'queued', userId, progress: 'Starting...', startedAt: new Date().toISOString() };
  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: `Export job ${jobId} queued for user ID ${userId}`,
    metadata: { jobId, userId }
  });
  runMessageExport(userId, jobId);
  res.json({ success: true, jobId });
});

app.get('/api/export/status/:jobId', (req, res) => {
  const job = exportJobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, status: job.status, progress: job.progress, count: job.count || 0, error: job.error || null });
});

app.get('/api/export/download/:jobId', (req, res) => {
  const job = exportJobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Export not ready or job not found' });
  const format = req.query.format || 'json';
  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: `Export job ${req.params.jobId} downloaded as ${format.toUpperCase()} (${job.count} messages)`,
    metadata: { jobId: req.params.jobId, format, messageCount: job.count }
  });
  if (format === 'csv') {
    const header = 'id,timestamp,guild,channel,content,attachments,jump_url\n';
    const rows = job.messages.map(m =>
      [m.id, m.timestamp, `"${m.guild}"`, `"${m.channel}"`,
       `"${(m.content || '').replace(/"/g, "'")}"`,
       `"${m.attachments.join('|')}"`,
       m.jump_url].join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="export-${job.userId}.csv"`);
    res.send(header + rows);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="export-${job.userId}.json"`);
    res.send(JSON.stringify(job.messages, null, 2));
  }
});

app.listen(PORT, () => {
  logSystem({
    log_type: 'STARTUP',
    severity: 'INFO',
    component: 'dashboard',
    message: `Dashboard server started on port ${PORT}`
  });
  console.log(`Dashboard on http://localhost:${PORT}/`);
  console.log(`Current persona: ${botPersona.current}`);
});
