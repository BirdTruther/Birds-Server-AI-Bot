const express = require('express');
const cors = require('cors');

const app = express();

// change this later if you want a different port
const PORT = 3001;

app.use(cors());
app.use(express.json());

// serve everything in /public (this includes dashboard.html)
app.use(express.static('public'));

// simple health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
});
