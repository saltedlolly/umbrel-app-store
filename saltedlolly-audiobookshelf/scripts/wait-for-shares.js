#!/usr/bin/env node

/**
 * Waits for required network shares to become available before allowing
 * Audiobookshelf to launch. Intended to run inside the share-waiter sidecar.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

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
    try {
        const stat = await fsp.stat(mountPath);
        if (!stat.isDirectory()) return false;
        await fsp.access(mountPath, fs.constants.R_OK);
        const entries = await fsp.readdir(mountPath);
        if (entries.length === 0) {
            log(`WARN: ${mountPath} is accessible but empty (likely not ready yet).`);
            return false;
        }
        return true;
    } catch {
        return false;
    }
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

async function main() {
    log('Starting share-waiter service (continuous mode)');

    while (true) {
        const { total, outstanding } = await evaluateShares();

        if (total === 0) {
            log('No required network shares configured. Skipping wait.');
            break;
        }

        if (outstanding.length === 0) {
            log('All required network shares are ready.');
            break;
        }

        const list = outstanding.map(s => `${s.name} (${s.path})`).join(', ');
        log(`Waiting for ${outstanding.length}/${total} required share(s): ${list}`);
        await sleep(CHECK_INTERVAL_MS);
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        log('ERROR:', error.message || error);
        process.exit(1);
    });
