// CourtIQ server — zero dependencies (Node 18+ built-ins only)
const http = require('http');
const fs   = require('fs').promises;
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT) || 3003;
const PUBLIC_DIR  = path.join(__dirname, 'public');

// ─── PARSE .env ───────────────────────────────────────────────────────────────
try {
  require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (k) process.env[k] = v;
      }
    });
} catch {}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isDST() {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  return now.getTimezoneOffset() < Math.max(jan, jul);
}

// ─── ESPN CACHE ───────────────────────────────────────────────────────────────
// Shared server-side cache for ESPN API responses.
// All users share one cache — 1,000 visitors at once = 1 ESPN call, not 1,000.
const ESPN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const espnCache = new Map(); // url → { data, expiresAt }

async function fetchESPN(url) {
  const now = Date.now();
  const cached = espnCache.get(url);
  if (cached && now < cached.expiresAt) return cached.data; // cache hit

  const r = await fetch(url);
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  const data = await r.text();
  espnCache.set(url, { data, expiresAt: now + ESPN_CACHE_TTL_MS });
  return data;
}

// ─── NBA STATS CACHE ──────────────────────────────────────────────────────────
// NBA Stats API requires special headers browsers can't send (CORS).
// Proxy through server with required headers; cache for 30 min (stats change less often).
const NBA_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const nbaCache = new Map(); // url → { data, expiresAt }

async function fetchNBA(url) {
  const now = Date.now();
  const cached = nbaCache.get(url);
  if (cached && now < cached.expiresAt) return cached.data; // cache hit

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.nba.com',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.nba.com',
      'x-nba-stats-origin': 'stats',
      'x-nba-stats-token': 'true'
    }
  });
  if (!r.ok) throw new Error(`NBA Stats HTTP ${r.status}`);
  const data = await r.text();
  nbaCache.set(url, { data, expiresAt: now + NBA_CACHE_TTL_MS });
  return data;
}

// ─── ODDS API CACHE ────────────────────────────────────────────────────────────
// 60-min cache — lines don't move that fast, saves Odds API quota.
// All users share one cached response — 1000 users = 1 API call.
const ODDS_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
let oddsCache = { data: null, expiresAt: 0, remaining: null };

async function fetchOddsAPI() {
  const now = Date.now();
  if (oddsCache.data && now < oddsCache.expiresAt) return oddsCache; // cache hit

  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error('ODDS_API_KEY not configured in .env');

  const url = `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${key}&regions=us&markets=spreads,h2h,totals&oddsFormat=american`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Odds API HTTP ${r.status}`);

  const remaining = r.headers.get('x-requests-remaining');
  const used      = r.headers.get('x-requests-used');
  if (remaining) console.log(`Odds API: ${remaining} requests remaining (${used} used)`);

  const data = await r.json();
  oddsCache = { data, expiresAt: now + ODDS_CACHE_TTL_MS, remaining, used };
  return oddsCache;
}

// ─── ACTION NETWORK CACHE (Public Betting %) ──────────────────────────────────
// Unofficial but widely-used free API for public betting percentages.
// Cache 20 minutes — percentages shift as game approaches but not by the second.
const ACTION_CACHE_TTL_MS = 20 * 60 * 1000;
let actionCache = { data: null, expiresAt: 0 };

async function fetchActionNetwork(date) {
  const now = Date.now();
  if (actionCache.data && now < actionCache.expiresAt) return actionCache.data;

  const url = `https://api.actionnetwork.com/web/v1/games?sport=nba&date=${date}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer':    'https://www.actionnetwork.com',
      'Accept':     'application/json, text/plain, */*',
    }
  });
  if (!r.ok) throw new Error(`Action Network HTTP ${r.status}`);
  const data = await r.json();
  actionCache = { data, expiresAt: now + ACTION_CACHE_TTL_MS };
  return data;
}

// ─── GAME ANALYSIS CACHE (server-side, shared across ALL users) ───────────────
// THE BIG ONE: without this, every user independently calls Claude for every game.
// 1,000 users × 10 games = 10,000 Claude calls. With this = 10 Claude calls total.
// Cache key: gameId + oddsKey (spread string). If the line moves, cache misses
// and Claude is called fresh — everyone then shares the new analysis.
// TTL: 6 hours (covers a full game day slate without going stale).
const GAME_ANALYSIS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const gameAnalysisCache = new Map(); // cacheKey → { result, expiresAt }
// In-flight dedup: if two users request same game simultaneously, only call Claude once.
const gameAnalysisInFlight = new Map(); // cacheKey → Promise

// ─── PLAY OF THE DAY CACHE (one Claude call per calendar day, server-wide) ────
// All users share the same POTD. Resets at midnight ET.
let potdCache = { data: null, date: null }; // date = 'YYYY-MM-DD'

// ─── MIME TYPES ───────────────────────────────────────────────────────────────
const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript',
  '.css':         'text/css',
  '.json':        'application/json',
  '.svg':         'image/svg+xml',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── Claude AI proxy ────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key || key.startsWith('your-key')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No API key configured. Open .env and set ANTHROPIC_API_KEY.' } }));
        return;
      }
      try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         key,
            'anthropic-version': '2023-06-01'
          },
          body
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(text);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // ── Game analysis proxy — SHARED SERVER CACHE (the credit saver) ─────────────
  // Instead of every user calling Claude directly, the server caches each analysis.
  // Key: gameId + oddsKey. Miss → call Claude once, cache for 6h → serve everyone.
  // In-flight dedup prevents two simultaneous first-requests from double-billing.
  if (req.method === 'POST' && req.url === '/api/game-analysis') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey.startsWith('your-key')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No API key configured.' } }));
        return;
      }
      try {
        const { gameId, oddsKey, prompt } = JSON.parse(body);
        const cacheKey = `${gameId}_${oddsKey}`;
        const now = Date.now();

        // Cache hit — serve instantly, zero Claude cost
        const cached = gameAnalysisCache.get(cacheKey);
        if (cached && now < cached.expiresAt) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached.result));
          return;
        }

        // In-flight dedup: if another request is already calling Claude for this game,
        // wait for that result instead of making a second Claude call.
        if (gameAnalysisInFlight.has(cacheKey)) {
          const result = await gameAnalysisInFlight.get(cacheKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // Cache miss — call Claude, store in-flight promise so concurrent requests wait
        const claudePromise = (async () => {
          const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type':      'application/json',
              'x-api-key':         apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
          });
          if (!upstream.ok) throw new Error(`Claude HTTP ${upstream.status}`);
          const data = await upstream.json();
          const txt  = data?.content?.[0]?.text || '';
          const m    = txt.match(/\{[\s\S]*?\}/);
          if (!m) throw new Error('No JSON in Claude response');
          return JSON.parse(m[0]);
        })();

        gameAnalysisInFlight.set(cacheKey, claudePromise);
        try {
          const result = await claudePromise;
          gameAnalysisCache.set(cacheKey, { result, expiresAt: now + GAME_ANALYSIS_CACHE_TTL_MS });
          console.log(`Analysis cached: ${cacheKey}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } finally {
          gameAnalysisInFlight.delete(cacheKey);
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // ── Play of the Day — one Claude call per calendar day, server-wide ───────────
  // All users share the same POTD result. Resets at midnight automatically.
  if (req.method === 'POST' && req.url === '/api/potd') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey.startsWith('your-key')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No API key configured.' }));
        return;
      }
      try {
        // Today's date in ET (UTC-5 / UTC-4 DST) — resets with the new slate
        const etOffset = new Date().getTimezoneOffset() + (isDST() ? 240 : 300);
        const today = new Date(Date.now() - etOffset * 60000).toISOString().slice(0, 10);

        if (potdCache.data && potdCache.date === today) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...potdCache.data, _cached: true }));
          return;
        }

        const { prompt } = JSON.parse(body);
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
        });
        if (!upstream.ok) throw new Error(`Claude HTTP ${upstream.status}`);
        const data  = await upstream.json();
        const txt   = data?.content?.[0]?.text || '';
        const match = txt.match(/\{[\s\S]*\}/);
        const result = JSON.parse(match?.[0] || '{}');
        potdCache = { data: result, date: today };
        console.log(`POTD cached for ${today}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── ESPN proxy (cached) ────────────────────────────────────────────────────
  // Routes /api/espn?url=<espnUrl> through server-side cache.
  // Prevents ESPN from rate-blocking us under high traffic.
  if (req.method === 'GET' && req.url.startsWith('/api/espn')) {
    const rawUrl = req.url.slice('/api/espn'.length); // everything after /api/espn
    const targetUrl = decodeURIComponent(rawUrl.startsWith('?url=') ? rawUrl.slice(5) : rawUrl);

    // Only allow ESPN domains — block attempts to proxy arbitrary URLs
    if (!targetUrl.startsWith('https://site.api.espn.com') && !targetUrl.startsWith('https://sports.core.api.espn.com')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only ESPN API URLs are allowed' }));
      return;
    }
    try {
      const data = await fetchESPN(targetUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── NBA Stats proxy (cached) ───────────────────────────────────────────────
  // Routes /api/nba?url=<nbaUrl> through server-side cache with required NBA headers.
  // CORS prevents browsers from calling stats.nba.com directly.
  if (req.method === 'GET' && req.url.startsWith('/api/nba')) {
    const rawUrl = req.url.slice('/api/nba'.length);
    const targetUrl = decodeURIComponent(rawUrl.startsWith('?url=') ? rawUrl.slice(5) : rawUrl);

    // Only allow NBA Stats domain — block attempts to proxy arbitrary URLs
    if (!targetUrl.startsWith('https://stats.nba.com')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only stats.nba.com URLs are allowed' }));
      return;
    }
    try {
      const data = await fetchNBA(targetUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Odds API proxy (cached 30 min) ────────────────────────────────────────
  // Returns multi-book NBA odds. Cached server-side to preserve free tier quota.
  if (req.method === 'GET' && req.url === '/api/odds') {
    try {
      const result = await fetchOddsAPI();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ games: result.data, remaining: result.remaining, used: result.used }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, games: [] }));
    }
    return;
  }

  // ── Public betting % proxy (Action Network, cached 20 min) ────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/public-betting')) {
    try {
      // Get today's date in ET timezone for the API
      const now = new Date();
      const etOffset = -5; // EST (adjust for EDT in summer if needed)
      const et = new Date(now.getTime() + (now.getTimezoneOffset() + etOffset * -60) * 60000);
      const dateStr = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
      const data = await fetchActionNetwork(dateStr);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.warn('Action Network fetch failed:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ games: [] })); // fail silently — this is supplementary data
    }
    return;
  }

  // ── Static files (async reads — non-blocking) ─────────────────────────────
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  filePath = path.join(PUBLIC_DIR, filePath);

  // Security: stay within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIP = 'YOUR_IP';
  for (const iface of Object.values(nets).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
  }
  console.log('\n🏀  CourtIQ is live!\n');
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIP}:${PORT}  ← share this with friends\n`);
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('your-key')) {
    console.log('  ⚠️  Add your API key to .env: ANTHROPIC_API_KEY=sk-ant-...\n');
  }
});
