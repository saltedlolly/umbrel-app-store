const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = 8080;

const CONFIG_DIR = process.env.CONFIG_DIR || '/data/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'npm-settings.env');

// Integration state written by the npmplus wrapper at startup (read-only here)
const STATUS_DIR = process.env.STATUS_DIR || '/data/status';
const CROWDSEC_STATUS_FILE = path.join(STATUS_DIR, 'crowdsec.env');
const CROWDSEC_BOUNCER_KEY = process.env.CROWDSEC_BOUNCER_KEY || '';

// Integration endpoints
const CROWDSEC_LAPI = 'host.docker.internal:8080';
const CROWDSEC_APPSEC = 'host.docker.internal:7422';
const AUTHENTIK_URL = 'host.docker.internal:9000';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Ensure config directory exists
function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
}

// Helper: Check if a service is available via HTTP
function checkServiceAvailable(host, port, path = '/health', timeout = 3000) {
    return new Promise((resolve) => {
        const req = http.request({
            host: host.split(':')[0],
            port: port || host.split(':')[1],
            path: path,
            method: 'GET',
            timeout: timeout
        }, (res) => {
            resolve(res.statusCode >= 200 && res.statusCode < 300);
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });

        req.end();
    });
}

// Read the CrowdSec bouncer state the npmplus wrapper published at startup.
// Returns null if the wrapper hasn't written it (older wrapper, first start).
function readCrowdSecStatus() {
    try {
        const status = {};
        for (const line of fs.readFileSync(CROWDSEC_STATUS_FILE, 'utf8').split('\n')) {
            const match = line.match(/^([A-Z_]+)=(.*)$/);
            if (match) status[match[1]] = match[2];
        }
        return {
            bouncerEnabled: status.BOUNCER_ENABLED === 'true',
            mode: status.MODE || 'auto',
            lapiUrl: status.LAPI_URL || '',
            appsecEnabled: status.APPSEC_ENABLED === 'true',
            logSharing: status.LOG_SHARING === 'true',
            updatedAt: status.UPDATED_AT || null
        };
    } catch {
        return null;
    }
}

// Count active LAPI decisions with the bouncer key. The community blocklist
// can hold thousands of entries, so cache the result rather than fetching
// on every 30s poll.
const DECISIONS_CACHE_MS = 5 * 60 * 1000;
let decisionsCache = { at: 0, value: null };

function fetchCrowdSecDecisions(lapiUrl) {
    if (!CROWDSEC_BOUNCER_KEY) return Promise.resolve(null);
    if (decisionsCache.value && Date.now() - decisionsCache.at < DECISIONS_CACHE_MS) {
        return Promise.resolve(decisionsCache.value);
    }

    return new Promise((resolve) => {
        const req = http.get(`${lapiUrl}/v1/decisions`, {
            headers: { 'X-Api-Key': CROWDSEC_BOUNCER_KEY },
            timeout: 5000
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                try {
                    // LAPI returns null (not []) when there are no decisions
                    const decisions = JSON.parse(body) || [];
                    const community = decisions.filter(d => d.origin === 'CAPI' || d.origin === 'lists').length;
                    const value = {
                        total: decisions.length,
                        local: decisions.length - community,
                        community,
                        checkedAt: new Date().toISOString()
                    };
                    decisionsCache = { at: Date.now(), value };
                    resolve(value);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Work out what the CrowdSec card should say, from what's reachable now
// (detected), what the wrapper actually configured at startup (status) and
// what the user has asked for (configured mode).
function crowdSecState(detected, status, configuredMode) {
    if (!detected) {
        return status && status.bouncerEnabled ? 'unreachable' : 'not-detected';
    }
    if (!status) return 'available';
    if (status.bouncerEnabled) return 'connected';
    if (configuredMode === 'false') return 'disabled';
    return 'restart-needed';
}

// Read configuration from file
function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return {
            PROXY_MODE: 'none',
            TRUST_CLOUDFLARE: 'false',
            TRUST_IP: '',
            CROWDSEC_ENABLED: 'auto',
            CROWDSEC_LAPI_URL: `http://${CROWDSEC_LAPI}`,
            CROWDSEC_APPSEC_URL: `http://${CROWDSEC_APPSEC}`,
            AUTHENTIK_ENABLED: 'auto',
            AUTHENTIK_URL: `http://${AUTHENTIK_URL}`,
            CONFIG_VERSION: '2'
        };
    }

    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = {};

    content.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;

        const eq = line.indexOf('=');
        if (eq === -1) return;

        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        config[key] = value;
    });

    // Set defaults for new config values
    if (!config.CONFIG_VERSION || config.CONFIG_VERSION === '1') {
        config.CROWDSEC_ENABLED = config.CROWDSEC_ENABLED || 'auto';
        config.CROWDSEC_LAPI_URL = config.CROWDSEC_LAPI_URL || `http://${CROWDSEC_LAPI}`;
        config.CROWDSEC_APPSEC_URL = config.CROWDSEC_APPSEC_URL || `http://${CROWDSEC_APPSEC}`;
        config.AUTHENTIK_ENABLED = config.AUTHENTIK_ENABLED || 'auto';
        config.AUTHENTIK_URL = config.AUTHENTIK_URL || `http://${AUTHENTIK_URL}`;
        config.CONFIG_VERSION = '2';
    }

    return config;
}

// Write configuration to file
function writeConfig(config) {
    try {
        console.log(`[writeConfig] Starting write to ${CONFIG_FILE}`);
        console.log(`[writeConfig] CONFIG_DIR=${CONFIG_DIR}`);

        ensureConfigDir();
        console.log(`[writeConfig] Config directory verified`);

        const timestamp = new Date().toISOString();
        const content = `# NPMplus Configuration
# Managed by NPMplus for Umbrel Configuration UI
# Last updated: ${timestamp}

# ============================================================
# Trusted Proxy Configuration
# ============================================================
# Proxy Mode: none, cloudflare, custom
PROXY_MODE=${config.PROXY_MODE || 'none'}

# Cloudflare Proxy (auto-configured when PROXY_MODE=cloudflare)
TRUST_CLOUDFLARE=${config.TRUST_CLOUDFLARE || 'false'}

# Custom Trusted IPs (used when PROXY_MODE=custom)
# Space-separated list of IP ranges
TRUST_IP=${config.TRUST_IP || ''}

# ============================================================
# CrowdSec Integration
# ============================================================
# CrowdSec Enabled: auto (detect and enable), true (force enable), false (disable)
CROWDSEC_ENABLED=${config.CROWDSEC_ENABLED || 'auto'}

# CrowdSec LAPI URL (Local API for bouncer decisions)
CROWDSEC_LAPI_URL=${config.CROWDSEC_LAPI_URL || `http://${CROWDSEC_LAPI}`}

# CrowdSec AppSec URL (Application Security Component / WAF)
CROWDSEC_APPSEC_URL=${config.CROWDSEC_APPSEC_URL || `http://${CROWDSEC_APPSEC}`}

# ============================================================
# Authentik Integration
# ============================================================
# Authentik Enabled: auto (detect and enable), true (force enable), false (disable)
AUTHENTIK_ENABLED=${config.AUTHENTIK_ENABLED || 'auto'}

# Authentik URL
AUTHENTIK_URL=${config.AUTHENTIK_URL || `http://${AUTHENTIK_URL}`}

# ============================================================
# Configuration Version
# ============================================================
CONFIG_VERSION=${config.CONFIG_VERSION || '2'}
`;

        console.log(`[writeConfig] Writing ${content.length} bytes to ${CONFIG_FILE}`);
        fs.writeFileSync(CONFIG_FILE, content);
        console.log(`[writeConfig] Write successful`);

        // Verify the file was written
        const stats = fs.statSync(CONFIG_FILE);
        console.log(`[writeConfig] File size: ${stats.size} bytes, owner: ${stats.uid}:${stats.gid}`);
    } catch (error) {
        console.error(`[writeConfig] ERROR: ${error.message}`);
        console.error(`[writeConfig] Error details:`, error);
        throw error;
    }
}

// API: Get integrations status
app.get('/api/integrations/status', async (req, res) => {
    try {
        const config = readConfig();

        // Check if CrowdSec is available
        const crowdsecDetected = await checkServiceAvailable('host.docker.internal', 8080, '/health', 2000);

        // Check if Authentik is available
        const authentikDetected = await checkServiceAvailable('host.docker.internal', 9000, '/application/o/npmplus/.well-known/openid-configuration', 2000);

        // Determine effective enabled state
        const crowdsecEnabled = config.CROWDSEC_ENABLED === 'auto'
            ? crowdsecDetected
            : config.CROWDSEC_ENABLED === 'true';

        const authentikEnabled = config.AUTHENTIK_ENABLED === 'auto'
            ? authentikDetected
            : config.AUTHENTIK_ENABLED === 'true';

        const crowdsecStatus = readCrowdSecStatus();
        const crowdsecConfiguredMode = config.CROWDSEC_ENABLED || 'auto';
        const crowdsecState = crowdSecState(crowdsecDetected, crowdsecStatus, crowdsecConfiguredMode);
        const crowdsecDecisions = crowdsecState === 'connected'
            ? await fetchCrowdSecDecisions(crowdsecStatus.lapiUrl || `http://${CROWDSEC_LAPI}`)
            : null;

        res.json({
            crowdsec: {
                detected: crowdsecDetected,
                enabled: crowdsecEnabled,
                state: crowdsecState,
                // Settings saved since NPMplus started only apply after a restart
                pendingRestart: !!crowdsecStatus && crowdsecStatus.mode !== crowdsecConfiguredMode,
                appsecEnabled: !!crowdsecStatus && crowdsecStatus.appsecEnabled,
                logSharing: !!crowdsecStatus && crowdsecStatus.logSharing,
                connectedSince: crowdsecState === 'connected' ? crowdsecStatus.updatedAt : null,
                decisions: crowdsecDecisions
            },
            authentik: {
                detected: authentikDetected,
                enabled: authentikEnabled,
                metrics: authentikEnabled ? {
                    hosts: 0,    // TODO: Fetch from Authentik API
                    sessions: 0, // TODO: Fetch from Authentik API
                    lastSync: 'Just now'
                } : null
            }
        });
    } catch (error) {
        console.error('Error checking integrations status:', error);
        res.status(500).json({ error: 'Failed to check integrations status' });
    }
});

// API: Save integrations configuration
app.post('/api/integrations', (req, res) => {
    try {
        const { crowdsec, authentik } = req.body;

        // Read current config to preserve other settings
        const config = readConfig();

        // Update CrowdSec settings if provided
        if (crowdsec !== undefined) {
            config.CROWDSEC_ENABLED = crowdsec.enabled ? 'true' : 'false';
        }

        // Update Authentik settings if provided
        if (authentik !== undefined) {
            config.AUTHENTIK_ENABLED = authentik.enabled ? 'true' : 'false';
        }

        writeConfig(config);

        console.log(`Integration settings saved: CrowdSec=${config.CROWDSEC_ENABLED}, Authentik=${config.AUTHENTIK_ENABLED}`);

        res.json({
            success: true,
            requiresRestart: true,
            message: 'Integration settings saved successfully.'
        });
    } catch (error) {
        console.error('Error saving integration settings:', error);
        res.status(500).json({ error: 'Failed to save integration settings' });
    }
});

// API: Get current configuration
// API: App version (baked into the image by npmplus-build.sh)
app.get('/api/version', (req, res) => {
    res.json({ version: process.env.APP_VERSION || 'dev' });
});

app.get('/api/config', (req, res) => {
    try {
        const config = readConfig();
        res.json({
            proxyMode: config.PROXY_MODE || 'none',
            trustCloudflare: config.TRUST_CLOUDFLARE === 'true',
            trustIp: config.TRUST_IP || ''
        });
    } catch (error) {
        console.error('Error reading config:', error);
        res.status(500).json({ error: 'Failed to read configuration' });
    }
});

// API: Save configuration
app.post('/api/config', (req, res) => {
    try {
        const { proxyMode, trustIp } = req.body;

        // Validate proxy mode
        if (!['none', 'cloudflare', 'custom'].includes(proxyMode)) {
            return res.status(400).json({ error: 'Invalid proxy mode' });
        }

        // Validate custom mode has trustIp
        if (proxyMode === 'custom' && (!trustIp || !trustIp.trim())) {
            return res.status(400).json({ error: 'Custom proxy mode requires trusted IP addresses' });
        }

        const config = {
            PROXY_MODE: proxyMode,
            TRUST_CLOUDFLARE: proxyMode === 'cloudflare' ? 'true' : 'false',
            TRUST_IP: proxyMode === 'custom' ? (trustIp || '').trim() : '',
            CONFIG_VERSION: '1'
        };

        writeConfig(config);

        console.log(`Configuration saved: PROXY_MODE=${proxyMode}, TRUST_IP=${config.TRUST_IP || '(none)'}`);

        res.json({
            success: true,
            requiresRestart: true,
            message: 'Settings saved successfully. Restart the NPMplus app for changes to take effect.'
        });
    } catch (error) {
        console.error('Error saving config:', error);
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.sendStatus(200);
});

// Start server
app.listen(PORT, () => {
    console.log(`NPMplus Configuration UI listening on port ${PORT}`);
    ensureConfigDir();
});
