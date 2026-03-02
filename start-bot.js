// BOT STARTER - Loads dashboard server first, then bot
// This ensures the logging function is available when the bot starts

console.log('[STARTER] Initializing dashboard server...');

// Start dashboard server first (this sets up global.dashboardLogCommand)
require('./dashboard-server.js');

setTimeout(() => {
  console.log('[STARTER] Starting bot with dashboard logging enabled...');
  require('./index.js');
}, 2000); // Give dashboard 2 seconds to start
