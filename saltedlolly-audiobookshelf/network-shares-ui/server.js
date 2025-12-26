const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = 3001;
const DATA_DIR = process.env.APP_DATA_DIR || '/data';
const CONFIG_FILE = '/data/network-shares.json';
const NETWORK_MOUNT_ROOT = '/umbrel-network';
const AUDIOBOOKSHELF_CONTAINER = 'saltedlolly-audiobookshelf_web_1';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Logging helper
const log = (level, message) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
};

// Read configuration file
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist, return default config
            return { enabledShares: [], shareSettings: {} };
        }
        throw error;
    }
}

// Write configuration file
async function writeConfig(config) {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    log('info', 'Configuration saved');
}

// Discover available network shares
async function discoverShares() {
    const shares = [];
    let config = { enabledShares: [], shareSettings: {} };
    try {
        // Try to load config to get required shares
        try {
            const data = await fs.readFile(CONFIG_FILE, 'utf8');
            config = JSON.parse(data);
        } catch { }

        // Check if network mount root exists
        let hosts = [];
        try {
            await fs.access(NETWORK_MOUNT_ROOT);
            hosts = await fs.readdir(NETWORK_MOUNT_ROOT);
        } catch {
            log('warn', `Network mount root ${NETWORK_MOUNT_ROOT} not accessible`);
        }

        // Track all found shares by fullPath
        const foundShares = new Set();

        for (const host of hosts) {
            const hostPath = path.join(NETWORK_MOUNT_ROOT, host);
            let hostStat;
            try {
                hostStat = await fs.stat(hostPath);
            } catch { continue; }
            if (!hostStat.isDirectory()) continue;
            let shareNames = [];
            try {
                shareNames = await fs.readdir(hostPath);
            } catch { continue; }
            for (const shareName of shareNames) {
                const sharePath = path.join(hostPath, shareName);
                const fullMountPath = `${host}/${shareName}`;
                let shareStat;
                try {
                    shareStat = await fs.stat(sharePath);
                } catch { continue; }
                if (!shareStat.isDirectory()) continue;
                const status = await getShareStatus(sharePath);
                shares.push({
                    host,
                    shareName,
                    fullPath: fullMountPath,
                    systemPath: sharePath,
                    ...status,
                });
                foundShares.add(fullMountPath);
            }
        }

        // Add any required shares that are missing from the filesystem
        for (const fullPath of config.enabledShares) {
            if (!foundShares.has(fullPath)) {
                // Parse host/shareName from fullPath
                const [host, ...shareParts] = fullPath.split('/');
                const shareName = shareParts.join('/');
                shares.push({
                    host,
                    shareName,
                    fullPath,
                    systemPath: path.join(NETWORK_MOUNT_ROOT, fullPath),
                    status: 'not-mounted',
                    isMounted: false,
                    isAccessible: false,
                    isEmpty: false,
                });
            }
        }
    } catch (error) {
        log('error', `Error discovering shares: ${error.message}`);
    }
    return shares;
}

// Get detailed share status (4 possible states)
async function getShareStatus(sharePath) {
    try {
        // Check 1: Does the path exist?
        try {
            await fs.access(sharePath);
        } catch {
            return {
                status: 'not-mounted',
                isMounted: false,
                isAccessible: false,
                isEmpty: false,
            };
        }

        // Check 2: Can we read it?
        let files;
        try {
            await fs.access(sharePath, fs.constants.R_OK);
            files = await fs.readdir(sharePath);
        } catch (error) {
            return {
                status: 'permission-denied',
                isMounted: true,
                isAccessible: false,
                isEmpty: false,
            };
        }

        // Check 3: Is it empty? (common sign of mount failure)
        if (files.length === 0) {
            return {
                status: 'empty',
                isMounted: true,
                isAccessible: true,
                isEmpty: true,
            };
        }

        // All good!
        return {
            status: 'accessible',
            isMounted: true,
            isAccessible: true,
            isEmpty: false,
        };
    } catch (error) {
        return {
            status: 'not-mounted',
            isMounted: false,
            isAccessible: false,
            isEmpty: false,
        };
    }
}

// Check if Audiobookshelf container is running
const http = require('http');
async function getAudiobookshelfStatus() {
    // Try to reach the Audiobookshelf web UI (health check)
    // Use the Docker Compose service name for Audiobookshelf (network alias)
    const absHost = process.env.ABS_SERVICE_NAME || 'saltedlolly-audiobookshelf_web_1';
    // Use port 80 for internal Docker network communication
    const absPort = process.env.ABS_SERVICE_PORT || 80;
    const options = {
        hostname: absHost,
        port: absPort,
        path: '/',
        method: 'GET',
        timeout: 2000,
    };
    return new Promise((resolve) => {
        const req = http.request(options, (res) => {
            if (res.statusCode && res.statusCode < 500) {
                resolve({
                    running: true,
                    status: 'running',
                    message: 'Audiobookshelf is available',
                });
            } else {
                resolve({
                    running: false,
                    status: 'unhealthy',
                    message: `Audiobookshelf is not available - ${res.statusCode}`,
                });
            }
        });
        req.on('error', (err) => {
            resolve({
                running: false,
                status: 'not-responding',
                message: `Audiobookshelf is not available - ${err.message}`,
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({
                running: false,
                status: 'timeout',
                message: 'Audiobookshelf is not available',
            });
        });
        req.end();
    });
}

// API Routes

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Get current configuration
app.get('/api/config', async (req, res) => {
    try {
        const config = await readConfig();
        res.json(config);
    } catch (error) {
        log('error', `Error reading config: ${error.message}`);
        res.status(500).json({ error: 'Failed to read configuration' });
    }
});

// Get combined status (app + shares)
app.get('/api/status', async (req, res) => {
    try {
        const [appStatus, config, shares] = await Promise.all([
            getAudiobookshelfStatus(),
            readConfig(),
            discoverShares(),
        ]);

        // Determine if any required shares are blocking
        const requiredShares = shares.filter(s => config.enabledShares.includes(s.fullPath));
        const blockingShares = requiredShares.filter(s => s.status !== 'accessible');

        let overallStatus = appStatus.status;
        let message = appStatus.message;

        if (!appStatus.running && blockingShares.length > 0) {
            overallStatus = 'waiting';
            message = `Waiting for ${blockingShares.length} required share(s) to become available`;
        } else if (!appStatus.running && blockingShares.length === 0) {
            overallStatus = 'starting';
            message = 'Audiobookshelf is starting up...';
        }

        res.json({
            app: {
                ...appStatus,
                overallStatus,
                message,
            },
            shares: shares.map(share => ({
                ...share,
                isRequired: config.enabledShares.includes(share.fullPath),
                isBlocking: config.enabledShares.includes(share.fullPath) && share.status !== 'accessible',
            })),
        });
    } catch (error) {
        log('error', `Error getting status: ${error.message}`);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

// Discover available shares
app.get('/api/shares/discover', async (req, res) => {
    try {
        const shares = await discoverShares();
        res.json({ shares });
    } catch (error) {
        log('error', `Error discovering shares: ${error.message}`);
        res.status(500).json({ error: 'Failed to discover shares' });
    }
});

// Test access to a specific share
app.post('/api/shares/test', async (req, res) => {
    try {
        const { sharePath } = req.body;

        if (!sharePath) {
            return res.status(400).json({ error: 'Share path is required' });
        }

        const systemPath = path.join(NETWORK_MOUNT_ROOT, sharePath);
        const status = await getShareStatus(systemPath);

        // Map status to user-friendly messages
        const statusMessages = {
            'accessible': 'Share is accessible and working correctly',
            'empty': 'Share appears to be mounted but is empty (possible mount failure)',
            'permission-denied': 'Share exists but cannot be read (permission denied)',
            'not-mounted': 'Share does not appear to be mounted',
        };

        // Try to count files if accessible
        let fileCount = 0;
        if (status.isAccessible) {
            try {
                const files = await fs.readdir(systemPath);
                fileCount = files.length;
            } catch {
                // Ignore errors
            }
        }

        const success = status.status === 'accessible';

        res.json({
            success,
            message: statusMessages[status.status] + (fileCount > 0 ? ` (${fileCount} items found)` : ''),
            ...status,
            fileCount,
        });
    } catch (error) {
        log('error', `Error testing share access: ${error.message}`);
        res.status(500).json({
            success: false,
            message: `Error: ${error.message}`,
            status: 'not-mounted',
            isMounted: false,
            isAccessible: false,
        });
    }
});

// Save configuration
app.post('/api/config/save', async (req, res) => {
    try {
        const { enabledShares, shareSettings } = req.body;

        if (!Array.isArray(enabledShares)) {
            return res.status(400).json({ error: 'enabledShares must be an array' });
        }

        const config = {
            enabledShares: enabledShares || [],
            shareSettings: shareSettings || {},
        };

        await writeConfig(config);

        log('info', `Configuration saved: ${enabledShares.length} shares enabled`);

        res.json({
            success: true,
            message: 'Configuration saved successfully',
            config,
        });
    } catch (error) {
        log('error', `Error saving config: ${error.message}`);
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Serve index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    log('info', `Network Shares UI server listening on port ${PORT}`);
    log('info', `Data directory: ${DATA_DIR}`);
    log('info', `Config file: ${CONFIG_FILE}`);
    log('info', `Network mount root: ${NETWORK_MOUNT_ROOT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    log('info', 'SIGINT received, shutting down gracefully');
    process.exit(0);
});
