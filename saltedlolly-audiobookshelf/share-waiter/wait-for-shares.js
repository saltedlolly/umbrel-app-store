#!/usr/bin/env node

/**
 * Waits for required network shares to become available before allowing
 * Audiobookshelf to launch. Intended to run inside the share-waiter sidecar.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');

const CONFIG_FILE = process.env.CONFIG_FILE || '/data/network-shares.json';
const NETWORK_ROOT = process.env.NETWORK_MOUNT_ROOT || '/media/network';
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 5000);

const log = (...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[SHARE-WAITER] [${timestamp}]`, ...args);
};

async function readConfig() {
    try {
        const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        log('Failed to read config file, assuming no required shares:', error.message);
        return { enabledShares: [] };
    }
}

async function isMountAccessible(mountPath) {
    // Robust, efficient breadth-first search for a readable file
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
            return false;
        }
        await fsp.access(mountPath, fs.constants.R_OK);
    } catch (err) {
        log(`WARN: Error accessing root of share ${mountPath}: ${err.message}`);
        return false;
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
        return false;
    }
    return true;
}

async function evaluateShares() {
    const config = await readConfig();
    const shares = config.enabledShares || [];
    if (shares.length === 0) {
        return { total: 0, outstanding: [] };
    }

    const outstanding = [];
    for (const share of shares) {
        if (!share) continue;
        const mountPath = path.join(NETWORK_ROOT, share);
        if (!(await isMountAccessible(mountPath))) {
            outstanding.push({ name: share, path: mountPath });
        }
    }
    return { total: shares.length, outstanding };
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let lastReady = false;

// Start HTTP health endpoint
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        if (lastReady) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ ready: lastReady }));
    } else {
        res.writeHead(404);
        res.end();
    }
});
server.listen(8080, () => {
    log('Health endpoint listening on :8080');
});

async function main() {
    log('Starting share-waiter service (continuous mode)');

    const { total, outstanding } = await evaluateShares();

    lastReady = (total === 0 || outstanding.length === 0);

    if (total === 0) {
        log('No required network shares configured. Skipping wait.');
        // Keep alive
        while (true) {
            await sleep(60 * 60 * 1000);
        }
    }

    if (outstanding.length === 0) {
        log('All required network shares are ready. Listing contents for verification:');
        // List all required shares and their contents for logging
        const config = await readConfig();
        for (const share of config.enabledShares || []) {
            const mountPath = path.join(NETWORK_ROOT, share);
            try {
                const entries = await fsp.readdir(mountPath);
                log(`Share ${share} (${mountPath}): ${entries.length} items: [${entries.join(', ')}]`);
            } catch (err) {
                log(`WARN: Could not list contents of ${mountPath}: ${err.message}`);
            }
        }
        // Keep the container alive after success
        while (true) {
            await sleep(60 * 60 * 1000); // sleep 1 hour, repeat
        }
    }

    // If any required share is missing, log and exit (container will restart)
    const list = outstanding.map(s => `${s.name} (${s.path})`).join(', ');
    log(`Waiting for ${outstanding.length}/${total} required share(s): ${list}`);
    process.exit(1);
}

main()
    .catch(error => {
        log('ERROR:', error.message || error);
        process.exit(1);
    });