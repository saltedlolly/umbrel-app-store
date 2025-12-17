const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = process.env.APP_DATA_DIR || '/data';
const ENV_FILE = path.join(DATA_DIR, 'cloudflare-ddns.env');
const LOG_FILE = path.join(DATA_DIR, 'cloudflare-ddns.log');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const https = require('https');

app.use(bodyParser.json());
app.use(express.static('public'));

// Health endpoint used by container healthchecks
app.get('/health', (req, res) => res.sendStatus(200));

// Version endpoint - reads from version.json (baked in at build time)
app.get('/api/version', (req, res) => {
    try {
        const versionPath = path.join(__dirname, 'version.json');
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        res.json({ version: versionData.version || 'unknown' });
    } catch (e) {
        console.error('Failed to read version from version.json:', e);
        res.json({ version: 'unknown' });
    }
});

// Note: Umbrel handles authentication at the proxy level, no need for custom auth middleware

function ensureDirs() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`[ensureDirs] Created DATA_DIR: ${DATA_DIR}`);
    } catch (e) {
        console.error(`[ensureDirs] Failed to create DATA_DIR: ${e.message}`);
    }
}

ensureDirs();

app.get('/api/config', (req, res) => {
    if (!fs.existsSync(ENV_FILE)) return res.json({});
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const obj = {};
    content.split('\n').filter(Boolean).forEach(line => {
        const [k, v] = line.split('=');
        obj[k] = (v === 'undefined' || v === 'null') ? '' : v;
    });
    // Support older env var names and provide a user-friendly config
    if (obj.API_KEY && !obj.CLOUDFLARE_API_TOKEN) obj.CLOUDFLARE_API_TOKEN = obj.API_KEY;
    // Keep DOMAINS as the single authoritative source of domain names; do not map into ZONE/SUBDOMAIN/ADDITIONAL_DOMAINS
    // (legacy mappings removed for simplicity)

    // Merge HEALTHCHECKS + HEALTHCHECKS_DISABLED (UI gets merged value, _ENABLED shows which is active)
    // If HEALTHCHECKS exists and HEALTHCHECKS_ENABLED is not 'no', use HEALTHCHECKS
    // Otherwise use HEALTHCHECKS_DISABLED
    const hcEnabled = obj.HEALTHCHECKS_ENABLED === 'yes';
    const ukEnabled = obj.UPTIMEKUMA_ENABLED === 'yes';
    const srEnabled = obj.SHOUTRRR_ENABLED === 'yes';
    
    obj.HEALTHCHECKS = hcEnabled ? (obj.HEALTHCHECKS || '') : (obj.HEALTHCHECKS_DISABLED || '');
    obj.UPTIMEKUMA = ukEnabled ? (obj.UPTIMEKUMA || '') : (obj.UPTIMEKUMA_DISABLED || '');
    obj.SHOUTRRR = srEnabled ? (obj.SHOUTRRR || '') : (obj.SHOUTRRR_DISABLED || '');
    
    // Default _ENABLED to 'yes' if URL exists
    if (obj.HEALTHCHECKS_ENABLED === undefined && (obj.HEALTHCHECKS || obj.HEALTHCHECKS_DISABLED)) obj.HEALTHCHECKS_ENABLED = 'yes';
    if (obj.UPTIMEKUMA_ENABLED === undefined && (obj.UPTIMEKUMA || obj.UPTIMEKUMA_DISABLED)) obj.UPTIMEKUMA_ENABLED = 'yes';
    if (obj.SHOUTRRR_ENABLED === undefined && (obj.SHOUTRRR || obj.SHOUTRRR_DISABLED)) obj.SHOUTRRR_ENABLED = 'yes';
    
    res.json(obj);
});

// Helper: read full logs
function readLogs() {
    try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; }
}

// Helper: detect public IPv4/IPv6 from logs (favonia ddns output)
function detectPublicIPsFromLogs() {
    const logs = readLogs();
    const ipv4Match = logs.match(/Detected the IPv4 address\s+([0-9.]+)/i);
    const ipv6Match = logs.match(/Detected the IPv6 address\s+([0-9a-f:]+)/i);
    return { ipv4: ipv4Match ? ipv4Match[1] : null, ipv6: ipv6Match ? ipv6Match[1] : null };
}

// Helper: minimal Cloudflare API GET
function cfGet(pathname, token) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.cloudflare.com',
            path: `/client/v4${pathname}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}

// Helper: derive zone candidate from domain (last two labels)
function getZoneName(domain) {
    const parts = (domain || '').split('.');
    if (parts.length < 2) return domain;
    return parts.slice(-2).join('.');
}

// Endpoint: per-domain status by comparing Cloudflare DNS A/AAAA with detected public IPs
// Response: { domains: [ { domain, status, reason, ipv4Match, ipv6Match } ] }
app.get('/api/domain-status', async (req, res) => {
    try {
        const env = readEnv();
        const token = env.CLOUDFLARE_API_TOKEN || env.API_KEY || '';
        const domainsStr = env.DOMAINS || '';
        const parts = domainsStr.split(',').map(s => s.trim()).filter(Boolean);
        if (!parts.length) return res.json({ domains: [] });

        const detected = detectPublicIPsFromLogs();
        const results = [];
        if (!token) {
            for (const d of parts) results.push({ domain: d, status: 'missing', reason: 'Token missing', ipv4Match: false, ipv6Match: false });
            return res.json({ domains: results });
        }

        // For each domain: fetch zone id, then its DNS records
        for (const d of parts) {
            const zoneName = getZoneName(d);
            const zres = await cfGet(`/zones?name=${encodeURIComponent(zoneName)}`, token);
            if (!zres) {
                results.push({ domain: d, status: 'error', reason: 'Network error', ipv4Match: false, ipv6Match: false });
                continue;
            }
            if (zres.success === false) {
                // Treat auth failures as invalid token
                results.push({ domain: d, status: 'invalid', reason: 'Auth error', ipv4Match: false, ipv6Match: false });
                continue;
            }
            if (!zres.result || !zres.result.length) {
                // Could be wrong zone heuristic; classify as pending rather than hard error
                results.push({ domain: d, status: 'pending', reason: 'Zone not found', ipv4Match: false, ipv6Match: false });
                continue;
            }
            const zoneId = zres.result[0].id;
            const rres = await cfGet(`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(d)}`, token);
            const rres6 = await cfGet(`/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(d)}`, token);
            // Handle network/auth errors
            if (!rres || !rres6) {
                results.push({ domain: d, status: 'error', reason: 'Network error', ipv4Match: false, ipv6Match: false });
                continue;
            }
            if (rres.success === false || rres6.success === false) {
                results.push({ domain: d, status: 'invalid', reason: 'Auth error', ipv4Match: false, ipv6Match: false });
                continue;
            }
            const aRecords = (rres && rres.result) ? rres.result : [];
            const aaaaRecords = (rres6 && rres6.result) ? rres6.result : [];
            const currentA = aRecords.map(r => r.content).filter(Boolean);
            const currentAAAA = aaaaRecords.map(r => r.content).filter(Boolean);
            const v4Match = detected.ipv4 ? currentA.includes(detected.ipv4) : false;
            const v6Match = detected.ipv6 ? currentAAAA.includes(detected.ipv6) : false;
            // Derive status
            let status = 'pending'; let reason = '';
            if (v4Match || v6Match) { status = 'ok'; reason = 'Records match detected IPs'; }
            else { status = 'pending'; reason = 'Records differ from detected IPs'; }
            results.push({ domain: d, status, reason, ipv4Match: v4Match, ipv6Match: v6Match });
        }
        res.json({ domains: results });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/config', async (req, res) => {
    const { CLOUDFLARE_API_TOKEN, DOMAINS: DOMAINS_IN, PROXIED, IP4_PROVIDER, IP6_PROVIDER, HEALTHCHECKS, HEALTHCHECKS_ENABLED, UPTIMEKUMA, UPTIMEKUMA_ENABLED, SHOUTRRR, SHOUTRRR_ENABLED } = req.body;
    // Use DOMAINS as the single authoritative list
    const DOMAINS = (DOMAINS_IN || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
    const shout = (SHOUTRRR || '').split('\n').map(s => s.trim()).filter(Boolean).join(',');
    
    // New approach: Save URLs to HEALTHCHECKS or HEALTHCHECKS_DISABLED based on toggle
    // When toggle ON (HEALTHCHECKS_ENABLED='yes'): save to HEALTHCHECKS, clear HEALTHCHECKS_DISABLED
    // When toggle OFF (HEALTHCHECKS_ENABLED='no'): save to HEALTHCHECKS_DISABLED, clear HEALTHCHECKS
    const hc_enabled = HEALTHCHECKS_ENABLED === 'yes';
    const uk_enabled = UPTIMEKUMA_ENABLED === 'yes';
    const sr_enabled = SHOUTRRR_ENABLED === 'yes';
    
    const existing = readEnv();
    const token = (CLOUDFLARE_API_TOKEN === '***') ? existing.CLOUDFLARE_API_TOKEN : CLOUDFLARE_API_TOKEN;
    const lines = [
        `CLOUDFLARE_API_TOKEN=${token || ''}`,
        `DOMAINS=${DOMAINS}`,
        `PROXIED=${PROXIED || 'true'}`,
        `IP4_PROVIDER=${IP4_PROVIDER || ''}`,
        `IP6_PROVIDER=${IP6_PROVIDER || ''}`,
        // HEALTHCHECKS: save to active var, clear disabled var
        `HEALTHCHECKS=${hc_enabled ? (HEALTHCHECKS || '') : ''}`,
        `HEALTHCHECKS_DISABLED=${!hc_enabled ? (HEALTHCHECKS || '') : ''}`,
        `HEALTHCHECKS_ENABLED=${hc_enabled ? 'yes' : 'no'}`,
        // UPTIMEKUMA: save to active var, clear disabled var
        `UPTIMEKUMA=${uk_enabled ? (UPTIMEKUMA || '') : ''}`,
        `UPTIMEKUMA_DISABLED=${!uk_enabled ? (UPTIMEKUMA || '') : ''}`,
        `UPTIMEKUMA_ENABLED=${uk_enabled ? 'yes' : 'no'}`,
        // SHOUTRRR: save to active var, clear disabled var
        `SHOUTRRR=${sr_enabled ? shout : ''}`,
        `SHOUTRRR_DISABLED=${!sr_enabled ? shout : ''}`,
        `SHOUTRRR_ENABLED=${sr_enabled ? 'yes' : 'no'}`
    ];
    try {
        // Ensure directories exist before writing
        ensureDirs();

        // preserve `ENABLED` flag if present
        const existing = readEnv();
        if (existing.ENABLED !== undefined) {
            lines.push(`ENABLED=${existing.ENABLED}`);
        }

        console.log(`[POST /api/config] Writing ENV to: ${ENV_FILE}`);
        console.log(`[POST /api/config] ENV_FILE exists before write: ${fs.existsSync(ENV_FILE)}`);
        console.log(`[POST /api/config] DATA_DIR exists: ${fs.existsSync(DATA_DIR)}`);
        console.log(`[POST /api/config] DATA_DIR stats:`, fs.statSync(DATA_DIR));

        fs.writeFileSync(ENV_FILE, lines.join('\n'));

        console.log(`[POST /api/config] Write successful. ENV_FILE exists after write: ${fs.existsSync(ENV_FILE)}`);
        console.log(`[POST /api/config] ENV_FILE size: ${fs.statSync(ENV_FILE).size}`);

        appendLog(`Config updated via UI by ${req.headers['x-umbrel-username'] || 'local'}`);
        // Force immediate config reload by killing the running ddns child (if any)
        // The wrapper will detect the death and restart with new config
        try {
            const status = fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) : {};
            if (status.pid && status.running) {
                require('child_process').execSync(`kill -TERM ${status.pid} 2>/dev/null || true`);
                appendLog(`Stopped child process ${status.pid} to apply new config immediately`);
            }
        } catch (e) { /* ignore if kill fails */ }
        // Auto-start if token present; otherwise make sure the service stays disabled
        const savedEnv = readEnv();
        const hasToken = !!(savedEnv.CLOUDFLARE_API_TOKEN || savedEnv.API_KEY);
        if (hasToken) {
            // Write a marker to help wrapper know to ignore old errors before this point
            appendLog('──── NEW TOKEN CONFIGURED ────');
            setEnabled(true);
            appendLog('Service auto-enabled after saving config with API token');
        } else {
            setEnabled(false);
        }
        res.json({ success: true });
    } catch (e) {
        console.error(`[POST /api/config] ERROR: ${String(e)}`);
        console.error(`[POST /api/config] Stack:`, e.stack);
        appendLog(`Config update failed: ${String(e)}`);
        res.status(500).json({ error: String(e) });
    }
});

function appendLog(message) {
    const t = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `${t} ${message}\n`); } catch (e) { console.error('Failed to append log', e); }
}

function readEnv() {
    if (!fs.existsSync(ENV_FILE)) return {};
    try {
        const content = fs.readFileSync(ENV_FILE, 'utf8');
        const obj = {};
        content.split('\n').filter(Boolean).forEach(line => {
            const [k, v] = line.split('=');
            obj[k] = (v === 'undefined' || v === 'null') ? '' : v;
        });
        if (obj.API_KEY && !obj.CLOUDFLARE_API_TOKEN) obj.CLOUDFLARE_API_TOKEN = obj.API_KEY;
        return obj;
    } catch (e) { return {}; }
}

function writeEnv(obj) {
    const lines = Object.keys(obj).map(k => `${k}=${obj[k] !== undefined && obj[k] !== null ? obj[k] : ''}`);
    fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

function setEnabled(value) {
    const env = readEnv();
    env.ENABLED = value ? 'true' : 'false';
    writeEnv(env);
}

app.get('/api/service/status', (req, res) => {
    try {
        if (fs.existsSync(STATUS_FILE)) {
            const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            return res.json({ status: s.status || (s.enabled ? 'running' : 'stopped'), running: !!s.running, enabled: !!s.enabled, pid: s.pid || null, lastStartedAt: s.lastStartedAt || null, lastSuccessfulUpdate: s.lastSuccessfulUpdate || null, error: s.error || null });
        }
        const env = readEnv();
        const enabled = env.ENABLED === 'true';
        // heuristically determine running if log file updated in last 5 minutes
        let running = false;
        let error = null;
        if (fs.existsSync(LOG_FILE)) {
            const stat = fs.statSync(LOG_FILE);
            const age = (Date.now() - stat.mtimeMs) / 1000;
            running = enabled && (age < 300);
            // Check for API token errors in recent logs
            const logs = fs.readFileSync(LOG_FILE, 'utf8');
            const lines = logs.split(/\r?\n/).filter(Boolean);
            // Check last 50 lines for token/auth errors
            const recentLines = lines.slice(-50);
            for (const line of recentLines) {
                if (/Cloudflare API token.*error|auth error|authentication.*failed|401.*unauthorized|403.*forbidden/gi.test(line)) {
                    error = 'Invalid Cloudflare API token';
                    break;
                }
            }
        }
        res.json({ status: enabled ? 'enabled' : 'disabled', running, enabled, lastSuccessfulUpdate: null, error });
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/logs', (req, res) => {
    try { res.send(fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''); } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Try to detect a local Uptime Kuma instance on common addresses
app.get('/api/discover/uptimekuma', async (req, res) => {
    const hosts = ['http://host.docker.internal:8385', 'http://umbrel.local:8385', 'http://localhost:8385', 'http://172.17.0.1:8385'];
    const http = require('http');
    const tryFetch = (url) => new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        http.get(url, (r) => {
            let data = '';
            r.on('data', (chunk) => data += chunk);
            r.on('end', () => {
                clearTimeout(timeout);
                if (data && data.toLowerCase().includes('uptime kuma')) resolve(url);
                else resolve(null);
            });
        }).on('error', () => { clearTimeout(timeout); resolve(null); });
    });
    for (const h of hosts) {
        try {
            const found = await tryFetch(h);
            if (found) return res.json({ available: true, url: found });
        } catch (e) { }
    }
    res.json({ available: false });
});

function findLastUpdateLine(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        // Only match lines that indicate a successful *change* to DNS records
        // Exclude: config updates, service starts, and "already up to date" checks
        if (!/Config updated|UI started|Service (auto-)?enabled|Service (auto-)?disabled|already up to date|unchanged|no change/gi.test(l) &&
            /a records.*were|updated.*record|record.*updated|set the ip|successfully updated|update successful|were updated/gi.test(l)) {
            return l;
        }
    }
    return null;
}

function extractTimestampFromLine(line) {
    if (!line) return null;
    // look for ISO8601 timestamp
    const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
    if (iso) return new Date(iso[0]);
    // fallback: look for local date e.g., 2025-12-13 09:12
    const dt = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/);
    if (dt) return new Date(dt[0]);
    return null;
}

app.get('/api/last-update', (req, res) => {
    try {
        // Prefer a persisted lastSuccessfulUpdate from the status file
        if (fs.existsSync(STATUS_FILE)) {
            const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            if (s.lastSuccessfulUpdate) return res.json({ lastUpdate: s.lastSuccessfulUpdate });
        }
        if (!fs.existsSync(LOG_FILE)) return res.json({ lastUpdate: null });
        const txt = fs.readFileSync(LOG_FILE, 'utf8');
        const lastLine = findLastUpdateLine(txt);
        if (!lastLine) return res.json({ lastUpdate: null });
        const ts = extractTimestampFromLine(lastLine);
        if (!ts) return res.json({ lastUpdate: null });
        res.json({ lastUpdate: ts.toISOString() });
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Return last detected public IPs (IPv4 + IPv6) by scanning the logs
app.get('/api/public-ip', (req, res) => {
    try {
        if (!fs.existsSync(LOG_FILE)) return res.json({ ipv4: null, ipv6: null });
        const txt = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = txt.split(/\r?\n/).filter(Boolean);
        let lastIpv4 = null;
        let lastIpv6 = null;
        // Lines contain phrases like: "Detected the IPv4 address 81.153.46.239"
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i];
            const v4 = l.match(/IPv4 address ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i) || l.match(/Detected the IPv4 address ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i);
            if (v4 && !lastIpv4) lastIpv4 = v4[1];
            const v6 = l.match(/IPv6 address ([0-9a-f:]+)/i) || l.match(/Detected the IPv6 address ([0-9a-f:]+)/i);
            if (v6 && !lastIpv6) lastIpv6 = v6[1];
            if (lastIpv4 && lastIpv6) break;
        }
        res.json({ ipv4: lastIpv4, ipv6: lastIpv6 });
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/errors', (req, res) => {
    try {
        if (!fs.existsSync(LOG_FILE)) return res.json({ errors: [] });
        const txt = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = txt.split(/\r?\n/).filter(Boolean);
        const errMatches = lines.filter(l => /error|failed|403|401|denied|timeout|exception/gi.test(l));
        res.json({ errors: errMatches.slice(-20) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/service/start', (req, res) => {
    try {
        const env = readEnv();
        const token = env.CLOUDFLARE_API_TOKEN || env.API_KEY || '';
        const domains = env.DOMAINS || '';
        if (!token) return res.status(400).json({ error: 'Missing Cloudflare API token (CLOUDFLARE_API_TOKEN)' });
        if (!domains) return res.status(400).json({ error: 'Missing domain configuration; specify DOMAINS' });
        setEnabled(true);
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

io.on('connection', (socket) => {
    // send last log lines
    try {
        if (fs.existsSync(LOG_FILE)) {
            const tail = fs.readFileSync(LOG_FILE, 'utf8');
            socket.emit('log', tail);
        }
    } catch (e) { }

    // stream log-file updates
    if (fs.existsSync(LOG_FILE)) {
        const watcher = fs.watch(LOG_FILE, () => {
            try {
                const tail = fs.readFileSync(LOG_FILE, 'utf8');
                socket.emit('log', tail);
            } catch (e) { }
        });
        socket.on('disconnect', () => { watcher.close(); });
    }

    // Docker log streaming has been removed; we stream logs from the host log file only.

});

const port = 3000;
server.listen(port, () => { console.log(`UI listening on ${port}`); appendLog('UI started'); });
