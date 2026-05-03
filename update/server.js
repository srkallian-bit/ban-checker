const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');

const isPackaged = typeof process.pkg !== 'undefined';
const APP_VERSION = '1.0.1';
const UPDATE_REPO = 'srkallian/ban-checker';

const rulesDatabase = require('./rules.js');
const { validateBanReason } = require('./checker.js');

const PORT = process.env.PORT || 3000;
const APP_DIR = isPackaged ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ban-checker') : __dirname;
if (isPackaged && !fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
const DATA_DIR = process.env.RENDER ? '/opt/render/project/src/data' : APP_DIR;
const SERVE_DIR = __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.db');
const MAX_CONCURRENT = 15;
const MIN_CONCURRENT = 3;
const BACKOFF_MS = 1500;
const LAUNCH_THROTTLE_MS = 50;

let db;
let saveTimer = null;

function initDb() {
  const initSql = `
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS bans (
      adminSteamId TEXT NOT NULL,
      adminName TEXT DEFAULT '',
      targetSteamId TEXT NOT NULL,
      targetName TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      banLen INTEGER DEFAULT 0,
      banTime INTEGER DEFAULT 0,
      unbanTime INTEGER DEFAULT 0,
      unbanReason TEXT DEFAULT '',
      _aLc TEXT DEFAULT '',
      _tLc TEXT DEFAULT '',
      _rLc TEXT DEFAULT '',
      _problematic INTEGER DEFAULT 0,
      UNIQUE(adminSteamId, targetSteamId, banTime, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_bans_admin ON bans(adminSteamId);
    CREATE INDEX IF NOT EXISTS idx_bans_target ON bans(targetSteamId);
    CREATE INDEX IF NOT EXISTS idx_bans_time ON bans(banTime DESC);
    CREATE INDEX IF NOT EXISTS idx_bans_prob ON bans(_problematic);
    CREATE TABLE IF NOT EXISTS avatars (steamId TEXT PRIMARY KEY, url TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS player_info (steamId TEXT PRIMARY KEY, data TEXT, ts INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS player_bans_cache (steamId TEXT PRIMARY KEY, data TEXT, ts INTEGER DEFAULT 0);
  `;
  db.run(initSql);
}

function run(sql, params) {
  if (params && params.length > 0) {
    db.run(sql, params);
  } else {
    db.run(sql);
  }
}

function get(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function saveDb() {
  try {
    const data = db.export();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveDb();
    saveTimer = null;
  }, 5000);
}

let TOKEN = '';
try {
  const row = get('SELECT value FROM settings WHERE key = ?', ['cookie']);
  if (row) TOKEN = row.value;
} catch (e) {}

function saveToken(t) {
  TOKEN = t;
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', ['cookie', t]);
  scheduleSave();
}

const valCache = new Map();
function getVal(b) {
  if (!b || !b.adminSteamId) return { is_valid: true, is_suspicious: false, messages: [] };
  const k = b.adminSteamId + '|' + b.targetSteamId + '|' + b.banTime + '|' + b.reason;
  let v = valCache.get(k);
  if (!v) { v = validateBanReason(b, rulesDatabase); valCache.set(k, v); }
  return v;
}

let banCache = { items: [], total: 0, loading: false, loaded: false, progress: 0, loadedCount: 0, stats: { suspicious: 0, invalid: 0, computed: false, computing: false } };
let indexReady = false;

function buildBanIndex() {
  suspCount = 0; invCount = 0;
  const rows = all('SELECT * FROM bans');
  let probCnt = 0;
  for (const b of rows) {
    const v = getVal(b);
    if (!v.is_valid) invCount++; else if (v.is_suspicious) suspCount++;
    const isProblematic = !v.is_valid || v.is_suspicious;
    if (isProblematic) probCnt++;
  }
  banCache.stats = { suspicious: suspCount, invalid: invCount, computed: true, computing: false };
  banCache.loadedCount = rows.length;
  indexReady = true;
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', ['stats', JSON.stringify(banCache.stats)]);
  scheduleSave();
  console.log(`Index: ${rows.length} bans, ${probCnt} problematic, ${suspCount} susp, ${invCount} inv`);
}

function upstreamRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = options.body || null;
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: { ...options.headers },
      rejectUnauthorized: false,
      timeout: options.timeout || 30000
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { res.json = () => safeParseJson(data); res.text = () => data; resolve(res); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await upstreamRequest(url, options); }
    catch (e) { if (i < retries - 1) await new Promise(r => setTimeout(r, 5000 * (i + 1))); else throw e; }
  }
}

function safeParseJson(text) {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && (text[j] !== '"' || text[j-1] === '\\')) j++;
      out += text.substring(i, j + 1); i = j + 1;
    } else if (text[i] === ':' && i + 1 < text.length) {
      out += ':'; i++;
      let ni = i;
      while (ni < text.length && text[ni] === ' ') ni++;
      if (ni < text.length && text[ni] >= '0' && text[ni] <= '9') {
        let numEnd = ni;
        while (numEnd < text.length && text[numEnd] >= '0' && text[numEnd] <= '9') numEnd++;
        const numStr = text.substring(ni, numEnd);
        out += numStr.length > 10 ? text.substring(i, ni) + '"' + numStr + '"' : text.substring(i, numEnd);
        i = numEnd;
      } else i = ni;
    } else { out += text[i]; i++; }
  }
  return JSON.parse(out);
}

function authHeaders(extra) {
  let ck = TOKEN;
  if (ck && !ck.includes('=')) ck = 'Token=' + ck;
  return Object.assign({ "accept": "application/json, text/plain, */*", "cookie": ck, "user-agent": "Mozilla/5.0" }, extra || {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function fetchPage(page, pageSize) {
  const r = await fetchWithRetry("https://admin.umbrellarp.shop/api/server/1/bans", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ page, pageSize, sortKey: "ban_time", sortDirection: "DESC" }),
    timeout: 30000
  });
  if (r.statusCode >= 400) throw new Error('HTTP ' + r.statusCode);
  const d = r.json();
  return { items: d.items || [], total: d.total || 0 };
}

async function testConnection() {
  try {
    const r = await fetchWithRetry("https://admin.umbrellarp.shop/api/server/1/bans", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ page: 0, pageSize: 1, sortKey: "ban_time", sortDirection: "DESC" }),
      timeout: 15000
    }, 5);
    return r.statusCode < 400;
  } catch (err) { return false; }
}

function insertBans(items) {
  run('BEGIN TRANSACTION');
  for (const b of items) {
    if (!b || !b.adminSteamId) continue;
    const v = getVal(b);
    const isProblematic = !v.is_valid || v.is_suspicious ? 1 : 0;
    run(`INSERT OR IGNORE INTO bans(adminSteamId,adminName,targetSteamId,targetName,reason,banLen,banTime,unbanTime,unbanReason,_aLc,_tLc,_rLc,_problematic) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      b.adminSteamId, b.adminName || '', b.targetSteamId, b.targetName || '',
      b.reason || '', b.banLen || 0, b.banTime || 0, b.unbanTime || 0, b.unbanReason || '',
      (b.adminName || '').toLowerCase(), (b.targetName || '').toLowerCase(), (b.reason || '').toLowerCase(),
      isProblematic
    ]);
  }
  run('COMMIT');
  scheduleSave();
}

async function loadAllBans() {
  if (banCache.loading) return;
  banCache.loading = true;
  banCache.loaded = false;
  valCache.clear();
  try {
    const probe = await fetchPage(0, 5000);
    const ps = probe.items.length || 100;
    banCache.total = probe.total;
    console.log(`PageSize=${ps}, total=${banCache.total}`);
    insertBans(probe.items);
    banCache.loadedCount = get('SELECT COUNT(*) as c FROM bans').c;
    banCache.progress = Math.min(98, Math.round(banCache.loadedCount / banCache.total * 100));

    const maxPage = Math.ceil(banCache.total / ps);
    const existingCount = banCache.loadedCount;
    const pagesDone = Math.floor(existingCount / ps);
    const todo = [];
    for (let p = pagesDone; p < maxPage; p++) todo.push(p);

    if (todo.length === 0) {
      banCache.loaded = true; banCache.progress = 100; banCache.loading = false;
      buildBanIndex(); startAvatarPrefetch(); startBanPoll();
      console.log(`All bans loaded: ${existingCount}`);
      return;
    }

    console.log(`Need to fetch ${todo.length} pages`);
    let concurrent = Math.min(MAX_CONCURRENT, Math.max(MIN_CONCURRENT, 3));
    let idx = 0, inFlight = 0, consecutiveErrors = 0, consecutiveOk = 0;
    let lastLog = Date.now();

    await new Promise(resolve => {
      function next() {
        while (inFlight < concurrent && idx < todo.length) {
          const pg = todo[idx++]; inFlight++;
          setTimeout(() => {
            fetchPage(pg, ps).then(data => {
              inFlight--; consecutiveErrors = 0; consecutiveOk++;
              if (consecutiveOk >= 10 && concurrent < MAX_CONCURRENT) { concurrent = Math.min(concurrent + 2, MAX_CONCURRENT); consecutiveOk = 0; }
              insertBans(data.items);
              banCache.loadedCount = get('SELECT COUNT(*) as c FROM bans').c;
              banCache.progress = Math.min(98, Math.round(banCache.loadedCount / banCache.total * 100));
              const now = Date.now();
              if (now - lastLog > 3000) { console.log(`Bans: ${banCache.loadedCount}/${banCache.total} (${banCache.progress}%) conc=${concurrent}`); lastLog = now; }
              next();
            }).catch(err => {
              inFlight--; consecutiveOk = 0; consecutiveErrors++;
              if (consecutiveErrors >= 2) { concurrent = Math.max(concurrent - 1, MIN_CONCURRENT); consecutiveErrors = 0; }
              if (idx < todo.length) setTimeout(next, BACKOFF_MS); else next();
            });
          }, LAUNCH_THROTTLE_MS);
        }
        if (inFlight === 0 && idx >= todo.length) resolve();
      }
      next();
    });

    banCache.loaded = banCache.loadedCount >= banCache.total;
    banCache.progress = 100; banCache.loading = false;
    buildBanIndex(); startAvatarPrefetch(); startBanPoll();
    console.log(`All bans loaded: ${banCache.loadedCount}/${banCache.total}`);
  } catch (error) {
    banCache.loading = false;
    console.error('Failed to load bans:', error.message);
  }
}

function fromSteamId(s) {
  const m = String(s).match(/^STEAM_\d+:(\d+):(\d+)$/i);
  if (!m) return s;
  return String(76561197960265728n + BigInt(parseInt(m[2]) * 2 + parseInt(m[1])));
}

let updateInfo = null;

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/api/update/check') {
    res.end(JSON.stringify(updateInfo ? { available: true, version: updateInfo.version, current: APP_VERSION } : { available: false, current: APP_VERSION }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/update/apply') {
    if (!updateInfo) { res.end(JSON.stringify({ error: 'no update' })); return; }
    res.end(JSON.stringify({ ok: true }));
    applyUpdateNow();
    return;
  }

  if (updateInfo && isPackaged) {
    if (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/api/update')) {
      // allow through
    } else {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'update required', version: updateInfo.version }));
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/api/settings/cookie') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      let token = (data.cookie || '').trim();
      if (token && !token.includes('=') && !token.startsWith('Token=')) token = 'Token=' + token;
      if (token) {
        saveToken(token);
        run('DELETE FROM bans');
        scheduleSave();
        valCache.clear();
        banCache = { items: [], total: 0, loading: false, loaded: false, progress: 0, loadedCount: 0, stats: { suspicious: 0, invalid: 0, computed: false, computing: false } };
        indexReady = false;
        retryConnect();
        res.end(JSON.stringify({ ok: true }));
      } else res.end(JSON.stringify({ error: 'no token' }));
    } catch (error) { res.end(JSON.stringify({ error: error.message })); }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/settings/cookie') {
    res.end(JSON.stringify({ hasCookie: TOKEN.length > 0, hasToken: TOKEN.includes('Token='), hasCfClearance: TOKEN.includes('cf_clearance') }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/bans/reload') {
    if (!TOKEN) { res.writeHead(401); res.end(JSON.stringify({ error: 'No cookie set' })); return; }
    run('DELETE FROM bans');
    scheduleSave();
    valCache.clear();
    banCache = { items: [], total: 0, loading: false, loaded: false, progress: 0, loadedCount: 0, stats: { suspicious: 0, invalid: 0, computed: false, computing: false } };
    indexReady = false;
    loadAllBans();
    res.end(JSON.stringify({ ok: true, message: 'Reload started' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/bans/status') {
    res.end(JSON.stringify({
      loading: banCache.loading, loaded: banCache.loaded,
      total: banCache.total, loadedCount: banCache.loadedCount,
      progress: banCache.progress,
      hasCookie: TOKEN.length > 0, hasToken: TOKEN.includes('Token='), hasCfClearance: TOKEN.includes('cf_clearance')
    }));
    return;
  }

  if (req.url === '/api/bans/stats') {
    if (!TOKEN) { res.writeHead(401); res.end('{"error":"No cookie"}'); return; }
    if (!banCache.stats.computed && banCache.loaded) buildBanIndex();
    res.end(JSON.stringify({ total: banCache.total, loaded: banCache.loadedCount, suspicious: banCache.stats.suspicious, invalid: banCache.stats.invalid, computed: banCache.stats.computed }));
    return;
  }

  if (req.url.startsWith('/api/bans') && !req.url.startsWith('/api/bans/status') && !req.url.startsWith('/api/bans/stats') && !req.url.startsWith('/api/bans/reload')) {
    if (!TOKEN) { res.writeHead(401); res.end('{"error":"No cookie"}'); return; }
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const page = parseInt(url.searchParams.get('page') || '0');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    const filter = url.searchParams.get('filter') || 'all';
    const sf = url.searchParams.get('searchField') || 'admin';
    const sq = (url.searchParams.get('searchQuery') || '').toLowerCase();
    const offset = page * pageSize;

    let items, total;
    if (sq) {
      const sqId = fromSteamId(sq);
      const isId = sqId !== sq || /^\d{10,}$/.test(sq);
      const idVal = isId ? (sqId !== sq ? sqId : sq) : sq;

      if (sf === 'admin') {
        if (isId) {
          total = get('SELECT COUNT(*) as c FROM bans WHERE adminSteamId = ?', [idVal]).c;
          items = all('SELECT * FROM bans WHERE adminSteamId = ? ORDER BY banTime DESC LIMIT ? OFFSET ?', [idVal, pageSize, offset]);
        } else {
          total = get('SELECT COUNT(*) as c FROM bans WHERE _aLc LIKE ?', ['%' + sq + '%']).c;
          items = all('SELECT * FROM bans WHERE _aLc LIKE ? ORDER BY banTime DESC LIMIT ? OFFSET ?', ['%' + sq + '%', pageSize, offset]);
        }
      } else if (sf === 'player') {
        if (isId) {
          total = get('SELECT COUNT(*) as c FROM bans WHERE targetSteamId = ?', [idVal]).c;
          items = all('SELECT * FROM bans WHERE targetSteamId = ? ORDER BY banTime DESC LIMIT ? OFFSET ?', [idVal, pageSize, offset]);
        } else {
          total = get('SELECT COUNT(*) as c FROM bans WHERE _tLc LIKE ?', ['%' + sq + '%']).c;
          items = all('SELECT * FROM bans WHERE _tLc LIKE ? ORDER BY banTime DESC LIMIT ? OFFSET ?', ['%' + sq + '%', pageSize, offset]);
        }
      } else {
        total = get('SELECT COUNT(*) as c FROM bans WHERE _rLc LIKE ?', ['%' + sq + '%']).c;
        items = all('SELECT * FROM bans WHERE _rLc LIKE ? ORDER BY banTime DESC LIMIT ? OFFSET ?', ['%' + sq + '%', pageSize, offset]);
      }
    } else if (filter === 'problematic') {
      total = get('SELECT COUNT(*) as c FROM bans WHERE _problematic = 1').c;
      items = all('SELECT * FROM bans WHERE _problematic = 1 ORDER BY banTime DESC LIMIT ? OFFSET ?', [pageSize, offset]);
    } else if (filter === 'normal') {
      total = get('SELECT COUNT(*) as c FROM bans WHERE _problematic = 0').c;
      items = all('SELECT * FROM bans WHERE _problematic = 0 ORDER BY banTime DESC LIMIT ? OFFSET ?', [pageSize, offset]);
    } else {
      total = get('SELECT COUNT(*) as c FROM bans').c;
      items = all('SELECT * FROM bans ORDER BY banTime DESC LIMIT ? OFFSET ?', [pageSize, offset]);
    }

    res.end(JSON.stringify({ items, total, page, pageSize }));
    return;
  }

  if (req.url === '/api/players/online') {
    try {
      const response = await fetchWithRetry("https://admin.umbrellarp.shop/api/server/1/player/online", { method: "GET", headers: authHeaders() });
      res.end(JSON.stringify(response.json()));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    return;
  }

  if (req.url.startsWith('/api/player/find/')) {
    const steamId = decodeURIComponent(req.url.split('/api/player/find/')[1] || '');
    try {
      const response = await fetchWithRetry(`https://admin.umbrellarp.shop/api/server/1/player/find?info=${encodeURIComponent(steamId)}`, { method: "GET", headers: authHeaders() });
      res.end(JSON.stringify(response.json()));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    return;
  }

  if (req.url.startsWith('/api/player/')) {
    const after = req.url.split('/api/player/')[1] || '';
    if (!after || !/^\d+/.test(after)) { res.writeHead(400); res.end('{"error":"Invalid SteamID"}'); return; }
    const steamId = after.split('/')[0];
    const isBans = after.endsWith('/bans');
    try {
      let data;
      if (isBans) {
        const cached = get('SELECT data, ts FROM player_bans_cache WHERE steamId = ?', [steamId]);
        if (cached && Date.now() - cached.ts < 120000) {
          data = JSON.parse(cached.data);
        } else {
          data = all('SELECT * FROM bans WHERE targetSteamId = ? OR adminSteamId = ? ORDER BY banTime DESC', [steamId, steamId]);
          run('INSERT OR REPLACE INTO player_bans_cache(steamId, data, ts) VALUES(?, ?, ?)', [steamId, JSON.stringify(data), Date.now()]);
          scheduleSave();
        }
      } else {
        const cached = get('SELECT data, ts FROM player_info WHERE steamId = ?', [steamId]);
        if (cached && Date.now() - cached.ts < 60000) {
          data = JSON.parse(cached.data);
        } else {
          const url = `https://admin.umbrellarp.shop/api/server/1/player/${steamId}`;
          const response = await fetchWithRetry(url, { method: "GET", headers: authHeaders() });
          if (response.statusCode >= 200 && response.statusCode !== 204) {
            const raw = response.text();
            try { data = safeParseJson(raw); } catch(e) { data = {}; }
            if (data) { run('INSERT OR REPLACE INTO player_info(steamId, data, ts) VALUES(?, ?, ?)', [steamId, JSON.stringify(data), Date.now()]); scheduleSave(); }
          } else data = {};
        }
      }
      res.end(JSON.stringify(data));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    return;
  }

  if (req.url.startsWith('/api/steam/avatars?')) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const steamIds = params.get('steamIds');
    if (!steamIds) { res.writeHead(400); res.end('{}'); return; }
    const ids = steamIds.split(',').filter(Boolean).slice(0, 50);
    const map = {};
    const missing = [];
    for (const id of ids) {
      const row = get('SELECT url FROM avatars WHERE steamId = ?', [id]);
      if (row && row.url) map[id] = row.url;
      else missing.push(id);
    }
    res.end(JSON.stringify(map));
    if (missing.length > 0) {
      for (const id of missing) run('INSERT OR REPLACE INTO avatars(steamId, url) VALUES(?, ?)', [id, '']);
      scheduleSave();
      const batchSize = 20;
      (async () => {
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize);
          const results = await Promise.allSettled(batch.map(async id => {
            try {
              const r = await upstreamRequest(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
                method: "GET", headers: { "user-agent": "Mozilla/5.0", "accept": "text/xml" }, timeout: 10000
              });
              if (r.statusCode >= 400) return { id, url: '' };
              const m = r.text().match(/<avatarFull><!\[CDATA\[(.*?)\]\]>/);
              return { id, url: m ? m[1] : '' };
            } catch (e) { return { id, url: '' }; }
          }));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value.url) run('INSERT OR REPLACE INTO avatars(steamId, url) VALUES(?, ?)', [r.value.id, r.value.url]);
          }
          scheduleSave();
          await new Promise(r => setTimeout(r, 100));
        }
      })();
    }
    return;
  }

  let filePath = path.join(SERVE_DIR, req.url === '/' ? 'index.html' : req.url);
  if (!filePath.startsWith(SERVE_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const contentType = mimeTypes[extname] || 'application/octet-stream';
  fs.readFile(filePath, (error, content) => {
    if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code || 'Error'); }
    else { res.writeHead(200, { 'Content-Type': contentType }); res.end(content, 'utf-8'); }
  });
});

function boot() {
  const banCount = get('SELECT COUNT(*) as c FROM bans').c;
  if (banCount > 0 && TOKEN) {
    banCache.loadedCount = banCount;
    const statsRow = get('SELECT value FROM settings WHERE key = ?', ['stats']);
    if (statsRow) { try { banCache.stats = { ...JSON.parse(statsRow.value), computing: false }; } catch(e) {} }
    console.log(`DB: ${banCount} bans, building index...`);
    buildBanIndex(); startAvatarPrefetch(); startBanPoll();
    const totalRow = get('SELECT value FROM settings WHERE key = ?', ['total']);
    if (totalRow) banCache.total = parseInt(totalRow.value) || banCount;
    if (banCount < banCache.total) loadAllBans();
    else banCache.loaded = true;
  } else if (TOKEN) {
    console.log('Cookie found, testing connection...');
    retryConnect();
  } else {
    console.log('No cookie. Open settings to add.');
  }
}

async function main() {
  const sqlJs = require('sql.js');
  const sqlJsOpts = {};
  if (isPackaged) {
    const wasmPath = path.join(path.dirname(__dirname), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    sqlJsOpts.wasmBinary = wasmBinary;
  }
  const SQL = await sqlJs(sqlJsOpts);
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  initDb();
  try {
    const row = get('SELECT value FROM settings WHERE key = ?', ['cookie']);
    if (row) TOKEN = row.value;
  } catch (e) {}

  if (typeof PhusionPassenger !== 'undefined') {
    PhusionPassenger.configure({ autoInstall: false });
    server.listen('passenger', boot);
  } else {
    server.listen(PORT, () => {
      console.log(`Server: http://localhost:${PORT}`);
      boot();
      if (!process.env.RENDER && !process.env.NO_OPEN) {
        setTimeout(() => {
          const url = `http://localhost:${PORT}`;
          exec(process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`);
        }, 1500);
      }
      if (isPackaged) checkForUpdates();
    });
  }

  setInterval(scheduleSave, 30000);
}

main().catch(e => { console.error('Startup error:', e); process.exit(1); });

module.exports = server;

async function checkForUpdates() {
  if (!UPDATE_REPO) return;
  try {
    const res = await upstreamRequest(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'ban-checker' }, timeout: 10000 }
    );
    if (res.statusCode !== 200) return;
    const release = res.json();
    const latest = (release.tag_name || '').replace(/^v/, '');
    if (!latest || latest === APP_VERSION) return;
    const asset = (release.assets || []).find(a => a.name && a.name.endsWith('.exe'));
    if (!asset) { console.log(`Update v${latest} available, no EXE asset.`); return; }
    console.log(`Update available: v${latest}`);
    updateInfo = { version: latest, downloadUrl: asset.browser_download_url };
    if (isPackaged) setInterval(() => checkForUpdates, 300000);
  } catch (e) { console.log('Update check failed:', e.message); }
}

async function applyUpdateNow() {
  if (!updateInfo) return;
  const exePath = process.execPath;
  const updatePath = exePath + '.update';
  const batPath = exePath + '.updater.bat';
  try {
    console.log('Downloading update...');
    const data = await downloadFile(updateInfo.downloadUrl);
    if (!data) { console.error('Download failed'); updateInfo = null; return; }
    fs.writeFileSync(updatePath, data);
    const exeName = path.basename(exePath);
    const exeDir = path.dirname(exePath);
    const bat = `@echo off\r\ntimeout /t 2 /nobreak >nul\r\ndel "${exePath}.old" 2>nul\r\nren "${exePath}" "${exeName}.old"\r\nren "${updatePath}" "${exeName}"\r\nstart "" "${exePath}"\r\ndel "${batPath}"\r\n`;
    fs.writeFileSync(batPath, bat);
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
    console.log('Update applied, restarting...');
    process.exit(0);
  } catch (e) {
    console.error('Update apply failed:', e.message);
    try { if (fs.existsSync(updatePath)) fs.unlinkSync(updatePath); } catch(e2) {}
    updateInfo = null;
  }
}

function downloadFile(url) {
  return new Promise(resolve => {
    const doReq = (opts) => {
      const req = https.request(opts, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          try {
            const u = new URL(res.headers.location);
            doReq({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', rejectUnauthorized: false, timeout: 120000, headers: { 'User-Agent': 'ban-checker' } });
          } catch(e) { resolve(null); }
          return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    };
    const u = new URL(url);
    doReq({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', rejectUnauthorized: false, timeout: 120000, headers: { 'User-Agent': 'ban-checker' } });
  });
}

function retryConnect() {
  let attempts = 0;
  async function tryConnect() {
    attempts++;
    console.log(`Connection ${attempts}/30...`);
    const ok = await testConnection();
    if (ok) { loadAllBans(); return; }
    if (attempts < 30) setTimeout(tryConnect, Math.min(10000 * attempts, 60000));
    else console.warn('Connection failed after 30 attempts');
  }
  tryConnect();
}

function startAvatarPrefetch() {
  const rows = all('SELECT adminSteamId as id, COUNT(*) as c FROM bans GROUP BY adminSteamId ORDER BY c DESC LIMIT 300');
  const top = rows.map(r => r.id);
  console.log(`Avatar prefetch: ${top.length} top admins`);
  let idx = 0;
  async function fetchBatch() {
    while (idx < top.length) {
      const batch = top.slice(idx, idx + 20); idx += 20;
      const results = await Promise.allSettled(batch.map(async id => {
        const existing = get('SELECT url FROM avatars WHERE steamId = ?', [id]);
        if (existing && existing.url) return;
        try {
          const r = await upstreamRequest(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
            method: "GET", headers: { "user-agent": "Mozilla/5.0", "accept": "text/xml" }, timeout: 8000
          });
          if (r.statusCode >= 400) return;
          const m = r.text().match(/<avatarFull><!\[CDATA\[(.*?)\]\]>/);
          if (m && m[1]) { run('INSERT OR REPLACE INTO avatars(steamId, url) VALUES(?, ?)', [id, m[1]]); scheduleSave(); }
        } catch (e) {}
      }));
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('Avatar prefetch done');
  }
  fetchBatch();
}

let banPollTimer = null;
function startBanPoll() {
  if (banPollTimer) return;
  console.log('Ban polling started (60s)');
  banPollTimer = setInterval(pollNewBans, 60000);
}

async function pollNewBans() {
  if (!banCache.loaded || banCache.loading) return;
  try {
    const r = await fetchPage(0, 5000);
    if (!r.items || !r.items.length) return;
    if (r.total > banCache.total) { banCache.total = r.total; run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', ['total', String(banCache.total)]); scheduleSave(); }
    const existingRows = all('SELECT adminSteamId || "|" || targetSteamId || "|" || banTime || "|" || reason as k FROM bans');
    const existingKeys = new Set(existingRows.map(r => r.k));
    let added = 0;
    const newBans = [];
    for (const b of r.items) {
      const k = b.adminSteamId + '|' + b.targetSteamId + '|' + b.banTime + '|' + b.reason;
      if (!existingKeys.has(k)) { newBans.push(b); added++; existingKeys.add(k); }
    }
    if (added > 0) {
      insertBans(newBans);
      banCache.loadedCount = get('SELECT COUNT(*) as c FROM bans').c;
      const v = getVal(newBans[0]);
      if (!v.is_valid) banCache.stats.invalid++; else if (v.is_suspicious) banCache.stats.suspicious++;
      console.log(`Added ${added} new bans`);
    }
  } catch (e) { console.error('Ban poll error:', e.message); }
}
