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

    try {
        // Check if network mount root exists
        try {
            await fs.access(NETWORK_MOUNT_ROOT);
        } catch {
            log('warn', `Network mount root ${NETWORK_MOUNT_ROOT} not accessible`);
            return shares;
        }

        // List all hosts in /umbrel-network
        const hosts = await fs.readdir(NETWORK_MOUNT_ROOT);

        for (const host of hosts) {
            const hostPath = path.join(NETWORK_MOUNT_ROOT, host);

            // Check if it's a directory
            const hostStat = await fs.stat(hostPath);
            if (!hostStat.isDirectory()) continue;

            // List all shares for this host
            try {
                const shareNames = await fs.readdir(hostPath);

                for (const shareName of shareNames) {
                    const sharePath = path.join(hostPath, shareName);
                    const fullMountPath = `${host}/${shareName}`;

                    // Check if it's a directory
                    const shareStat = await fs.stat(sharePath);
                    if (!shareStat.isDirectory()) continue;

                    // Check detailed share status
                    const status = await getShareStatus(sharePath);

                    shares.push({
                        host,
                        shareName,
                        fullPath: fullMountPath,
                        systemPath: sharePath,
                        ...status,
                    });
                }
            } catch (error) {
                log('warn', `Error reading shares for host ${host}: ${error.message}`);
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
    const options = {
        hostname: '127.0.0.1',
        port: 13378,
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
                    message: 'Audiobookshelf web UI is accessible',
                });
            } else {
                resolve({
                    running: false,
                    status: 'unhealthy',
                    message: `Audiobookshelf web UI returned status ${res.statusCode}`,
                });
            }
        });
        req.on('error', (err) => {
            resolve({
                running: false,
                status: 'not-responding',
                message: `Audiobookshelf web UI not reachable: ${err.message}`,
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({
                running: false,
                status: 'timeout',
                message: 'Audiobookshelf web UI timed out',
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
