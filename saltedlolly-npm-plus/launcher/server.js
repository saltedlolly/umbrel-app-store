const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 8080;

const CONFIG_DIR = process.env.CONFIG_DIR || '/data/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'npm-settings.env');

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Ensure config directory exists
function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
}

// Read configuration from file
function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return {
            PROXY_MODE: 'none',
            TRUST_CLOUDFLARE: 'false',
            TRUST_IP: '',
            CONFIG_VERSION: '1'
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
        const content = `# NPMplus Trusted Proxy Configuration
# Managed by NPMplus for Umbrel Configuration UI
# Last updated: ${timestamp}

# Trusted Proxy Mode
# Options: none, cloudflare, custom
PROXY_MODE=${config.PROXY_MODE || 'none'}

# Cloudflare Proxy (auto-configured when PROXY_MODE=cloudflare)
TRUST_CLOUDFLARE=${config.TRUST_CLOUDFLARE || 'false'}

# Custom Trusted IPs (used when PROXY_MODE=custom)
# Space-separated list of IP ranges
TRUST_IP=${config.TRUST_IP || ''}

# Version (for migration tracking)
CONFIG_VERSION=${config.CONFIG_VERSION || '1'}
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
        const { proxyMode } = req.body;

        // Validate proxy mode
        if (!['none', 'cloudflare', 'custom'].includes(proxyMode)) {
            return res.status(400).json({ error: 'Invalid proxy mode' });
        }

        const config = {
            PROXY_MODE: proxyMode,
            TRUST_CLOUDFLARE: proxyMode === 'cloudflare' ? 'true' : 'false',
            TRUST_IP: '', // For future use
            CONFIG_VERSION: '1'
        };

        writeConfig(config);

        console.log(`Configuration saved: PROXY_MODE=${proxyMode}`);

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
