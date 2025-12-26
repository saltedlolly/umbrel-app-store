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
const MAX_WAIT_SECONDS = Number(process.env.MAX_WAIT_SECONDS || 300);
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 2000);

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
            log(`WARN: ${mountPath} is accessible but empty (could be a failed mount).`);
        }
        return true;
    } catch {
        return false;
    }
}

async function waitForShare(share) {
    const mountPath = path.join(NETWORK_ROOT, share);
    log(`Waiting for required share "${share}" at ${mountPath}`);
    const start = Date.now();

    while (true) {
        if (await isMountAccessible(mountPath)) {
            log(`✓ Share available: ${share}`);
            return true;
        }

        const elapsed = (Date.now() - start) / 1000;
        if (elapsed >= MAX_WAIT_SECONDS) {
            log(`✗ Timeout waiting for share ${share} after ${MAX_WAIT_SECONDS}s`);
            return false;
        }

        if (Math.floor(elapsed) % 10 === 0) {
            log(`...still waiting for ${share} (${Math.floor(elapsed)}s elapsed)`);
        }
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
    }
}

async function main() {
    log('Starting share-waiter service');
    const config = await readConfig();
    const shares = config.enabledShares || [];

    if (shares.length === 0) {
        log('No required network shares configured. Skipping wait.');
        return;
    }

    log(`Waiting for ${shares.length} required share(s)...`);
    for (const share of shares) {
        if (!share) continue;
        const success = await waitForShare(share);
        if (!success) {
            throw new Error(`Share "${share}" did not become available`);
        }
    }

    log('All required shares are ready.');
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        log('ERROR:', error.message || error);
        process.exit(1);
    });
