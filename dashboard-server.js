const express = require('express');
const cors = require('cors');
const path = require('path');

// Shared state
let cultistState = { enabled: true, server1Active: false, server2Active: false, server1Time: '--:--' };

// Tarkov time functions
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

// Update dashboard every 30 seconds
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

// API endpoints
app.get('/api/cultist/status', (req, res) => {
  res.json(cultistState);
});

app.post('/api/cultist/toggle', (req, res) => {
  const { enabled } = req.body;
  cultistState.enabled = enabled;
  console.log(`[API] Cultist ${enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ success: true, enabled });
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}/`);
});

// Export for bot to use
module.exports = { cultistState };
