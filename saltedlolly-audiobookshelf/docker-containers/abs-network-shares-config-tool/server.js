const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = 3001;
const DATA_DIR = '/data';
const CONFIG_FILE = process.env.CONFIG_FILE || '/data/network-shares.json';
const NETWORK_MOUNT_ROOT = '/umbrel-network';
const NETWORK_HOST_PATH = '/home/umbrel/umbrel/network'; // Host path for display
const AUDIOBOOKSHELF_CONTAINER = 'saltedlolly-audiobookshelf_abs-server_1';
const SHARE_CHECKER_CONTAINER = 'saltedlolly-audiobookshelf_abs-network-shares-checker_1';
const SHARE_CHECKER_HEALTH_URL = 'http://saltedlolly-audiobookshelf_abs-network-shares-checker_1:8080/health';
const ABS_MANAGER_CONTAINER = 'saltedlolly-audiobookshelf_abs-manager_1';
const DOCKER_PROXY_HOST = 'docker-socket-proxy';
const DOCKER_PROXY_PORT = 2375;

// Status constants used across the manager, checker, and config-tool
const STATUS = {
    NOT_MOUNTED: 'not-mounted',
    PERMISSION_DENIED: 'permission-denied',
    CHECKING: 'checking',
    ACCESSIBLE: 'accessible',
    NOT_ACCESSIBLE: 'not-accessible',
    RESTART_REQUIRED: 'restart-required',
};

const DEFAULT_CONFIG = {
    enabledShares: [],
    shareSettings: {},
    shares: {},
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Reset state on startup so required shares start in "checking" and stale optional shares are removed
resetShareStatusesOnStartup().catch(err => {
    log('error', `Failed to reset share statuses on startup: ${err.message}`);
});

// Logging helper
const log = (level, message) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
};

// Read configuration file (ensures shares map exists)
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        const cfg = JSON.parse(data);
        if (!cfg.shares || typeof cfg.shares !== 'object') {
            cfg.shares = {};
        }
        if (!Array.isArray(cfg.enabledShares)) {
            cfg.enabledShares = [];
        }
        if (!cfg.shareSettings || typeof cfg.shareSettings !== 'object') {
            cfg.shareSettings = {};
        }
        return cfg;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { ...DEFAULT_CONFIG };
        }
        throw error;
    }
}

// Write configuration file
async function writeConfig(config) {
    const cfg = {
        ...DEFAULT_CONFIG,
        ...config,
        enabledShares: Array.isArray(config.enabledShares) ? config.enabledShares : [],
        shareSettings: config.shareSettings || {},
        shares: config.shares || {},
    };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    log('info', 'Configuration saved');
}

// Upsert a single share status record and persist
async function upsertShareStatus(fullPath, updates) {
    const cfg = await readConfig();
    if (!cfg.shares) cfg.shares = {};
    const existing = cfg.shares[fullPath] || {};
    const isRequired = cfg.enabledShares.includes(fullPath);
    cfg.shares[fullPath] = {
        fullPath,
        isRequired,
        foundReadableFile: false,
        status: STATUS.CHECKING,
        lastCheckedAt: null,
        ...existing,
        ...updates,
        isRequired,
        lastCheckedAt: new Date().toISOString(),
    };
    await writeConfig(cfg);
    return cfg.shares[fullPath];
}

// Reset share status list on startup: keep required, drop others, set to checking
async function resetShareStatusesOnStartup() {
    const cfg = await readConfig();
    // Wipe all shares, then re-add only required shares with CHECKING status
    const nextShares = {};
    for (const fullPath of cfg.enabledShares) {
        nextShares[fullPath] = {
            fullPath,
            isRequired: true,
            status: STATUS.CHECKING,
            foundReadableFile: false,
            lastCheckedAt: new Date().toISOString(),
        };
    }
    cfg.shares = nextShares;
    await writeConfig(cfg);
    log('info', 'Reset all shares on startup (required shares set to checking, non-required forgotten)');
}

// Discover available network shares
async function discoverShares(appStatus = null) {
    const shares = [];
    let config = await readConfig();
    const absRunning = appStatus ? !!appStatus.running : false;
    try {
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
        let configDirty = false;

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

                const existing = config.shares[fullMountPath];
                const isRequired = config.enabledShares.includes(fullMountPath);
                
                // Always do a quick read check to detect permission changes
                let statusRecord = existing;
                try {
                    await fs.access(sharePath, fs.constants.R_OK);
                    // Readable - use existing status or default to CHECKING for checker to scan
                    if (!statusRecord || statusRecord.status === STATUS.CHECKING || statusRecord.status === STATUS.PERMISSION_DENIED) {
                        statusRecord = existing || {
                            fullPath: fullMountPath,
                            status: STATUS.CHECKING,
                            foundReadableFile: false,
                            isRequired,
                            lastCheckedAt: null,
                        };
                        // Ensure new shares are written to config for checker to find
                        if (!existing) {
                            config.shares[fullMountPath] = statusRecord;
                            configDirty = true;
                        }
                    }
                    // Keep existing status if it was previously accessible/not-accessible
                } catch (err) {
                    // Not readable - write PERMISSION_DENIED immediately
                    statusRecord = {
                        fullPath: fullMountPath,
                        status: STATUS.PERMISSION_DENIED,
                        foundReadableFile: false,
                        isRequired,
                        lastCheckedAt: new Date().toISOString(),
                    };
                    if (!existing || existing.status !== STATUS.PERMISSION_DENIED) {
                        config.shares[fullMountPath] = statusRecord;
                        configDirty = true;
                    }
                }

                shares.push({
                    host,
                    shareName,
                    fullPath: fullMountPath,
                    systemPath: path.join(NETWORK_HOST_PATH, fullMountPath),
                    isRequired,
                    status: statusRecord.status ?? STATUS.CHECKING,
                    foundReadableFile: !!statusRecord.foundReadableFile,
                    isMounted: true,
                    isAccessible: statusRecord.status === STATUS.ACCESSIBLE,
                    isEmpty: false,
                });
                foundShares.add(fullMountPath);
            }
        }

        // Add any required shares that are missing from the filesystem
        for (const fullPath of config.enabledShares) {
            if (!foundShares.has(fullPath)) {
                const [host, ...shareParts] = fullPath.split('/');
                const shareName = shareParts.join('/');
                const existing = config.shares[fullPath] || {};
                const status = STATUS.NOT_MOUNTED;

                // Persist missing required share status immediately
                if (existing.status !== STATUS.NOT_MOUNTED) {
                    config.shares[fullPath] = {
                        fullPath,
                        isRequired: true,
                        status,
                        foundReadableFile: false,
                        lastCheckedAt: new Date().toISOString(),
                    };
                    configDirty = true;
                }
                shares.push({
                    host,
                    shareName,
                    fullPath,
                    systemPath: path.join(NETWORK_HOST_PATH, fullPath),
                    isRequired: true,
                    status,
                    foundReadableFile: !!existing.foundReadableFile,
                    isMounted: false,
                    isAccessible: false,
                    isEmpty: false,
                });
            }
        }

        // Clean up config: remove shares that are no longer mounted and not required
        for (const fullPath in config.shares) {
            const isRequired = config.enabledShares.includes(fullPath);
            const isMounted = foundShares.has(fullPath);
            if (!isRequired && !isMounted) {
                delete config.shares[fullPath];
                configDirty = true;
            }
        }

        if (configDirty) {
            log('info', `Writing config: ${Object.keys(config.shares || {}).length} shares total`);
            await writeConfig(config);
            
            // Trigger checker to scan newly detected shares (if ABS is already running)
            if (absRunning) {
                log('info', 'New shares detected while ABS running - triggering checker scan');
                triggerCheckerScan().catch(err => {
                    log('warn', `Failed to trigger checker scan: ${err.message}`);
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
                status: STATUS.NOT_MOUNTED,
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
                status: STATUS.PERMISSION_DENIED,
                isMounted: true,
                isAccessible: false,
                isEmpty: false,
            };
        }

        // Check 3: Is it empty? (common sign of mount failure)
        if (files.length === 0) {
            return {
                status: STATUS.NOT_ACCESSIBLE,
                isMounted: true,
                isAccessible: true,
                isEmpty: true,
            };
        }

        // Check 4: Previously assumed accessible; now report as checking until checker confirms readable file
        return {
            status: STATUS.CHECKING,
            isMounted: true,
            isAccessible: true,
            isEmpty: false,
        };
    } catch (error) {
        return {
            status: STATUS.NOT_MOUNTED,
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
    const absHost = process.env.ABS_SERVICE_NAME || 'saltedlolly-audiobookshelf_abs-server_1';
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

// Restart a container via docker-socket-proxy (no docker CLI dependency)
async function restartContainer(containerName) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: DOCKER_PROXY_HOST,
            port: DOCKER_PROXY_PORT,
            path: `/containers/${encodeURIComponent(containerName)}/restart?t=10`,
            method: 'POST',
            timeout: 5000,
        };
        const req = http.request(options, (res) => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
            } else {
                reject(new Error(`Docker API restart failed with status ${res.statusCode}`));
            }
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Docker API restart timed out'));
        });
        req.end();
    });
}

async function checkShareWaiterReady() {
    return new Promise((resolve) => {
        http.get(SHARE_CHECKER_HEALTH_URL, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(!!json.ready);
                } catch {
                    resolve(false);
                }
            });
        }).on('error', () => resolve(false));
    });
};

// Trigger the checker to perform an immediate scan
async function triggerCheckerScan() {
    return new Promise((resolve, reject) => {
        const checkerHost = 'saltedlolly-audiobookshelf_abs-network-shares-checker_1';
        const checkerPort = 8080;
        
        const options = {
            hostname: checkerHost,
            port: checkerPort,
            path: '/trigger-scan',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 5000,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve();
                } else {
                    reject(new Error(`Checker returned status ${res.statusCode}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout calling checker'));
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
        const appStatus = await getAudiobookshelfStatus();
        const [config, shares, shareWaiterReady] = await Promise.all([
            readConfig(),
            discoverShares(appStatus),
            checkShareWaiterReady(),
        ]);

        // Determine if any required shares are blocking
        const requiredShares = shares.filter(s => config.enabledShares.includes(s.fullPath));
        const blockingShares = requiredShares.filter(s => s.status !== STATUS.ACCESSIBLE);
        const hasRequiredShares = config.enabledShares && config.enabledShares.length > 0;

        let overallStatus = appStatus.status;
        let message = appStatus.message;

        // If there are no required shares, skip share-checker requirement and allow ABS to start
        // If there are required shares, only allow 'starting' (orange) if share-checker has allowed ABS to start
        if (hasRequiredShares && !shareWaiterReady) {
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
                isBlocking: config.enabledShares.includes(share.fullPath) && share.status !== STATUS.ACCESSIBLE,
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
        const appStatus = await getAudiobookshelfStatus();
        const shares = await discoverShares(appStatus);
        res.json({ shares });
    } catch (error) {
        log('error', `Error discovering shares: ${error.message}`);
        res.status(500).json({ error: 'Failed to discover shares' });
    }
});

// Restart Audiobookshelf (via abs-manager container restart)
app.post('/api/restart', async (req, res) => {
    try {
        log('info', 'User initiated Audiobookshelf restart');
        
        // Reset required shares to 'checking' status before restart
        // Non-required shares are removed so they must be re-detected
        try {
            const cfg = await readConfig();
            const requiredShares = cfg.enabledShares || [];
            
            // Rebuild shares object with only required shares, all set to 'checking'
            cfg.shares = {};
            for (const sharePath of requiredShares) {
                cfg.shares[sharePath] = {
                    status: STATUS.CHECKING,
                    lastCheckedAt: null,
                };
            }
            
            await writeConfig(cfg);
            log('info', `Reset ${requiredShares.length} required shares to 'checking' status`);
        } catch (err) {
            log('warn', `Could not reset share statuses before restart: ${err.message}`);
            // Continue with restart anyway
        }
        
        await restartContainer(ABS_MANAGER_CONTAINER);
        res.json({ success: true });
    } catch (error) {
        log('error', `Error restarting Audiobookshelf: ${error.message}`);
        res.status(500).json({ error: 'Failed to restart Audiobookshelf' });
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

        // Record the latest observed status in the shared config
        await upsertShareStatus(sharePath, {
            status: status.status,
            foundReadableFile: status.status === STATUS.ACCESSIBLE,
        });

        // Map status to user-friendly messages
        const statusMessages = {
            [STATUS.ACCESSIBLE]: 'Share is accessible and working correctly',
            [STATUS.NOT_ACCESSIBLE]: 'Share appears to be mounted but may not contain readable files yet',
            [STATUS.PERMISSION_DENIED]: 'Share exists but cannot be read (permission denied)',
            [STATUS.NOT_MOUNTED]: 'Share does not appear to be mounted',
            [STATUS.CHECKING]: 'Share is mounted; verifying readability',
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

        const success = status.status === STATUS.ACCESSIBLE;

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

// Trigger immediate scan of a share by the checker
app.post('/api/shares/trigger-scan', async (req, res) => {
    try {
        const { sharePath } = req.body;

        if (!sharePath) {
            return res.status(400).json({ error: 'Share path is required' });
        }

        log('info', `Triggering immediate scan for share: ${sharePath}`);

        // Update share status to CHECKING in the config file
        const systemPath = path.join(NETWORK_MOUNT_ROOT, sharePath);
        await upsertShareStatus(sharePath, {
            status: STATUS.CHECKING,
        });

        // Call the checker's HTTP /trigger-scan endpoint to request an immediate scan
        // This avoids needing docker commands from inside the container
        try {
            // Use the full Docker container name to reach checker from within the Docker network
            const checkerHost = 'saltedlolly-audiobookshelf_abs-network-shares-checker_1';
            const checkerPort = 8080;
            log('info', `Sending HTTP POST to checker at http://${checkerHost}:${checkerPort}/trigger-scan`);
            const http = require('http');
            const postData = JSON.stringify({ sharePath });
            
            const options = {
                hostname: checkerHost,
                port: checkerPort,
                path: '/trigger-scan',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: 5000,
            };

            const checkerReq = http.request(options, (checkerRes) => {
                let data = '';
                checkerRes.on('data', (chunk) => {
                    data += chunk;
                });
                checkerRes.on('end', () => {
                    log('info', `Checker HTTP response: ${checkerRes.statusCode} - ${data}`);
                });
            });

            checkerReq.on('error', (error) => {
                log('warn', `Failed to reach checker HTTP endpoint: ${error.message}`);
            });

            checkerReq.on('timeout', () => {
                checkerReq.destroy();
                log('warn', `Timeout calling checker HTTP endpoint for ${sharePath}`);
            });

            checkerReq.write(postData);
            checkerReq.end();

            log('info', `HTTP trigger request sent for ${sharePath}`);
        } catch (httpError) {
            log('warn', `Error sending HTTP trigger: ${httpError.message}`);
        }

        res.json({
            success: true,
            message: 'Scan triggered',
            sharePath,
        });
    } catch (error) {
        log('error', `Error triggering share scan: ${error.message}`);
        res.status(500).json({
            error: 'Failed to trigger share scan',
            message: error.message,
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

        const existing = await readConfig();
        const enabledSet = new Set(enabledShares || []);
        const shares = { ...(existing.shares || {}) };

        // Mark previously required shares that are now disabled as optional
        for (const fullPath of Object.keys(shares)) {
            if (!enabledSet.has(fullPath)) {
                shares[fullPath] = {
                    ...shares[fullPath],
                    isRequired: false,
                };
            }
        }

        // Ensure all enabled shares exist in the map and are marked as required/checking
        for (const fullPath of enabledShares || []) {
            shares[fullPath] = {
                fullPath,
                isRequired: true,
                status: shares[fullPath]?.status || STATUS.CHECKING,
                foundReadableFile: shares[fullPath]?.foundReadableFile || false,
                lastCheckedAt: new Date().toISOString(),
            };
        }

        const config = {
            enabledShares: enabledShares || [],
            shareSettings: shareSettings || {},
            shares,
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
