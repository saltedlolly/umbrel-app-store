const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = 8080;

const CONFIG_DIR = process.env.CONFIG_DIR || '/data/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'npm-settings.env');

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

        res.json({
            crowdsec: {
                detected: crowdsecDetected,
                enabled: crowdsecEnabled,
                metrics: crowdsecEnabled ? {
                    blocked: 0,  // TODO: Fetch from CrowdSec API
                    bans: 0,     // TODO: Fetch from CrowdSec API
                    lastSync: 'Just now'
                } : null
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
