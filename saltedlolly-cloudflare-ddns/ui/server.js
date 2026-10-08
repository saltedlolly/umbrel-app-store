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
const LAST_CHANGE_FILE = path.join(DATA_DIR, 'last-change.json');
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
    // New install (no settings file yet): IPv6 starts off
    if (!fs.existsSync(ENV_FILE)) return res.json({ IP6_PROVIDER: 'none' });
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const obj = {};
    content.split('\n').filter(Boolean).forEach(line => {
        // Split on the FIRST "=" only to avoid truncating values that contain
        // "=" characters (e.g. Uptime Kuma URLs with query strings like
        // "?status=up&msg=OK&ping="). Must match the logic in readEnv() below.
        const eq = line.indexOf('=');
        if (eq === -1) return;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
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

// Helper: last n lines of the log. The log can grow to megabytes; sending
// and rendering all of it on every write made the UI sluggish (worst on
// phones), so the live log view only gets the tail.
const LOG_TAIL_LINES = 500;
function readLogTail(n) {
    const logs = readLogs();
    const lines = logs.split('\n');
    return lines.length > n ? lines.slice(-n).join('\n') : logs;
}

// Helper: detect public IPv4/IPv6 from logs (favonia ddns output)
function detectPublicIPsFromLogs() {
    const logs = readLogs();
    const lines = logs.split(/\r?\n/);
    let ipv4 = null;
    let ipv6 = null;
    // Scan from newest to oldest so we pick up the most recently detected IP,
    // not the first one ever logged (the log file can span weeks).
    for (let i = lines.length - 1; i >= 0 && (!ipv4 || !ipv6); i--) {
        const l = lines[i];
        if (!ipv4) {
            // "the" and the colon after "address" are both optional - current
            // favonia/cloudflare-ddns versions log "Detected IPv4 address: X"
            // (no "the", with a colon); older versions logged "Detected the
            // IPv4 address X". The stricter, "the"-requiring pattern this used
            // to be never matched current log output at all.
            const v4 = l.match(/Detected (?:the )?IPv4 address:?\s+([0-9.]+)/i);
            if (v4) ipv4 = v4[1];
        }
        if (!ipv6) {
            const v6 = l.match(/Detected (?:the )?IPv6 address:?\s+([0-9a-f:]+)/i);
            if (v6) ipv6 = v6[1];
        }
    }
    return { ipv4, ipv6 };
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

// Helper: the zones (domains) the token can see. Used to find each domain's
// zone by longest matching suffix; guessing "the last two labels" gave
// "co.uk" for example.co.uk, so such domains never showed a status.
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
            for (const d of parts) results.push({ domain: d, status: 'missing', reason: 'Token missing', ipv4Match: false, ipv6Match: false, ipv4Proxied: null, ipv6Proxied: null });
            return res.json({ domains: results });
        }

        // The zones the token can see, then for each domain its zone and records
        const zl = await listZones(token);
        const none = { ipv4Match: false, ipv6Match: false, ipv4Proxied: null, ipv6Proxied: null };
        if (!zl || zl.authError) {
            for (const d of parts) results.push(Object.assign({ domain: d }, none, zl ? { status: 'invalid', reason: 'Auth error' } : { status: 'error', reason: 'Network error' }));
            return res.json({ domains: results });
        }
        for (const d of parts) {
            const zone = findZone(zl.zones, d);
            if (!zone) {
                results.push(Object.assign({ domain: d, status: 'pending', reason: 'Zone not found' }, none));
                continue;
            }
            const zoneId = zone.id;
            const rres = await cfGet(`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(d)}`, token);
            const rres6 = await cfGet(`/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(d)}`, token);
            // Handle network/auth errors
            if (!rres || !rres6) {
                results.push({ domain: d, status: 'error', reason: 'Network error', ipv4Match: false, ipv6Match: false, ipv4Proxied: null, ipv6Proxied: null });
                continue;
            }
            if (rres.success === false || rres6.success === false) {
                results.push({ domain: d, status: 'invalid', reason: 'Auth error', ipv4Match: false, ipv6Match: false, ipv4Proxied: null, ipv6Proxied: null });
                continue;
            }
            const aRecords = (rres && rres.result) ? rres.result : [];
            const aaaaRecords = (rres6 && rres6.result) ? rres6.result : [];
            const currentA = aRecords.map(r => r.content).filter(Boolean);
            const currentAAAA = aaaaRecords.map(r => r.content).filter(Boolean);
            const v4Match = detected.ipv4 ? currentA.includes(detected.ipv4) : false;
            const v6Match = detected.ipv6 ? currentAAAA.includes(detected.ipv6) : false;

            // Get current proxied status from Cloudflare records
            const ipv4Proxied = aRecords.length > 0 ? aRecords[0].proxied : null;
            const ipv6Proxied = aaaaRecords.length > 0 ? aaaaRecords[0].proxied : null;

            // Derive status
            let status = 'pending'; let reason = '';
            if (v4Match || v6Match) { status = 'ok'; reason = 'Records match detected IPs'; }
            else { status = 'pending'; reason = 'Records differ from detected IPs'; }
            results.push({ domain: d, status, reason, ipv4Match: v4Match, ipv6Match: v6Match, ipv4Proxied, ipv6Proxied });
        }
        res.json({ domains: results });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/config', async (req, res) => {
    const existing = readEnv();
    const body = req.body || {};

    // True partial-merge semantics: a field the client's request body
    // doesn't mention at all keeps its existing stored value, rather than
    // being silently cleared to empty. Several independent parts of the UI
    // (each notifier's own on/off switch, the notifiers "Save" button, the
    // main config form) each do their own "read current config, tweak one
    // thing, POST" round trip - if two of those overlap (e.g. a switch
    // toggled right before clicking Save), the request whose read
    // happened to land first would silently wipe out whatever the other
    // had already saved, because every field not in ITS payload used to
    // default to empty rather than to what was actually stored. Confirmed
    // as the cause of a real incident: toggling the Uptime Kuma switch and
    // clicking Save in quick succession lost the just-pasted push URL.
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const pick = (key, fallback) => (has(key) ? body[key] : fallback);

    const CLOUDFLARE_API_TOKEN = pick('CLOUDFLARE_API_TOKEN', existing.CLOUDFLARE_API_TOKEN);
    const DOMAINS_IN = pick('DOMAINS', existing.DOMAINS);
    const PROXIED = pick('PROXIED', existing.PROXIED);
    const IP4_PROVIDER = pick('IP4_PROVIDER', existing.IP4_PROVIDER);
    // No settings file yet means a new install, where IPv6 starts off (the
    // wrapper writes the same default when it starts)
    const IP6_PROVIDER = pick('IP6_PROVIDER', fs.existsSync(ENV_FILE) ? existing.IP6_PROVIDER : 'none');
    // The URL itself can be sitting in either the active or the _DISABLED
    // slot depending on current toggle state - fall back to whichever one
    // actually has it when the client didn't send this field at all.
    const HEALTHCHECKS = pick('HEALTHCHECKS', existing.HEALTHCHECKS || existing.HEALTHCHECKS_DISABLED);
    const HEALTHCHECKS_ENABLED = pick('HEALTHCHECKS_ENABLED', existing.HEALTHCHECKS_ENABLED);
    const UPTIMEKUMA = pick('UPTIMEKUMA', existing.UPTIMEKUMA || existing.UPTIMEKUMA_DISABLED);
    const UPTIMEKUMA_ENABLED = pick('UPTIMEKUMA_ENABLED', existing.UPTIMEKUMA_ENABLED);
    const SHOUTRRR = pick('SHOUTRRR', existing.SHOUTRRR || existing.SHOUTRRR_DISABLED);
    const SHOUTRRR_ENABLED = pick('SHOUTRRR_ENABLED', existing.SHOUTRRR_ENABLED);

    // Validate notifier URLs and collect warnings (don't block save, just warn)
    const warnings = [];
    const localHostPatterns = /^https:\/\/(localhost|127\.0\.0\.1|umbrel\.local|::1)(:|\/)/i;
    if (UPTIMEKUMA && localHostPatterns.test(UPTIMEKUMA)) {
        warnings.push('Uptime Kuma URL uses HTTPS with a local hostname (localhost/umbrel.local), which may fail due to self-signed certificate validation. Consider using HTTP instead (e.g., http://localhost:8385/...)');
    }
    if (HEALTHCHECKS && localHostPatterns.test(HEALTHCHECKS)) {
        warnings.push('Healthchecks URL uses HTTPS with a local hostname, which may fail due to self-signed certificate validation. Consider using HTTP instead.');
    }
    // SHOUTRRR can be comma-separated, check each
    if (SHOUTRRR) {
        const shoutUrls = SHOUTRRR.split(',').map(s => s.trim()).filter(Boolean);
        for (const url of shoutUrls) {
            if (localHostPatterns.test(url)) {
                warnings.push('Shoutrrr URL uses HTTPS with a local hostname, which may fail due to self-signed certificate validation. Consider using HTTP instead.');
                break; // Only warn once
            }
        }
    }

    // Use DOMAINS as the single authoritative list
    const DOMAINS = (DOMAINS_IN || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
    const shout = (SHOUTRRR || '').split('\n').map(s => s.trim()).filter(Boolean).join(',');

    // New approach: Save URLs to HEALTHCHECKS or HEALTHCHECKS_DISABLED based on toggle
    // When toggle ON (HEALTHCHECKS_ENABLED='yes'): save to HEALTHCHECKS, clear HEALTHCHECKS_DISABLED
    // When toggle OFF (HEALTHCHECKS_ENABLED='no'): save to HEALTHCHECKS_DISABLED, clear HEALTHCHECKS
    const hc_enabled = HEALTHCHECKS_ENABLED === 'yes';
    const uk_enabled = UPTIMEKUMA_ENABLED === 'yes';
    const sr_enabled = SHOUTRRR_ENABLED === 'yes';

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
        // No need to signal the ddns child: the wrapper polls the env file
        // every 3 s and restarts the child itself when it changes. (This used
        // to `kill` status.pid, but that pid belongs to the other container's
        // PID namespace, so the kill either hit nothing or, when the numbers
        // happened to match, killed this UI's own process.)
        // Auto-start if token present; otherwise make sure the service stays disabled
        const savedEnv = readEnv();
        const hasToken = !!(savedEnv.CLOUDFLARE_API_TOKEN || savedEnv.API_KEY);
        if (hasToken) {
            // The wrapper's own error-scanning treats this exact marker as
            // "ignore any auth errors logged before this point" - only
            // write it when the token genuinely changed value, not on
            // every unrelated config save (e.g. adding a notifier URL),
            // which used to claim "NEW TOKEN CONFIGURED" even though
            // nothing about the token had changed at all.
            if (token !== existing.CLOUDFLARE_API_TOKEN) {
                appendLog('──── NEW TOKEN CONFIGURED ────');
            }
            setEnabled(true);
            appendLog('Service auto-enabled after saving config with API token');
        } else {
            setEnabled(false);
        }
        // Log warnings to help users diagnose issues
        if (warnings.length > 0) {
            warnings.forEach(w => appendLog(`CONFIG WARNING: ${w}`));
        }
        res.json({ success: true, warnings: warnings.length > 0 ? warnings : undefined });
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
            // Split on the FIRST "=" only - a value containing further "="
            // characters (e.g. an Uptime Kuma push URL's own query string,
            // `?status=up&msg=OK&ping=`) would otherwise be silently
            // truncated right after the second "=" in the line, since
            // line.split('=') with no limit returns every piece and only
            // the first two survive being destructured into k/v.
            const eq = line.indexOf('=');
            if (eq === -1) return;
            const k = line.slice(0, eq);
            const v = line.slice(eq + 1);
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
    try {
        if (!fs.existsSync(LOG_FILE)) return res.send('');
        // ?tail=N returns only the last N lines; without it, the full file
        const tail = parseInt(req.query.tail, 10);
        res.send(tail > 0 ? readLogTail(tail) : fs.readFileSync(LOG_FILE, 'utf8'));
    } catch (e) { res.status(500).json({ error: String(e) }); }
});


// "Cloudflare Last Updated": the last GENUINE record change per family, as
// recorded by the wrapper in last-change.json on the data volume (so it
// survives restarts and upgrades). null means no change has been made since
// that file started being kept; the UI then shows "Already up to date" once
// lastSuccessfulCheck shows the records were confirmed. (This used to scan
// the log, but favonia's log lines have no timestamps, so it always fell
// back to the time of the first check after startup.)
app.get('/api/last-update', (req, res) => {
    try {
        let ipv4Update = null;
        let ipv6Update = null;
        let lastSuccessfulCheck = null;
        try {
            const c = JSON.parse(fs.readFileSync(LAST_CHANGE_FILE, 'utf8'));
            ipv4Update = c.ipv4 || null;
            ipv6Update = c.ipv6 || null;
        } catch (e) { /* no change recorded yet */ }
        try {
            const st = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            lastSuccessfulCheck = st.lastSuccessfulCheck || null;
        } catch (e) { /* no status yet */ }
        const lastUpdate = [ipv4Update, ipv6Update].filter(Boolean).sort().reverse()[0] || null;
        res.json({ lastUpdate, ipv4Update, ipv6Update, lastSuccessfulCheck });
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
        // "the" and the colon after "address" are both optional - see the
        // matching comment in detectPublicIPsFromLogs() above for why.
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i];
            const v4 = l.match(/Detected (?:the )?IPv4 address:?\s+([0-9.]+)/i);
            if (v4 && !lastIpv4) lastIpv4 = v4[1];
            const v6 = l.match(/Detected (?:the )?IPv6 address:?\s+([0-9a-f:]+)/i);
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
            socket.emit('log', readLogTail(LOG_TAIL_LINES));
        }
    } catch (e) { }

    // stream log-file updates
    if (fs.existsSync(LOG_FILE)) {
        const watcher = fs.watch(LOG_FILE, () => {
            try {
                socket.emit('log', readLogTail(LOG_TAIL_LINES));
            } catch (e) { }
        });
        socket.on('disconnect', () => { watcher.close(); });
    }

    // Docker log streaming has been removed; we stream logs from the host log file only.

});

const port = 3000;
server.listen(port, () => { console.log(`UI listening on ${port}`); appendLog('UI started'); });
