const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = 3001;
const DATA_DIR = process.env.APP_DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'network-shares.json');
const NETWORK_MOUNT_ROOT = '/umbrel-network';

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

                    // Check if it's mounted and accessible
                    const isMounted = await checkIfMounted(sharePath);
                    const isAccessible = await checkIfAccessible(sharePath);

                    shares.push({
                        host,
                        shareName,
                        fullPath: fullMountPath,
                        systemPath: sharePath,
                        isMounted,
                        isAccessible,
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

// Check if a path is actually mounted
async function checkIfMounted(mountPath) {
    try {
        // Use mountpoint command if available
        await execAsync(`mountpoint -q "${mountPath}"`);
        return true;
    } catch {
        // mountpoint command failed or not available
        // Check if the path exists and is not empty as a fallback
        try {
            const files = await fs.readdir(mountPath);
            return files.length > 0;
        } catch {
            return false;
        }
    }
}

// Check if a path is accessible (can read it)
async function checkIfAccessible(testPath) {
    try {
        await fs.access(testPath, fs.constants.R_OK);
        await fs.readdir(testPath);
        return true;
    } catch {
        return false;
    }
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
        const isMounted = await checkIfMounted(systemPath);
        const isAccessible = await checkIfAccessible(systemPath);

        if (!isMounted) {
            return res.json({
                success: false,
                message: 'Share does not appear to be mounted',
                isMounted,
                isAccessible,
            });
        }

        if (!isAccessible) {
            return res.json({
                success: false,
                message: 'Share is mounted but not accessible (permission denied)',
                isMounted,
                isAccessible,
            });
        }

        // Try to list files
        const files = await fs.readdir(systemPath);

        res.json({
            success: true,
            message: `Successfully accessed share (${files.length} items found)`,
            isMounted,
            isAccessible,
            fileCount: files.length,
        });
    } catch (error) {
        log('error', `Error testing share access: ${error.message}`);
        res.status(500).json({
            success: false,
            message: `Error: ${error.message}`,
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
