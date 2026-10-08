// Settings UI for the Cloudflare DDNS app. It writes the settings file that
// the wrapper (cloudflare-ddns/entrypoint.sh) reads, and shows the state the
// wrapper and ddns report. Umbrel's app proxy handles login, so there is no
// authentication here.
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const DATA_DIR = process.env.APP_DATA_DIR || '/data';
const ENV_FILE = path.join(DATA_DIR, 'cloudflare-ddns.env');
const LOG_FILE = path.join(DATA_DIR, 'cloudflare-ddns.log');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const LAST_CHANGE_FILE = path.join(DATA_DIR, 'last-change.json');
const PORT = 3000;
const LOG_TAIL_LINES = 500;              // lines kept for the Live Logs view
const LOG_INITIAL_BYTES = 256 * 1024;    // how much of the log to read at start
const DOMAIN_STATUS_TTL_MS = 60 * 1000;  // Cloudflare check cache

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Bootstrap is bundled (npm) rather than loaded from a CDN, so the page keeps
// its layout when the internet connection is down
app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/css')));

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

const VERSION = (readJson(path.join(__dirname, 'version.json')) || {}).version || 'unknown';

// ---------------------------------------------------------------------------
// Settings file (KEY=value lines, shared with the wrapper)

function readEnv() {
    const obj = {};
    let content = '';
    try { content = fs.readFileSync(ENV_FILE, 'utf8'); } catch (e) { return obj; }
    for (const line of content.split('\n')) {
        // Split on the FIRST "=" only: values such as an Uptime Kuma push URL
        // (`?status=up&msg=OK&ping=`) contain more of them
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const v = line.slice(eq + 1);
        obj[line.slice(0, eq)] = (v === 'undefined' || v === 'null') ? '' : v;
    }
    if (obj.API_KEY && !obj.CLOUDFLARE_API_TOKEN) obj.CLOUDFLARE_API_TOKEN = obj.API_KEY;
    return obj;
}

// Write the settings file in one step (temp file + rename), so the wrapper,
// which reads it every 3 s, never sees a half-written file. Mode 600: it
// holds the Cloudflare API token.
function writeEnvLines(lines) {
    const tmp = `${ENV_FILE}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, ENV_FILE);
}

function setEnabled(value) {
    const env = readEnv();
    env.ENABLED = value ? 'true' : 'false';
    writeEnvLines(Object.entries(env).map(([k, v]) => `${k}=${v}`));
}

function appendLog(message) {
    try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`); } catch (e) { console.error('Failed to append log', e); }
}

// ---------------------------------------------------------------------------
// Log reader: follows the log file and keeps what the page needs (the last
// lines, the detected IP addresses, the latest notifier failure) in memory.
// Every request used to re-read and scan the whole file (megabytes) instead.

const logState = { lines: [], ipv4: null, ipv6: null, notifierError: null, offset: 0, partial: '' };
let notifierErrorSeq = 0;

// favonia's notifier failures name the service: "Failed to send %s to
// Healthchecks", "Failed to ping Uptime Kuma", "Failed to send notifications
// via Shoutrrr" (internal/heartbeat, internal/notifier)
function notifierService(line) {
    if (!/\b(Failed|Could not)\b/.test(line)) return null;
    if (/\bHealthchecks\b/.test(line)) return 'healthchecks';
    if (/\bUptime Kuma\b/.test(line)) return 'uptimekuma';
    if (/\bShoutrrr\b/.test(line)) return 'shoutrrr';
    return null;
}

// Add a chunk of log text; returns the complete lines it contained
function ingestLog(text) {
    const parts = (logState.partial + text).split('\n');
    logState.partial = parts.pop();
    for (const line of parts) {
        // "the" and the colon are optional: current favonia versions log
        // "Detected IPv4 address: X", older ones "Detected the IPv4 address X"
        const v4 = line.match(/Detected (?:the )?IPv4 address:?\s+([0-9.]+)/i);
        if (v4) logState.ipv4 = v4[1];
        const v6 = line.match(/Detected (?:the )?IPv6 address:?\s+([0-9a-f:]+)/i);
        if (v6) logState.ipv6 = v6[1];
        const service = notifierService(line);
        if (service) logState.notifierError = { seq: ++notifierErrorSeq, service, line: line.trim() };
        logState.lines.push(line);
    }
    if (logState.lines.length > LOG_TAIL_LINES) logState.lines.splice(0, logState.lines.length - LOG_TAIL_LINES);
    return parts;
}

function readLogBytes(start, end) {
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
        const buf = Buffer.alloc(end - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
}

// (Re)load from the end of the file: at start, and when the wrapper has
// pruned the log (the file got smaller)
function loadLog() {
    Object.assign(logState, { lines: [], offset: 0, partial: '' });
    let size;
    try { size = fs.statSync(LOG_FILE).size; } catch (e) { return; }
    const start = Math.max(0, size - LOG_INITIAL_BYTES);
    let text = readLogBytes(start, size);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);  // drop the cut-off first line
    ingestLog(text);
    logState.offset = size;
}

// Polled once a second (fs.watchFile keeps working when the wrapper replaces
// the file while pruning it, which fs.watch doesn't). New lines go to all open
// pages in one message.
function followLog(cur) {
    if (cur.size < logState.offset) {
        loadLog();
        io.emit('log', logState.lines.join('\n'));
    } else if (cur.size > logState.offset) {
        const lines = ingestLog(readLogBytes(logState.offset, cur.size));
        logState.offset = cur.size;
        if (lines.length) io.emit('log-append', lines.join('\n'));
    }
}

loadLog();
fs.watchFile(LOG_FILE, { interval: 1000 }, followLog);

// ---------------------------------------------------------------------------
// Cloudflare: does each domain's record match the detected address?

function cfGet(pathname, token) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.cloudflare.com',
            path: `/client/v4${pathname}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// The zones (domains) the token can see. Each domain's zone is found by the
// longest matching suffix; guessing "the last two labels" gave "co.uk" for
// example.co.uk, so such domains never showed a status.
async function listZones(token) {
    const zones = [];
    for (let page = 1; page <= 10; page++) {
        const r = await cfGet(`/zones?per_page=50&page=${page}`, token);
        if (!r) return null;                      // network error
        if (r.success === false) return { authError: true };
        zones.push(...(r.result || []).map(z => ({ id: z.id, name: z.name.toLowerCase() })));
        const totalPages = (r.result_info && r.result_info.total_pages) || 1;
        if (page >= totalPages) break;
    }
    return { zones };
}

function findZone(zones, domain) {
    const d = domain.toLowerCase();
    return zones.filter(z => d === z.name || d.endsWith('.' + z.name))
        .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

const NO_RECORDS = { ipv4Match: false, ipv6Match: false, ipv4Proxied: null, ipv6Proxied: null };

async function checkDomain(zones, domain, token) {
    const zone = findZone(zones, domain);
    if (!zone) return Object.assign({ domain, status: 'pending', reason: 'Zone not found' }, NO_RECORDS);
    const name = encodeURIComponent(domain);
    const [a, aaaa] = await Promise.all([
        cfGet(`/zones/${zone.id}/dns_records?type=A&name=${name}`, token),
        cfGet(`/zones/${zone.id}/dns_records?type=AAAA&name=${name}`, token)
    ]);
    if (!a || !aaaa) return Object.assign({ domain, status: 'error', reason: 'Network error' }, NO_RECORDS);
    if (a.success === false || aaaa.success === false) return Object.assign({ domain, status: 'invalid', reason: 'Auth error' }, NO_RECORDS);
    const aRecords = a.result || [];
    const aaaaRecords = aaaa.result || [];
    const ipv4Match = !!logState.ipv4 && aRecords.some(r => r.content === logState.ipv4);
    const ipv6Match = !!logState.ipv6 && aaaaRecords.some(r => r.content === logState.ipv6);
    const ok = ipv4Match || ipv6Match;
    return {
        domain,
        status: ok ? 'ok' : 'pending',
        reason: ok ? 'Records match detected IPs' : 'Records differ from detected IPs',
        ipv4Match, ipv6Match,
        ipv4Proxied: aRecords.length ? aRecords[0].proxied : null,
        ipv6Proxied: aaaaRecords.length ? aaaaRecords[0].proxied : null
    };
}

async function checkDomains() {
    const env = readEnv();
    const token = env.CLOUDFLARE_API_TOKEN || '';
    const domains = (env.DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!domains.length) return { domains: [] };
    if (!token) return { domains: domains.map(d => Object.assign({ domain: d, status: 'missing', reason: 'Token missing' }, NO_RECORDS)) };
    const zl = await listZones(token);
    if (!zl || zl.authError) {
        const failure = zl ? { status: 'invalid', reason: 'Auth error' } : { status: 'error', reason: 'Network error' };
        return { domains: domains.map(d => Object.assign({ domain: d }, failure, NO_RECORDS)) };
    }
    return { domains: await Promise.all(domains.map(d => checkDomain(zl.zones, d, token))) };
}

// Cached for a minute and shared by every open page (each page used to make
// its own 1 + 2 per domain Cloudflare calls every 30 s). A save clears it.
let domainCache = null;   // { at, promise }
function domainStatus() {
    if (!domainCache || Date.now() - domainCache.at > DOMAIN_STATUS_TTL_MS) {
        domainCache = { at: Date.now(), promise: checkDomains().catch(e => ({ error: String(e) })) };
    }
    return domainCache.promise;
}

// ---------------------------------------------------------------------------
// Routes

app.get('/health', (req, res) => res.sendStatus(200));

// ---------------------------------------------------------------------------
// Update check: the version published in the app store (this app's
// umbrel-app.yml on GitHub), fetched at most every 10 minutes and shared by all
// pages, so a new release shows within about 15 minutes (it is one small
// file). Fails silently when
// offline.

const STORE_MANIFEST_URL = 'https://raw.githubusercontent.com/saltedlolly/umbrel-app-store/master/saltedlolly-cloudflare-ddns/umbrel-app.yml';
const UPDATE_CHECK_MS = 10 * 60 * 1000;
let storeVersion = { value: null, at: 0 };

function fetchText(url) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function latestStoreVersion() {
    if (Date.now() - storeVersion.at > UPDATE_CHECK_MS) {
        storeVersion.at = Date.now();
        const yml = await fetchText(STORE_MANIFEST_URL);
        const m = yml && yml.match(/^version:\s*"?([^"\s]+)"?/m);
        if (m) storeVersion.value = m[1];
    }
    return storeVersion.value;
}

// True if version a is newer than b ("v1.17.1.12" style, any number of parts)
function isNewer(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(Number);
    const pb = String(b).replace(/^v/, '').split('.').map(Number);
    if (pa.some(isNaN) || pb.some(isNaN)) return false;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

app.get('/api/version', async (req, res) => {
    const latest = await latestStoreVersion();
    res.json({ version: VERSION, latestVersion: latest, updateAvailable: !!latest && isNewer(latest, VERSION) });
});

app.get('/api/config', (req, res) => {
    // New install (no settings file yet): IPv6 starts off
    if (!fs.existsSync(ENV_FILE)) return res.json({ IP6_PROVIDER: 'none' });
    const cfg = readEnv();
    // Each notifier URL is stored as X while its switch is on and X_DISABLED
    // while off (the whole file is passed to ddns, which must not see a
    // switched-off URL). The page gets the URL as X either way.
    for (const n of ['HEALTHCHECKS', 'UPTIMEKUMA', 'SHOUTRRR']) {
        const on = cfg[`${n}_ENABLED`] === 'yes';
        cfg[n] = on ? (cfg[n] || '') : (cfg[`${n}_DISABLED`] || '');
        if (cfg[`${n}_ENABLED`] === undefined && cfg[n]) cfg[`${n}_ENABLED`] = 'yes';
    }
    res.json(cfg);
});

app.post('/api/config', (req, res) => {
    const existing = readEnv();
    const body = req.body || {};

    // Partial update: a field the request doesn't mention keeps its stored
    // value. Several parts of the page save independently (each switch, each
    // Save button), and filling unmentioned fields with blanks lost changes
    // when two saves overlapped.
    const pick = (key, fallback) => (Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback);

    const token = pick('CLOUDFLARE_API_TOKEN', existing.CLOUDFLARE_API_TOKEN) || '';
    const domains = (pick('DOMAINS', existing.DOMAINS) || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
    const proxied = pick('PROXIED', existing.PROXIED) || 'true';
    const ip4 = pick('IP4_PROVIDER', existing.IP4_PROVIDER) || '';
    // No settings file yet means a new install, where IPv6 starts off (the
    // wrapper writes the same default when it starts)
    const ip6 = pick('IP6_PROVIDER', fs.existsSync(ENV_FILE) ? existing.IP6_PROVIDER : 'none') || '';

    const lines = [
        `CLOUDFLARE_API_TOKEN=${token}`,
        `DOMAINS=${domains}`,
        `PROXIED=${proxied}`,
        `IP4_PROVIDER=${ip4}`,
        `IP6_PROVIDER=${ip6}`
    ];
    // Notifiers: the URL goes in X while the switch is on, in X_DISABLED while
    // it's off (see GET /api/config). Shoutrrr URLs are stored comma-separated.
    for (const n of ['HEALTHCHECKS', 'UPTIMEKUMA', 'SHOUTRRR']) {
        const on = pick(`${n}_ENABLED`, existing[`${n}_ENABLED`]) === 'yes';
        let url = pick(n, existing[n] || existing[`${n}_DISABLED`]) || '';
        if (n === 'SHOUTRRR') url = url.split('\n').map(s => s.trim()).filter(Boolean).join(',');
        lines.push(`${n}=${on ? url : ''}`, `${n}_DISABLED=${on ? '' : url}`, `${n}_ENABLED=${on ? 'yes' : 'no'}`);
    }

    // Enabled state: without a token the service can't run. A new or changed
    // token starts it. Any other save keeps the current state, so a user who
    // pressed Disable isn't switched back on by changing an unrelated setting.
    const hasToken = !!token;
    const tokenChanged = hasToken && token !== existing.CLOUDFLARE_API_TOKEN;
    lines.push(`ENABLED=${!hasToken ? 'false' : (tokenChanged ? 'true' : (existing.ENABLED || 'true'))}`);

    try {
        writeEnvLines(lines);
        domainCache = null;
        appendLog(`Config updated via UI by ${req.headers['x-umbrel-username'] || 'local'}`);
        // No need to signal ddns: the wrapper checks the settings file every
        // 3 s and restarts ddns when it changes
        if (tokenChanged) {
            // The wrapper's error scanning ignores auth errors logged before
            // this marker, so only write it when the token really changed
            appendLog('──── NEW TOKEN CONFIGURED ────');
            if (existing.ENABLED !== 'true') appendLog('Service auto-enabled after saving a new API token');
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Saving settings failed', e);
        appendLog(`Config update failed: ${String(e)}`);
        res.status(500).json({ error: String(e) });
    }
});

// Everything the page refreshes regularly, in one request. status.json is
// written by the wrapper; last-change.json records the last real DNS change.
app.get('/api/state', (req, res) => {
    // Before the wrapper has written its first status.json (it starts
    // shortly after this UI), go by the settings file
    const s = readJson(STATUS_FILE) || { enabled: readEnv().ENABLED !== 'false', status: 'starting' };
    const c = readJson(LAST_CHANGE_FILE) || {};
    res.json({
        enabled: !!s.enabled,
        running: !!s.running,
        status: s.status || (s.enabled ? 'starting' : 'disabled'),
        error: s.error || null,
        lastSuccessfulCheck: s.lastSuccessfulCheck || null,
        lastUpdate: { ipv4: c.ipv4 || null, ipv6: c.ipv6 || null },
        publicIp: { ipv4: logState.ipv4, ipv6: logState.ipv6 },
        notifierError: logState.notifierError
    });
});

app.get('/api/domain-status', async (req, res) => {
    const result = await domainStatus();
    if (result.error) return res.status(500).json(result);
    res.json(result);
});

app.get('/api/logs', (req, res) => {
    const tail = Math.min(parseInt(req.query.tail, 10) || LOG_TAIL_LINES, LOG_TAIL_LINES);
    res.type('text/plain').send(logState.lines.slice(-tail).join('\n'));
});

app.post('/api/service/start', (req, res) => {
    try {
        const env = readEnv();
        if (!env.CLOUDFLARE_API_TOKEN) return res.status(400).json({ error: 'Missing Cloudflare API token' });
        if (!env.DOMAINS) return res.status(400).json({ error: 'No domains configured' });
        setEnabled(true);
        // The wrapper treats this line as a marker: token errors logged before
        // it no longer count
        appendLog(`Service enabled via UI by ${req.headers['x-umbrel-username'] || 'local'}`);
        res.json({ success: true });
    } catch (e) { appendLog(`Enable failed: ${String(e)}`); res.status(500).json({ error: String(e) }); }
});

app.post('/api/service/stop', (req, res) => {
    try {
        setEnabled(false);
        appendLog(`Service disabled via UI by ${req.headers['x-umbrel-username'] || 'local'}`);
        res.json({ success: true });
    } catch (e) { appendLog(`Disable failed: ${String(e)}`); res.status(500).json({ error: String(e) }); }
});

// Live Logs: the current lines on connect, then only new lines (followLog)
io.on('connection', (socket) => socket.emit('log', logState.lines.join('\n')));

server.listen(PORT, () => { console.log(`UI listening on ${PORT}`); appendLog('UI started'); });
