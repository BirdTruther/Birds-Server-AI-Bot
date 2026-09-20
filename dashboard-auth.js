// dashboard-auth.js
// Discord OAuth2 login + session gating for the web dashboard.
//
// Security model:
//  - The dashboard is served same-origin, so no cross-origin CORS is needed.
//  - Every route except /auth/* (and /api/auth/me) requires a valid session.
//  - A session is only issued to users who are either explicitly allowlisted
//    (DASHBOARD_ALLOWED_USER_IDS) or, when DASHBOARD_ALLOW_GUILD_ADMINS=true,
//    hold Manage Server / Administrator in a Discord server the bot is in.
//
// Required env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
// Optional env: DASHBOARD_OAUTH_REDIRECT_URI, DASHBOARD_ALLOWED_USER_IDS,
//               DASHBOARD_ALLOW_GUILD_ADMINS, DASHBOARD_HOST
// Dev escape hatch: DASHBOARD_AUTH_DISABLED=true (logs a loud warning)

const crypto = require('crypto');
const { getSetting, setSetting, db } = require('./database.js');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'patrick_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_PREFIX = 'dashboard_session:';

// Discord permission bits (value is a bitfield string from the API)
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;

const pendingStates = new Map(); // state -> expiresAt

function config() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    disabled: String(process.env.DASHBOARD_AUTH_DISABLED || '') === 'true',
    allowGuildAdmins: String(process.env.DASHBOARD_ALLOW_GUILD_ADMINS || 'false') === 'true',
    allowedIds: (process.env.DASHBOARD_ALLOWED_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  };
}

function warnIfMisconfigured() {
  const c = config();
  if (c.disabled) {
    console.warn('[AUTH] ⚠️  DASHBOARD_AUTH_DISABLED=true — the dashboard is OPEN to anyone who can reach it. Do not expose it publicly.');
    return;
  }
  if (!c.clientId || !c.clientSecret) {
    console.warn('[AUTH] ⚠️  Discord OAuth is not configured (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET missing). All dashboard pages will return an error until it is set.');
  }
  if (c.allowedIds.length === 0 && !c.allowGuildAdmins) {
    console.warn('[AUTH] ⚠️  No DASHBOARD_ALLOWED_USER_IDS set and DASHBOARD_ALLOW_GUILD_ADMINS is false — nobody will be able to log in.');
  }
}

// ===== COOKIE HELPERS =====
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function setSessionCookie(req, res, id, maxAgeMs) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ===== SESSION STORE (persisted in bot_settings so deploys don't sign everyone out) =====
function createSession(user, verdict = {}) {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    id,
    userId: user.id,
    username: user.username,
    globalName: user.global_name || null,
    avatar: user.avatar || null,
    superAdmin: Boolean(verdict.superAdmin),
    adminGuildIds: Array.isArray(verdict.adminGuildIds) ? verdict.adminGuildIds.map(String) : [],
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  setSetting(SESSION_PREFIX + id, JSON.stringify(session));
  return session;
}

function getSession(id) {
  if (!id) return null;
  const raw = getSetting(SESSION_PREFIX + id, null);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!session || !session.expiresAt || session.expiresAt < Date.now()) {
    setSetting(SESSION_PREFIX + id, '');
    return null;
  }
  // Reconcile the role on every request so changing the allowlist takes effect
  // without requiring users to manually clear an otherwise-valid session.
  const shouldBeSuperAdmin = config().allowedIds.includes(String(session.userId));
  if (Boolean(session.superAdmin) !== shouldBeSuperAdmin) {
    session.superAdmin = shouldBeSuperAdmin;
    setSetting(SESSION_PREFIX + id, JSON.stringify(session));
  }
  return session;
}

function destroySession(id) {
  if (id) setSetting(SESSION_PREFIX + id, '');
}

function currentSession(req) {
  return getSession(parseCookies(req)[SESSION_COOKIE]);
}

// ===== OAUTH HELPERS =====
function redirectUri(req) {
  if (process.env.DASHBOARD_OAUTH_REDIRECT_URI) return process.env.DASHBOARD_OAUTH_REDIRECT_URI;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

function makeState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(exp) && exp > Date.now();
}

async function exchangeCode(code, redirect) {
  const c = config();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return res.json();
}

async function discordGet(path, token) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Discord GET ${path} failed (${res.status})`);
  return res.json();
}

function evaluateAccess(user, userGuilds, getDiscordClient, c) {
  const superAdmin = c.allowedIds.includes(String(user.id));

  // Guilds where this user has owner / admin / manage-server.
  const adminGuildIds = [];
  for (const g of userGuilds || []) {
    let perms = 0n;
    try { perms = BigInt(g.permissions || 0); } catch { perms = 0n; }
    if (g.owner || (perms & PERM_ADMINISTRATOR) || (perms & PERM_MANAGE_GUILD)) {
      adminGuildIds.push(g.id);
    }
  }

  if (superAdmin) {
    return { ok: true, reason: 'allowlisted', superAdmin, adminGuildIds };
  }
  if (!c.allowGuildAdmins) {
    return { ok: false, reason: 'not on the allowlist', superAdmin, adminGuildIds };
  }

  const client = typeof getDiscordClient === 'function' ? getDiscordClient() : null;
  const shared = new Set(client ? [...client.guilds.cache.keys()] : []);
  if (adminGuildIds.some(id => shared.has(id))) {
    return { ok: true, reason: 'guild admin', superAdmin, adminGuildIds };
  }
  return { ok: false, reason: 'no admin access in a shared server', superAdmin, adminGuildIds };
}

// True if the session may view/manage a specific guild's settings.
function canAccessGuild(session, guildId) {
  if (config().disabled) return true;
  if (!session || !guildId) return false;
  if (session.superAdmin) return true;
  return Array.isArray(session.adminGuildIds) && session.adminGuildIds.includes(String(guildId));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function authErrorPage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard login</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:520px;padding:32px;background:#1e293b;border:1px solid #334155;border-radius:12px;text-align:center}
h1{font-size:1.25rem;margin:0 0 12px}p{color:#94a3b8;line-height:1.5}a{color:#60a5fa}</style></head>
<body><div class="card"><h1>ThePatrick Dashboard</h1><p>${escapeHtml(message)}</p>
 <p><a href="/auth/login">Try again</a></p></div></body></html>`;
}

function authLandingPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ThePatrick // Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}html{min-height:100%;background:#0a0c10}body{min-height:100vh;margin:0;padding:24px;font-family:'Exo 2',sans-serif;background:#0a0c10;color:#c8d6e5;line-height:1.6;overflow-x:hidden}body:before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.35;background:repeating-linear-gradient(0deg,transparent 0,transparent 2px,rgba(0,0,0,.08) 2px,rgba(0,0,0,.08) 4px)}.shell{width:min(1050px,100%);margin:0 auto;position:relative}.topbar{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:10px 0 22px;border-bottom:1px solid rgba(100,180,255,.14)}.brand{font-family:'Share Tech Mono',monospace;color:#00d4ff;letter-spacing:.08em}.brand span{color:#6b7f96}.toplink{color:#6b7f96;font-size:.85rem;text-decoration:none}.toplink:hover{color:#00d4ff}.hero{padding:clamp(48px,9vw,92px) 0 52px;text-align:center;position:relative}.hero:before{content:'';position:absolute;inset:-20% 10% 0;background:radial-gradient(ellipse at top,rgba(0,212,255,.1),transparent 65%);z-index:-1}.eyebrow{font-family:'Share Tech Mono',monospace;color:#00d4ff;font-size:.75rem;letter-spacing:.2em;text-transform:uppercase}.hero h1{margin:16px 0 14px;color:#fff;font-size:clamp(2.1rem,5vw,4.3rem);line-height:1.05}.hero h1 span{color:#00d4ff}.hero p{max-width:650px;margin:0 auto;color:#6b7f96;font-size:1.05rem}.status{display:inline-flex;gap:9px;align-items:center;margin-top:24px;padding:6px 12px;border:1px solid rgba(0,255,136,.3);border-radius:999px;color:#00ff88;background:rgba(0,255,136,.06);font-family:'Share Tech Mono',monospace;font-size:.76rem;letter-spacing:.08em}.dot{width:7px;height:7px;border-radius:50%;background:#00ff88;box-shadow:0 0 10px #00ff88}.actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:32px}.login,.site{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 22px;border-radius:7px;text-decoration:none;font-weight:700;transition:.18s}.login{background:#00d4ff;color:#061016}.login:hover{background:#33ddff;box-shadow:0 0 22px rgba(0,212,255,.35)}.site{border:1px solid rgba(100,180,255,.25);color:#c8d6e5}.site:hover{border-color:#00d4ff;color:#00d4ff}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding-bottom:42px}@media(max-width:760px){body{padding:16px}.topbar{align-items:flex-start}.grid{grid-template-columns:1fr}}.card{padding:22px;background:#0f1218;border:1px solid rgba(100,180,255,.12);border-radius:10px}.card:hover{border-color:rgba(100,180,255,.3)}.icon{font-size:1.55rem;margin-bottom:12px}.card h2{margin:0 0 7px;color:#fff;font-size:1.05rem}.card p{margin:0;color:#6b7f96;font-size:.9rem}.card-kicker{font-family:'Share Tech Mono',monospace;color:#00d4ff;font-size:.68rem;letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px}.card-code{display:block;margin-top:14px;color:#00ff88;font: .75rem/1.6 'Share Tech Mono',monospace}.card-cyan{box-shadow:inset 0 2px #00d4ff}.card-green{box-shadow:inset 0 2px #00ff88}.card-purple{box-shadow:inset 0 2px #b06fff}.console{margin:0 auto 42px;background:#080a0d;border:1px solid rgba(0,212,255,.2);border-radius:9px;padding:16px 20px;font-family:'Share Tech Mono',monospace;font-size:.82rem;color:#6b7f96}.console strong{color:#00d4ff;font-weight:400}.console .ok{color:#00ff88}.footer{border-top:1px solid rgba(100,180,255,.1);padding:20px 0;text-align:center;color:#3a4a5a;font-family:'Share Tech Mono',monospace;font-size:.72rem}
</style></head><body><main class="shell"><nav class="topbar"><div class="brand">BIRDS<span>//</span>PATRICK</div><a class="toplink" href="https://birdsserver.cfd/" target="_blank" rel="noopener">birdsserver.cfd &#8599;</a></nav>
<section class="hero"><div class="eyebrow">operator console // secure access</div><h1>ThePatrick <span>Dashboard</span></h1><p>Control the bot that talks Tarkov, remembers the important stuff, roasts the deserving, and keeps every server's settings in its own lane.</p><div class="status"><i class="dot"></i> DISCORD AUTHENTICATION REQUIRED</div><div class="actions"><a class="login" href="/auth/login?start=1">&#x1F3AE; Sign in with Discord</a><a class="site" href="https://birdsserver.cfd/" target="_blank" rel="noopener">Explore the Birds Server</a></div></section>
<div class="console"><strong>$ patrick status</strong><br><span class="ok">[online]</span> multi-server control plane ready<br><span class="ok">[scoped]</span> persona, hate, cultist alerts, and facts<br><span class="ok">[shared]</span> owner-curated memory across servers</div>
<section class="grid"><article class="card card-cyan"><div class="card-kicker">// GUILD CONTROL</div><div class="icon">&#x1F310;</div><h2>One console. Every server.</h2><p>Pick a server you administer and change its persona, hate list, roast channel, cultist alerts, and music-adjacent chaos without crossing the streams.</p><code class="card-code">scope: guild_id<br>access: manage_server</code></article><article class="card card-green"><div class="card-kicker">// MEMORY LAYER</div><div class="icon">&#x1F9E0;</div><h2>Local facts. Shared recall.</h2><p>Admins manage their own server's facts. The owner can promote the good stuff into shared memory so Patrick carries it everywhere.</p><code class="card-code">local facts: isolated<br>shared facts: curated</code></article><article class="card card-purple"><div class="card-kicker">// OPERATOR ACCESS</div><div class="icon">&#x1F6E1;&#xFE0F;</div><h2>Discord is the keycard.</h2><p>Sign in with Discord. Server admins see their server; the superadmin sees system logs, exports, shared memory, and every connected guild.</p><code class="card-code">oauth2: discord<br>logs: scoped</code></article><article class="card card-cyan"><div class="card-kicker">// BOT PERSONALITY</div><div class="icon">&#x1F3AD;</div><h2>Make Patrick fit the room.</h2><p>One server can choose Nice &amp; Smart while another chooses Aggressive, Sassy, Conspiracy, or Sleepy. Same bot, different vibe.</p><code class="card-code">/persona name:nice<br>fallback: global</code></article><article class="card card-green"><div class="card-kicker">// ALERT PIPELINE</div><div class="icon">&#x1F319;</div><h2>Cultists on schedule.</h2><p>Your Tarkov-time monitor posts active and despawn alerts into the channel and optional role you configure for each server.</p><code class="card-code">window: 22:00–07:00<br>clock: 7x Tarkov time</code></article><article class="card card-purple"><div class="card-kicker">// COMMAND SURFACE</div><div class="icon">&#x26A1;</div><h2>Useful commands, actual outputs.</h2><p>Ask, price, best ammo, CS2 market, music, allergies, hate management, image generation, and more — all through Discord slash commands.</p><code class="card-code">/ask · /price · /play<br>/hate · /imagine · /queue</code></article></section>
<footer class="footer">THEPATRICK // BIRDS SERVER AI BOT // AUTHORIZED OPERATORS ONLY</footer></main></body></html>`;
}

// ===== ROUTES =====
function attachRoutes(app, options = {}) {
  const getDiscordClient = options.getDiscordClient;

  app.get('/auth/login', (req, res) => {
    const c = config();
    if (c.disabled) return res.redirect('/');
    if (!c.clientId || !c.clientSecret) {
      return res.status(500).send(authErrorPage('Dashboard login is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.'));
    }
    // Show a branded landing page before explicitly starting OAuth.
    if (req.query.start !== '1') return res.send(authLandingPage());
    const redirect = redirectUri(req);
    const state = makeState();
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const c = config();
    if (c.disabled) return res.redirect('/');
    const { code, state } = req.query;
    if (!code || !state || !consumeState(String(state))) {
      return res.status(400).send(authErrorPage('Invalid or expired login attempt. Please try again.'));
    }
    try {
      const redirect = redirectUri(req);
      const token = await exchangeCode(String(code), redirect);
      const user = await discordGet('/users/@me', token.access_token);
      let userGuilds = [];
      try {
        userGuilds = await discordGet('/users/@me/guilds', token.access_token);
      } catch (guildErr) {
        console.warn('[AUTH] Could not fetch user guilds:', guildErr.message);
      }
      const verdict = evaluateAccess(user, userGuilds, getDiscordClient, c);
      if (!verdict.ok) {
        console.warn(`[AUTH] Denied login for ${user.username} (${user.id}): ${verdict.reason}`);
        return res.status(403).send(authErrorPage(`Access denied: ${verdict.reason}.`));
      }
      const session = createSession(user, verdict);
      setSessionCookie(req, res, session.id, SESSION_TTL_MS);
      console.log(`[AUTH] Login: ${user.username} (${user.id}) — ${verdict.reason}`);
      res.redirect('/');
    } catch (err) {
      console.error('[AUTH] OAuth callback failed:', err.message);
      res.status(500).send(authErrorPage('Login failed. Check the server logs and try again.'));
    }
  });

  app.get('/auth/logout', (req, res) => {
    destroySession(parseCookies(req)[SESSION_COOKIE]);
    clearSessionCookie(req, res);
    res.redirect('/auth/login');
  });

  app.get('/api/auth/me', (req, res) => {
    const session = currentSession(req);
    if (!session) return res.json({ success: true, authenticated: false });
    res.json({
      success: true,
      authenticated: true,
      user: {
        id: session.userId,
        username: session.username,
        globalName: session.globalName,
        avatar: session.avatar,
        superAdmin: Boolean(session.superAdmin),
      },
    });
  });

  // Servers the logged-in user may manage (bot is present AND user is admin).
  app.get('/api/auth/guilds', (req, res) => {
    const c = config();
    const session = currentSession(req);
    if (!c.disabled && !session) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    const client = typeof getDiscordClient === 'function' ? getDiscordClient() : null;
    const all = client ? [...client.guilds.cache.values()] : [];
    const guilds = all
      .filter(g => c.disabled || session.superAdmin || (session.adminGuildIds || []).includes(g.id))
      .map(g => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, guilds });
  });
}

// ===== GATE =====
function requireAuth(req, res, next) {
  const c = config();
  if (c.disabled) return next();
  const session = currentSession(req);
  if (session) {
    req.user = session;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  return res.redirect('/auth/login');
}

// ===== SUPERADMIN GATE =====
// Superadmins are the allowlisted owners. When auth is disabled (local dev)
// everything is treated as superadmin.
function isSuperAdmin(req) {
  if (config().disabled) return true;
  return Boolean(req.user && req.user.superAdmin);
}

function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req)) return next();
  res.status(403).json({ success: false, error: 'superadmin only' });
}

// Periodic cleanup of expired sessions + states
setInterval(() => {
  try {
    const rows = db.prepare('SELECT key, value FROM bot_settings WHERE key LIKE ?').all(`${SESSION_PREFIX}%`);
    const now = Date.now();
    for (const row of rows) {
      let s = null;
      try { s = JSON.parse(row.value); } catch { s = null; }
      if (!s || !s.expiresAt || s.expiresAt < now) setSetting(row.key, '');
    }
  } catch (err) {
    console.error('[AUTH] session sweep failed:', err.message);
  }
  const now = Date.now();
  for (const [state, exp] of pendingStates) {
    if (exp < now) pendingStates.delete(state);
  }
}, 30 * 60 * 1000);

warnIfMisconfigured();

module.exports = { attachRoutes, requireAuth, canAccessGuild, requireSuperAdmin, isSuperAdmin };
