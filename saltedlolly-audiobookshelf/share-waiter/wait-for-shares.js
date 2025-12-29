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

async function main() {
    log('Starting share-waiter service (continuous mode)');
    startHealthServer();

    while (true) {
        const requiredShares = getRequiredShares();
        let allReady = true;
        for (const share of requiredShares) {
            const ready = await checkShareReady(share);
            if (!ready) {
                allReady = false;
            }
        }
        if (allReady) {
            log('All required network shares are ready. Listing contents for verification:');
            for (const share of requiredShares) {
                await listShareContents(share);
            }
            // Instead of break, just keep looping and monitoring
        } else {
            log(`Waiting for ${requiredShares.length}/1 required share(s): ${requiredShares.map(s => s.displayName + ' (' + s.path + ')').join(', ')}`);
        }
        await sleep(5000);
    }
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

// ...existing code...
main()
    .catch(error => {
        log('ERROR:', error.message || error);
        process.exit(1);
    });