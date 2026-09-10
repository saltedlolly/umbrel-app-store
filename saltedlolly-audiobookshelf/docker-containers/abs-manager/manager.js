// abs-manager: Orchestrates abs-network-shares-checker and abs-server using docker-socket-proxy
import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname is not defined in ESM; derive it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docker = new Docker({ host: 'docker-socket-proxy', port: 2375 });

const fsp = fs.promises;
const DATA_DIR = '/data';
const CONFIG_FILE = process.env.CONFIG_FILE || '/data/network-shares.json';
const STATUS = {
  NOT_MOUNTED: 'not-mounted',
  PERMISSION_DENIED: 'permission-denied',
  CHECKING: 'checking',
  ACCESSIBLE: 'accessible',
  NOT_ACCESSIBLE: 'not-accessible',
  RESTART_REQUIRED: 'restart-required',
};



const CHECKER_IMAGE_FILE = path.resolve(__dirname, 'abs-network-shares-checker-image.txt');
const CHECKER_NAME = 'saltedlolly-audiobookshelf_abs-network-shares-checker_1';
const ABS_SERVER_NAME = 'saltedlolly-audiobookshelf_abs-server_1';
const CHECKER_LABEL = 'share-chkr';
const ABS_LABEL = 'abs-srvr';
let shuttingDown = false;

// Cache the current container's network for attaching child containers so they share DNS with the config tool
let currentNetworkName = null;

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.shares || typeof cfg.shares !== 'object') cfg.shares = {};
    if (!Array.isArray(cfg.enabledShares)) cfg.enabledShares = [];
    if (!cfg.shareSettings || typeof cfg.shareSettings !== 'object') cfg.shareSettings = {};
    return cfg;
  } catch (err) {
    return { enabledShares: [], shareSettings: {}, shares: {} };
  }
}

async function writeConfig(cfg) {
  const safeConfig = {
    enabledShares: Array.isArray(cfg.enabledShares) ? cfg.enabledShares : [],
    shareSettings: cfg.shareSettings || {},
    shares: cfg.shares || {},
  };
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(safeConfig, null, 2), 'utf8');
}

// Reset share statuses at the start of each manager session
async function resetShareStatuses() {
  const cfg = await readConfig();
  const nextShares = {};
  for (const fullPath of cfg.enabledShares || []) {
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
  console.log(`[${new Date().toISOString()}] Reset share statuses to checking for ${Object.keys(nextShares).length} required share(s)`);
}

async function getCurrentNetwork() {
  if (currentNetworkName) return currentNetworkName;
  try {
    const selfId = process.env.HOSTNAME;
    if (!selfId) throw new Error('HOSTNAME not set');
    const selfInfo = await docker.getContainer(selfId).inspect();
    const networks = selfInfo.NetworkSettings?.Networks || {};
    const first = Object.keys(networks)[0];
    if (first) {
      currentNetworkName = first;
      return currentNetworkName;
    }
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Could not determine current network: ${err.message}`);
  }
  // Fallback: default bridge
  currentNetworkName = 'bridge';
  return currentNetworkName;
}

function getCheckerImage() {
  const lines = fs.readFileSync(CHECKER_IMAGE_FILE, 'utf8').split('\n');
  for (const line of lines) {
    if (line.startsWith('ghcr.io/saltedlolly/abs-network-shares-checker@sha256:')) {
      return line.trim();
    }
  }
  throw new Error('Could not find abs-network-shares-checker image reference in abs-network-shares-checker-image.txt');
}

// Dynamically read abs-server image reference from abs-server-image.txt
function getAbsServerImage() {
  // abs-server-image.txt is in the same folder as this script (inside the container)
  const imageFile = path.resolve(__dirname, 'abs-server-image.txt');
  const lines = fs.readFileSync(imageFile, 'utf8').split('\n');
  for (const line of lines) {
    if (line.startsWith('ghcr.io/advplyr/audiobookshelf:')) {
      return line.trim();
    }
  }
  throw new Error('Could not find Audiobookshelf image reference in abs-server-image.txt');
}

async function containerIsHealthy(name) {
  try {
    const container = docker.getContainer(name);
    const data = await container.inspect();
    return data.State.Health && data.State.Health.Status === 'healthy';
  } catch (e) {
    return false;
  }
}

async function pullImage(imageRef) {
  console.log(`Pulling image: ${imageRef}`);
  return new Promise((resolve, reject) => {
    docker.pull(imageRef, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        console.log(`✓ Image pulled: ${imageRef}`);
        resolve(output);
      }, (event) => {
        // Progress output (optional, can be removed if too verbose)
        if (event.status && event.id) {
          process.stdout.write(`\r${event.status}: ${event.id} ${event.progress || ''}`);
        }
      });
    });
  });
}

// Stream container stdout/stderr into this process so logs appear in app logs
const activeLogStreams = new Map();

async function streamContainerLogs(container, label) {
  // Avoid double-attaching to the same logical container label
  if (activeLogStreams.has(label)) return;

  const attach = async () => {
    try {
      const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 50 });
      activeLogStreams.set(label, stream);

      // Prefix log lines so they identify the source container in the manager logs
      const prefixWriter = (target) => ({
        write: (chunk) => {
          const text = chunk.toString();
          const lines = text.split(/\r?\n/);
          for (const line of lines) {
            if (line.length === 0) continue;
            target.write(`[${label}] ${line}\n`);
          }
        }
      });

      docker.modem.demuxStream(stream, prefixWriter(process.stdout), prefixWriter(process.stderr));

      stream.on('end', () => {
        console.warn(`[${new Date().toISOString()}] Log stream ended for ${label}`);
        activeLogStreams.delete(label);
      });

      stream.on('error', (err) => {
        console.warn(`[${new Date().toISOString()}] Log stream error for ${label}:`, err.message);
        activeLogStreams.delete(label);
      });
    } catch (err) {
      console.warn(`[${new Date().toISOString()}] Failed to stream logs for ${label}:`, err.message);
    }
  };

  await attach();
}

async function cleanupOldImages(imageRef) {
  try {
    // Extract repository name and current digest from image reference
    // Format: repo@sha256:digest or repo:tag
    const currentDigest = imageRef.includes('@sha256:')
      ? imageRef.split('@sha256:')[1]
      : null;

    if (!currentDigest) {
      console.log(`No digest found in image reference, skipping cleanup: ${imageRef}`);
      return;
    }

    // Extract repo name (e.g., "saltedlolly/abs-network-shares-checker" or "ghcr.io/advplyr/audiobookshelf")
    const repoName = imageRef.split('@')[0].split(':')[0];
    console.log(`Cleaning up old images for ${repoName} (keeping digest: ${currentDigest.substring(0, 12)}...)`);

    // List all images
    const images = await docker.listImages();

    // Find images matching this repo that don't have the current digest
    let cleaned = 0;
    for (const imgInfo of images) {
      for (const repoTag of imgInfo.RepoTags || []) {
        // Check if this image is from the same repo
        if (repoTag.startsWith(repoName + ':') || repoTag.startsWith(repoName + '@')) {
          // Skip if it's the current digest
          if (repoTag.includes(`@sha256:${currentDigest}`)) {
            console.log(`  ✓ Keeping current: ${repoTag}`);
            continue;
          }

          // Remove old image
          try {
            console.log(`  ✗ Removing old: ${repoTag}`);
            await docker.getImage(imgInfo.Id).remove({ force: true });
            cleaned++;
          } catch (err) {
            console.warn(`  ⚠ Failed to remove ${repoTag}: ${err.message}`);
          }
        }
      }
    }

    if (cleaned > 0) {
      console.log(`✓ Cleaned up ${cleaned} old image(s) for ${repoName}`);
    }
  } catch (err) {
    console.warn(`Warning: Failed to cleanup old images for ${imageRef}: ${err.message}`);
    // Don't fail the entire process if cleanup fails
  }
}


async function launchChecker() {
  // Remove if exists
  try { await docker.getContainer(CHECKER_NAME).remove({ force: true }); } catch { }
  // Pull checker image first
  const checkerImage = getCheckerImage();
  await pullImage(checkerImage);
  // Clean up old images
  await cleanupOldImages(checkerImage);
  const networkMode = await getCurrentNetwork();
  // Start abs-network-shares-checker (stays running once ready)
  const container = await docker.createContainer({
    Image: checkerImage,
    name: CHECKER_NAME,
    Hostname: CHECKER_NAME,
    Init: true,
    Env: [
      'CONFIG_FILE=/data/network-shares.json',
      'NETWORK_MOUNT_ROOT=/umbrel-network',
      'MAINTENANCE_INTERVAL_MS=900000' // 15 minutes
    ],
    HostConfig: {
      Binds: [
        `${process.env.APP_DATA_DIR}/data:/data`,
        `${process.env.UMBREL_ROOT}/network:/umbrel-network:ro`
      ],
      Init: true,
      NetworkMode: networkMode
    },
    Healthcheck: {
      Test: ['CMD', 'wget', '-qO-', 'http://localhost:8080/health'],
      Interval: 5000000000, // 5s
      Timeout: 2000000000,  // 2s
      Retries: 5,
      StartPeriod: 2000000000 // 2s
    }
  });
  await container.start();
  await streamContainerLogs(container, CHECKER_LABEL);
  return container;
}

async function ensureAbsServer() {
  // Remove if exists
  try { await docker.getContainer(ABS_SERVER_NAME).remove({ force: true }); } catch { }
  // Read image reference dynamically
  const absServerImage = getAbsServerImage();
  // Pull ABS server image first
  await pullImage(absServerImage);
  // Clean up old images
  await cleanupOldImages(absServerImage);
  const networkMode = await getCurrentNetwork();
  // Start abs-server
  const container = await docker.createContainer({
    Image: absServerImage,
    name: ABS_SERVER_NAME,
    HostConfig: {
      Binds: [
        `${process.env.APP_DATA_DIR}/data/config:/home/node/config`,
        `${process.env.APP_DATA_DIR}/data/metadata:/home/node/metadata`,
        `${process.env.UMBREL_ROOT}/home/Audiobookshelf/Audiobooks:/audiobooks`,
        `${process.env.UMBREL_ROOT}/home/Audiobookshelf/Podcasts:/podcasts`,
        `${process.env.UMBREL_ROOT}/network:/media/network`
      ],
      PortBindings: { '80/tcp': [{ HostPort: '13378' }] },
      RestartPolicy: { Name: 'on-failure' },
      Init: true,
      StopTimeout: 60,
      NetworkMode: networkMode
    },
    Env: [
      'CONFIG_PATH=/home/node/config',
      'METADATA_PATH=/home/node/metadata',
      'AUDIOBOOKSHELF_UID=1000',
      'AUDIOBOOKSHELF_GID=1000'
    ]
  });
  await container.start();
  await streamContainerLogs(container, ABS_LABEL);
  return container;
}

// Gracefully stop and remove a child container
async function stopAndRemove(name, label) {
  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 30 }).catch(() => { });
    await container.remove({ force: true }).catch(() => { });
    console.log(`[${new Date().toISOString()}] Stopped and removed ${label} (${name})`);
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Failed to stop/remove ${label} (${name}): ${err.message}`);
  }
}

async function main() {
  await resetShareStatuses();

  let absServerStarted = false;

  while (!shuttingDown) {
    // Launch checker
    await launchChecker();

    // Wait for checker to become healthy (all required shares ready) or exit
    let healthy = false;
    for (let i = 0; i < 150; i++) { // up to ~7.5 minutes (150 * 3s)
      if (shuttingDown) break;

      // If container exited, relaunch after short delay
      try {
        const data = await docker.getContainer(CHECKER_NAME).inspect();
        if (!data.State.Running) {
          const exitCode = data.State.ExitCode;
          const finishedAt = data.State.FinishedAt;
          const now = new Date().toISOString();
          console.error(`[${now}] abs-network-shares-checker exited (exit code: ${exitCode}, finished at: ${finishedAt}). Restarting in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
          break; // break out to relaunch
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error monitoring abs-network-shares-checker:`, err.message);
        await new Promise(r => setTimeout(r, 3000));
      }

      healthy = await containerIsHealthy(CHECKER_NAME);
      if (healthy) break;
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!healthy) {
      if (shuttingDown) break;
      continue; // relaunch checker loop
    }

    // Checker is healthy -> start/ensure abs-server
    if (!absServerStarted) {
      await ensureAbsServer();
      absServerStarted = true;
    }

    // Monitor both checker and abs-server
    while (!shuttingDown) {
      try {
        // If checker stops or becomes unhealthy, treat as critical failure
        const checkerHealthy = await containerIsHealthy(CHECKER_NAME);
        if (!checkerHealthy) {
          console.error(`\n${'='.repeat(80)}`);
          console.error(`[${new Date().toISOString()}] *** CRITICAL: Checker became unhealthy or stopped while abs-server was running ***`);
          console.error(`[${new Date().toISOString()}] *** Initiating graceful restart of all services ***`);
          console.error(`${'='.repeat(80)}\n`);

          // Gracefully stop services
          await stopAndRemove(ABS_SERVER_NAME, ABS_LABEL);
          await stopAndRemove(CHECKER_NAME, CHECKER_LABEL);

          // Exit manager so Docker will restart it (similar to "Restart Audiobookshelf" button)
          process.exit(1);
        }

        // Monitor abs-server
        const absContainer = docker.getContainer(ABS_SERVER_NAME);
        const data = await absContainer.inspect();
        if (!data.State.Running) {
          const exitCode = data.State.ExitCode;
          const finishedAt = data.State.FinishedAt;
          const now = new Date().toISOString();
          console.error(`[${now}] abs-server exited (exit code: ${exitCode}, finished at: ${finishedAt}). Restarting...`);
          await ensureAbsServer();
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error monitoring services:`, err.message);
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    if (shuttingDown) break;
    // Loop will relaunch checker
  }
}

main().catch(e => { console.error(e); process.exit(1); });

// Handle shutdown so child containers stop when the app stops
const handleSignal = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${new Date().toISOString()}] Received ${signal}, stopping child containers...`);
  await stopAndRemove(CHECKER_NAME, CHECKER_LABEL);
  await stopAndRemove(ABS_SERVER_NAME, ABS_LABEL);
  process.exit(0);
};

process.on('SIGTERM', () => { handleSignal('SIGTERM'); });
process.on('SIGINT', () => { handleSignal('SIGINT'); });
