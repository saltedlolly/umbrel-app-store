#!/usr/bin/env node

/**
 * Checks all required network shares and updates their status in the config file.
 * Startup behavior:
 *   - Runs a full check once. If any required share is not accessible, exits with 1 so
 *     abs-manager can relaunch shortly (fresh filesystem view each time).
 *   - When all required shares are accessible, stays running, exposes a health
 *     endpoint, and performs maintenance re-checks every 15 minutes.
 *   - Maintenance checks are light (the share is still there, readable and not
 *     empty), so the NAS isn't asked to list up to 20 folders every 15 minutes;
 *     the full check runs only if the light one fails. A required share must
 *     fail RECHECK_ATTEMPTS checks in a row, RECHECK_DELAY_MS apart, before this
 *     reports not ready (which makes abs-manager restart Audiobookshelf), so one
 *     slow answer from the NAS doesn't cost a restart.
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
const RECHECK_ATTEMPTS = Number(process.env.RECHECK_ATTEMPTS || 3);
const RECHECK_DELAY_MS = Number(process.env.RECHECK_DELAY_MS || 60 * 1000);

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

// Written to a temporary file and renamed into place, so the other
// processes that read this file (config tool, manager, checker) never see
// it half-written
async function writeConfig(config) {
    const safeConfig = {
        enabledShares: Array.isArray(config.enabledShares) ? config.enabledShares : [],
        shareSettings: config.shareSettings || {},
        shares: config.shares || {},
    };
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(safeConfig, null, 2), 'utf8');
    // Runs as root; keep the file owned by the config tool's user (1000)
    if (process.getuid && process.getuid() === 0) await fsp.chown(tmp, 1000, 1000);
    await fsp.rename(tmp, CONFIG_FILE);
}

// network-shares.json is changed by three processes (config tool, manager,
// checker). Each change takes a lock file next to it, then reads the latest
// file, changes it and writes it, so one process can't overwrite a change
// another made a moment earlier. A lock older than 10 seconds is left over
// from a process that died and is removed; after 15 seconds of waiting the
// change goes ahead anyway rather than being lost.
async function withConfigLock(fn) {
    const lock = `${CONFIG_FILE}.lock`;
    const started = Date.now();
    let owned = false;
    while (!owned) {
        try {
            await (await fsp.open(lock, 'wx')).close();
            owned = true;
        } catch (err) {
            if (err.code !== 'EEXIST') break;
            try {
                if (Date.now() - (await fsp.stat(lock)).mtimeMs > 10000) {
                    await fsp.unlink(lock);
                    continue;
                }
            } catch { continue; }
            if (Date.now() - started > 15000) break;
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    try {
        return await fn();
    } finally {
        if (owned) await fsp.unlink(lock).catch(() => { });
    }
}

// change(cfg) edits the latest config in place; returning false skips the write
async function updateConfig(change) {
    return withConfigLock(async () => {
        const cfg = await readConfig();
        if ((await change(cfg)) === false) return cfg;
        await writeConfig(cfg);
        return cfg;
    });
}

// Only writes when the status actually changes, so routine checks don't
// rewrite the file the config tool and manager also update
async function setShareStatus(fullPath, updates) {
    await updateConfig((cfg) => {
        const existing = cfg.shares[fullPath] || {};
        const isRequired = (cfg.enabledShares || []).includes(fullPath);
        if (existing.status === updates.status && !!existing.foundReadableFile === !!updates.foundReadableFile
            && existing.isRequired === isRequired) return false;
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
    });
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

// Light check for a share that was accessible last time: still a readable,
// non-empty folder. One request to the NAS instead of walking its folders.
async function shareStillAccessible(mountPath) {
    try {
        const stat = await fsp.stat(mountPath);
        if (!stat.isDirectory()) return false;
        await fsp.access(mountPath, fs.constants.R_OK);
        return (await fsp.readdir(mountPath)).length > 0;
    } catch {
        return false;
    }
}

// light: trust a share that was accessible and still passes the light check
async function evaluateShares({ light = false } = {}) {
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

        const previous = (config.shares || {})[share] || {};
        const result = light && previous.status === STATUS.ACCESSIBLE && await shareStillAccessible(mountPath)
            ? { status: STATUS.ACCESSIBLE, foundReadableFile: true }
            : await checkShareAccessibility(mountPath);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function maintenanceCheck() {
    let result = await evaluateShares({ light: true });
    // A required share failed: check again a few times before reporting not
    // ready, so a NAS that is briefly slow or busy doesn't restart Audiobookshelf
    for (let attempt = 2; !result.ready && lastReady && attempt <= RECHECK_ATTEMPTS; attempt++) {
        const list = result.outstanding.map(s => `${s.name} (${s.status})`).join(', ');
        log(`Maintenance check: ${list} not accessible; checking again in ${Math.round(RECHECK_DELAY_MS / 1000)}s (${attempt}/${RECHECK_ATTEMPTS})`);
        await sleep(RECHECK_DELAY_MS);
        result = await evaluateShares();
    }
    const { total, outstanding, ready } = result;
    const wasReady = lastReady;
    lastReady = ready;
    if (ready && !wasReady) {
        log('All required shares are accessible (maintenance loop)');
    } else if (!ready) {
        const list = outstanding.map(s => `${s.name} (${s.status})`).join(', ');
        log(`Maintenance check: waiting for ${outstanding.length}/${total} required share(s): ${list}`);
    }
}

async function runMaintenanceLoop() {
    log(`Entering maintenance loop (every ${Math.round(MAINTENANCE_INTERVAL_MS / 1000)}s)`);
    // One check at a time: the next starts MAINTENANCE_INTERVAL_MS after the last one finished
    for (;;) {
        await sleep(MAINTENANCE_INTERVAL_MS);
        try {
            await maintenanceCheck();
        } catch (err) {
            log('ERROR during maintenance check:', err.message || err);
        }
    }
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
        const port = Number(process.env.HEALTH_PORT || 8080);   // 8080 in the app; set only for local tests
        server.listen(port, () => {
            log(`Health endpoint listening on :${port}`);
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