const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3001;

// Global state for cultist monitoring
let cultistState = {
  enabled: true,
  server1Active: false,
  server2Active: false,
  server1Time: '--:--',
  lastUpdate: null
};

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve dashboard at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

//CULTIST API ENDPOINTS
app.get('/api/cultist/status', (req, res) => {
  res.json(cultistState);
});

app.post('/api/cultist/toggle', (req, res) => {
  const { enabled } = req.body;
  cultistState.enabled = enabled;
  console.log(`[API] Cultist monitoring ${enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ success: true, enabled });
});

app.post('/api/cultist/reset', (req, res) => {
  cultistState = {
    enabled: true,
    server1Active: false,
    server2Active: false,
    server1Time: '--:--',
    lastUpdate: null
  };
  console.log('[API] Cultist state reset');
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}/`);
});
