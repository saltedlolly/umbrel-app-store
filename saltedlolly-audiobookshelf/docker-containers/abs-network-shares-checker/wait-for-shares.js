#!/usr/bin/env node

/**
 * Checks all required network shares and updates their status in the config file.
 * Startup behavior:
 *   - Runs a full check once. If any required share is not accessible, exits with 1 so
 *     abs-manager can relaunch shortly (fresh filesystem view each time).
 *   - When all required shares are accessible, stays running, exposes a health
 *     endpoint, and performs maintenance re-checks every 15 minutes.
 * 
 * Exit codes:
 *   0 - All required shares are accessible (or no required shares) AND we will keep running
 *   1 - Some required shares are not yet accessible (container will exit; manager relaunches)
 *   2 - Fatal error reading configuration or other unrecoverable issue
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');

const CONFIG_FILE = process.env.CONFIG_FILE || '/data/network-shares.json';
const NETWORK_ROOT = process.env.NETWORK_MOUNT_ROOT || '/umbrel-network';
const MAINTENANCE_INTERVAL_MS = Number(process.env.MAINTENANCE_INTERVAL_MS || 15 * 60 * 1000); // default 15 minutes

const STATUS = {
    NOT_MOUNTED: 'not-mounted',
    PERMISSION_DENIED: 'permission-denied',
    CHECKING: 'checking',
    ACCESSIBLE: 'accessible',
    NOT_ACCESSIBLE: 'not-accessible',
};

const log = (...args) => {
    const timestamp = new Date().toISOString();
    console.log(` ${timestamp}`, ...args);
};

async function readConfig() {
    try {
        const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
        const cfg = JSON.parse(raw);
        if (!cfg.shares || typeof cfg.shares !== 'object') cfg.shares = {};
        if (!Array.isArray(cfg.enabledShares)) cfg.enabledShares = [];
        if (!cfg.shareSettings || typeof cfg.shareSettings !== 'object') cfg.shareSettings = {};
        return cfg;
    } catch (error) {
        log('Failed to read config file, assuming no required shares:', error.message);
        return { enabledShares: [], shares: {} };
    }
}

async function writeConfig(config) {
    const safeConfig = {
        enabledShares: Array.isArray(config.enabledShares) ? config.enabledShares : [],
        shareSettings: config.shareSettings || {},
        shares: config.shares || {},
    };
    await fsp.writeFile(CONFIG_FILE, JSON.stringify(safeConfig, null, 2), 'utf8');
}

async function setShareStatus(fullPath, updates) {
    const cfg = await readConfig();
    cfg.shares = cfg.shares || {};
    const existing = cfg.shares[fullPath] || {};
    const isRequired = (cfg.enabledShares || []).includes(fullPath);
    cfg.shares[fullPath] = {
        fullPath,
        isRequired,
        status: STATUS.CHECKING,
        foundReadableFile: false,
        lastCheckedAt: null,
        ...existing,
        ...updates,
        isRequired,
        lastCheckedAt: new Date().toISOString(),
    };
    await writeConfig(cfg);
}

async function checkShareAccessibility(mountPath) {
    const MAX_FOLDERS = 20;
    const MAX_DEPTH = 3;
    let foldersChecked = 0;
    let foundReadableFile = false;
    const queue = [{ path: mountPath, depth: 0 }];
    log(`Checking share: ${mountPath}`);
    try {
        const stat = await fsp.stat(mountPath);
        if (!stat.isDirectory()) {
            log(`WARN: ${mountPath} exists but is not a directory.`);
            return { status: STATUS.NOT_MOUNTED, foundReadableFile: false };
        }
        await fsp.access(mountPath, fs.constants.R_OK);
    } catch (err) {
        log(`WARN: Error accessing root of share ${mountPath}: ${err.message}`);
        if (err.code === 'ENOENT') return { status: STATUS.NOT_MOUNTED, foundReadableFile: false };
        if (err.code === 'EACCES') return { status: STATUS.PERMISSION_DENIED, foundReadableFile: false };
        return { status: STATUS.NOT_ACCESSIBLE, foundReadableFile: false };
    }

    while (queue.length > 0 && foldersChecked < MAX_FOLDERS && !foundReadableFile) {
        const { path: currentPath, depth } = queue.shift();
        foldersChecked++;
        let entries;
        try {
            entries = await fsp.readdir(currentPath);
        } catch (err) {
            log(`WARN: Could not read directory ${currentPath}: ${err.message}`);
            continue;
        }
        log(`[Depth ${depth}] ${currentPath}: ${entries.length} entries (${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ', ...' : ''})`);
        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry);
            let entryStat;
            try {
                entryStat = await fsp.stat(entryPath);
            } catch (err) {
                log(`WARN: Could not stat ${entryPath}: ${err.message}`);
                continue;
            }
            if (entryStat.isFile()) {
                try {
                    await fsp.access(entryPath, fs.constants.R_OK);
                    log(`SUCCESS: Readable file found: ${entryPath}`);
                    foundReadableFile = true;
                    break;
                } catch (err) {
                    log(`WARN: Could not read file ${entryPath}: ${err.message}`);
                }
            } else if (entryStat.isDirectory() && depth + 1 < MAX_DEPTH) {
                queue.push({ path: entryPath, depth: depth + 1 });
            }
        }
    }
    if (!foundReadableFile) {
        log(`WARN: No readable file found in ${mountPath} after checking up to ${foldersChecked} folders and depth ${MAX_DEPTH}.`);
        return { status: STATUS.NOT_ACCESSIBLE, foundReadableFile: false };
    }
    return { status: STATUS.ACCESSIBLE, foundReadableFile: true };
}

async function evaluateShares() {
    const config = await readConfig();
    const discoveredShares = Object.keys(config.shares || {});
    const requiredShares = config.enabledShares || [];
    const allShares = Array.from(new Set([...discoveredShares, ...requiredShares])).filter(Boolean);

    if (allShares.length === 0) {
        return { total: 0, outstanding: [], ready: true };
    }

    const outstanding = [];

    for (const share of allShares) {
        if (!share) continue;
        const mountPath = path.join(NETWORK_ROOT, share);

        // Always check the share (no caching - fresh check each run)
        const result = await checkShareAccessibility(mountPath);
        const status = result.status;
        const foundReadableFile = result.foundReadableFile;

        // Update the status in the config file
        await setShareStatus(share, { status, foundReadableFile });

        // Only gate on required shares
        if (requiredShares.includes(share) && status !== STATUS.ACCESSIBLE) {
            outstanding.push({ name: share, path: mountPath, status });
        }
    }

    const ready = (requiredShares.length === 0) || outstanding.length === 0;
    return { total: requiredShares.length, outstanding, ready };
}

let lastReady = false;

// Health endpoint served only while this process is running
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        if (lastReady) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ ready: lastReady }));
    } else if (req.url === '/trigger-scan' && req.method === 'POST') {
        // HTTP endpoint to trigger an immediate scan (alternative to SIGUSR1)
        log('HTTP /trigger-scan endpoint called - starting immediate scan');
        
        // Run the scan immediately (async, don't block the response)
        (async () => {
            try {
                const { total, outstanding, ready } = await evaluateShares();
                lastReady = ready;
                
                if (ready) {
                    log('Triggered scan complete: All required shares are accessible');
                } else {
                    const list = outstanding.map(s => `${s.name} (${s.status})`).join(', ');
                    log(`Triggered scan complete: waiting for ${outstanding.length}/${total} required share(s): ${list}`);
                }
            } catch (err) {
                log('ERROR during triggered scan:', err.message || err);
            }
        })();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Scan triggered via HTTP' }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

async function runMaintenanceLoop() {
    log(`Entering maintenance loop (every ${Math.round(MAINTENANCE_INTERVAL_MS / 1000)}s)`);
    setInterval(async () => {
        try {
            const { total, outstanding, ready } = await evaluateShares();
            const wasReady = lastReady;
            lastReady = ready;

            if (ready && !wasReady) {
                log('All required shares are accessible (maintenance loop)');
            } else if (!ready) {
                const list = outstanding.map(s => `${s.name} (${s.status})`).join(', ');
                log(`Maintenance check: waiting for ${outstanding.length}/${total} required share(s): ${list}`);
            }
        } catch (err) {
            log('ERROR during maintenance check:', err.message || err);
        }
    }, MAINTENANCE_INTERVAL_MS);
}

async function main() {
    log('Checking network shares (initial run)');

    try {
        const { total, outstanding, ready } = await evaluateShares();

        if (!ready) {
            const list = outstanding.map(s => `${s.name} (${s.status})`).join(', ');
            log(`Waiting for ${outstanding.length}/${total} required share(s): ${list}`);
            // Exit so abs-manager can relaunch shortly with a fresh view
            process.exit(1);
        }

        // Ready: keep running, expose health endpoint, and start maintenance loop
        lastReady = true;
        server.listen(8080, () => {
            log('Health endpoint listening on :8080');
        });

        log(`All ${total} required share(s) are accessible; staying up`);

        // List contents for verification once
        const config = await readConfig();
        for (const share of config.enabledShares || []) {
            const mountPath = path.join(NETWORK_ROOT, share);
            try {
                const entries = await fsp.readdir(mountPath);
                log(`Share ${share}: ${entries.length} items`);
            } catch (err) {
                log(`WARN: Could not list ${mountPath}: ${err.message}`);
            }
        }

        // Set up signal handler for immediate scan trigger
        let inSignalHandler = false;
        process.on('SIGUSR1', async () => {
            if (inSignalHandler) {
                log('SIGUSR1 received while already handling a signal, ignoring');
                return;
            }
            inSignalHandler = true;
            log('=== SIGUSR1 SIGNAL RECEIVED - Starting immediate check ===');
            try {
                const cfgBefore = await readConfig();
                log(`  Config has ${Object.keys(cfgBefore.shares || {}).length} shares total, ${(cfgBefore.enabledShares || []).length} required`);
                
                const { total, outstanding, ready } = await evaluateShares();
                
                const cfgAfter = await readConfig();
                log(`  After evaluateShares: ${Object.keys(cfgAfter.shares || {}).length} shares total, ${(cfgAfter.enabledShares || []).length} required`);
                
                if (ready) {
                    log(`=== Immediate check COMPLETE: All ${total} required share(s) accessible ===`);
                } else {
                    const list = outstanding.map(s => `${s.name} (${s.status})`).join(', ');
                    log(`=== Immediate check COMPLETE: waiting for ${outstanding.length}/${total} share(s): ${list} ===`);
                }
            } catch (err) {
                log('ERROR during immediate maintenance check:', err.message || err);
            } finally {
                inSignalHandler = false;
            }
        });

        await runMaintenanceLoop();
    } catch (error) {
        log('ERROR:', error.message || error);
        process.exit(2);
    }
}

main();