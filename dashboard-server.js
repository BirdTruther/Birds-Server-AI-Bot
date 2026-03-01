const express = require('express');
const cors = require('cors');
const path = require('path');

// Shared state (we'll connect this properly below)
let cultistState = { enabled: true, server1Active: false, server2Active: false, server1Time: '--:--' };

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
