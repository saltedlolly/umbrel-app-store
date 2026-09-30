# NPMplus Companion Apps Integration Framework

## Overview

NPMplus for Umbrel features a **zero-configuration companion app framework** that automatically detects and integrates with security and authentication apps when they're installed. This eliminates manual configuration while maintaining full independence for each app.

## Supported Integrations

### 1. CrowdSec Security Engine
- **Purpose**: Intrusion detection, IP blocking, and WAF protection
- **Detection**: LAPI health check on `host.docker.internal:8080`
- **Features**:
  - Automatic bouncer registration using shared secrets
  - AppSec (WAF) integration for application-layer protection
  - Real-time threat blocking and ban decisions
  - Automatic log sharing for behavioral analysis

### 2. Authentik
- **Purpose**: One login for the people you share apps with. Apps with their own OpenID login connect to Authentik directly; sites with no login of their own can use NPMplus's built-in forward auth
- **Detection**: `http://<gateway>:9810/-/health/live/` (the Authentik app publishes its server on the Docker gateway at 9810)
- **What NPMplus does**: always sets `AUTH_REQUEST_AUTHENTIK_UPSTREAM=http://<gateway>:9810`, so choosing **authentik** under a proxy host's **Auth Request** works without typing an address. Nothing is protected until you choose it for a host, and each protected site also needs its own application (Proxy provider, forward auth single application) in Authentik
- **No shared secrets**: forward auth doesn't need any

## Architecture

### Auto-Discovery Pattern

```
NPMplus Startup:
├─ Check for CrowdSec (wget http://host.docker.internal:8080/health)
├─ Check for Authentik (wget http://<gateway>:9810/-/health/live/)
├─ Load user preferences from /data/config/npm-settings.env
├─ Determine effective state (auto/true/false)
├─ Configure integrations:
│  ├─ CrowdSec: Update /data/crowdsec/crowdsec.conf with API keys
│  └─ Authentik: set AUTH_REQUEST_AUTHENTIK_UPSTREAM (always), write integration-status/authentik.env
└─ Start NPMplus with configured integrations
```

### Configuration States

Each integration supports three states:

| State | Behavior |
|-------|----------|
| `auto` (default) | Enable if detected, disable if not |
| `true` | Force enable (warns if not detected) |
| `false` | User disabled, ignore detection |

### Shared Secrets

Integrations use deterministic secrets generated from app entropy:

```bash
# CrowdSec bouncer key (both apps derive it from the same entropy string)
APP_SALTEDLOLLY_CROWDSEC_NPMPLUS_BOUNCER_KEY
```

These secrets are:
- ✅ Deterministic (survive app restarts/updates)
- ✅ Unique per Umbrel instance
- ✅ Never transmitted over network
- ✅ Shared only between companion apps via Umbrel's environment system

## File Structure

```
saltedlolly-npm-plus/
├── launcher/
│   ├── server.js                    # Node.js API server
│   │   ├── GET  /api/integrations/status
│   │   └── POST /api/integrations
│   └── public/
│       ├── index.html               # UI with integrations section
│       └── style.css                # Styles for integration cards
│
├── npmplus/
│   ├── Dockerfile                   # Wrapper image
│   └── entrypoint-wrapper.sh        # Auto-discovery & configuration
│
├── docker-compose.yml               # Container definitions
├── exports.sh                       # Secret generation
└── INTEGRATIONS-FRAMEWORK.md        # This file
```

## Configuration File Format

**File**: `/data/config/npm-settings.env`

```bash
# Trusted Proxy Configuration
PROXY_MODE=cloudflare
TRUST_CLOUDFLARE=false
TRUST_IP=

# CrowdSec Integration
CROWDSEC_ENABLED=auto
CROWDSEC_LAPI_URL=http://host.docker.internal:8080
CROWDSEC_APPSEC_URL=http://host.docker.internal:7422

CONFIG_VERSION=2
```

## Launcher UI

The launcher presents a **Security & Authentication Integrations** section with:

### When Integration Detected
```
┌─────────────────────────────────────┐
│ 🚨 CrowdSec Security Engine         │
│ ✓ Detected and available            │
│                                     │
│ [✓] Enable CrowdSec Protection      │
│                                     │
│ Threats Blocked (24h): 127          │
│ Active Bans: 23                     │
│ Last Sync: 2 minutes ago            │
│                                     │
│ [Open CrowdSec Dashboard]           │
└─────────────────────────────────────┘
```

### When Integration Not Detected
```
┌─────────────────────────────────────┐
│ 🚨 CrowdSec Security Engine         │
│ ○ Not detected                      │
│                                     │
│ CrowdSec provides intrusion         │
│ detection and IP blocking.          │
│                                     │
│ [Install CrowdSec App]              │
└─────────────────────────────────────┘
```

## Implementation Timeline

### Phase 1: CrowdSec Integration ✓ (Framework Ready)
- [x] Framework design complete
- [x] UI implementation complete
- [x] API endpoints implemented
- [x] Wrapper script with auto-discovery
- [ ] Build and test launcher image
- [ ] Build and test wrapper image
- [ ] Test integration with CrowdSec app
- [ ] Verify log sharing works
- [ ] Verify AppSec protection works
- [ ] Verify bouncer blocking works

### Phase 2: Authentik Integration
- [x] Build Authentik Umbrel app
- [x] Part 1: detection on :9810, forward auth upstream always set, launcher card (no on/off switch: forward auth is chosen per proxy host)
- [ ] Part 2: setup checklist in the launcher, count of hosts using Authentik, warning when hosts use Authentik but it isn't responding, docs for apps that keep Umbrel's own login
- [ ] Test forward auth end to end on a proxy host (including Authentik stopped: the site errors, never opens)

## CrowdSec Integration Details

### Log Sharing (NPMplus → CrowdSec)
CrowdSec app mounts NPMplus logs read-only:
```yaml
volumes:
  - ${APP_SALTEDLOLLY_NPM_PLUS_DATA_DIR}/data/nginx/logs:/var/log/npmplus:ro
```

NPMplus enables log rotation:
```bash
export LOGROTATE=true
```

CrowdSec acquisition config (`/etc/crowdsec/acquis.d/npmplus.yaml`):
```yaml
source: file
filenames:
  - /var/log/npmplus/*.log
labels:
  type: npmplus
```

### Bouncer Connection (CrowdSec LAPI → NPMplus)
CrowdSec exposes LAPI on localhost:
```yaml
ports:
  - "127.0.0.1:8080:8080"
```

NPMplus accesses via `host.docker.internal`:
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

NPMplus wrapper configures `/data/crowdsec/crowdsec.conf`:
```bash
ENABLED=true
API_URL=http://host.docker.internal:8080
API_KEY=${APP_SALTEDLOLLY_CROWDSEC_NPMPLUS_BOUNCER_KEY}
```

### AppSec Connection (NPMplus → CrowdSec AppSec)
CrowdSec exposes AppSec on localhost:
```yaml
ports:
  - "127.0.0.1:7422:7422"
```

NPMplus wrapper configures AppSec:
```bash
APPSEC_URL=http://host.docker.internal:7422
```

## Security Model

### Localhost-Only Ports
- ✅ LAPI (8080) and AppSec (7422) bound to `127.0.0.1`
- ✅ Not exposed to LAN or Internet
- ✅ Accessible only via Docker's host-gateway

### Read-Only Log Sharing
- ✅ CrowdSec mounts NPMplus logs with `:ro` flag
- ✅ Cannot modify or delete NPMplus data
- ✅ Scoped to `/data/nginx/logs` only

### Deterministic Secrets
- ✅ Generated from app-specific entropy
- ✅ Unique per Umbrel instance
- ✅ No manual copying required
- ✅ Survive app restarts and updates

### Fail-Safe Behavior
- ✅ NPMplus works without CrowdSec installed
- ✅ NPMplus works without Authentik installed
- ✅ CrowdSec works without NPMplus installed
- ✅ Detection failure defaults to disabled state
- ✅ Configuration errors logged but non-fatal

## Adding New Integrations

To add a new companion app integration:

1. **Add detection in `entrypoint-wrapper.sh`**:
   ```bash
   if wget -q --spider --timeout=2 http://host.docker.internal:PORT/health; then
       NEWAPP_DETECTED=true
   else
       NEWAPP_DETECTED=false
   fi
   ```

2. **Add configuration section in `entrypoint-wrapper.sh`**:
   ```bash
   case "${NEWAPP_ENABLED:-auto}" in
       auto) NEWAPP_EFFECTIVE=$NEWAPP_DETECTED ;;
       true) NEWAPP_EFFECTIVE=true ;;
       false) NEWAPP_EFFECTIVE=false ;;
   esac
   ```

3. **Add secrets to `exports.sh`**:
   ```bash
   export APP_SALTEDLOLLY_NPM_PLUS_NEWAPP_SECRET="$(derive_entropy "${app_entropy_identifier}-newapp")"
   ```

4. **Add UI section to `launcher/public/index.html`**:
   ```html
   <div class="integration-section" id="newappSection">
       <!-- Integration card HTML -->
   </div>
   ```

5. **Add API endpoint to `launcher/server.js`**:
   ```javascript
   newapp: {
       detected: await checkServiceAvailable('host.docker.internal', PORT),
       enabled: newappEnabled,
       metrics: /* ... */
   }
   ```

6. **Update configuration file structure in `server.js`**:
   ```javascript
   NEWAPP_ENABLED=${config.NEWAPP_ENABLED || 'auto'}
   NEWAPP_URL=${config.NEWAPP_URL || 'http://host.docker.internal:PORT'}
   ```

## Testing

### Manual Testing Checklist

**NPMplus Standalone** (no companion apps):
- [ ] Installs successfully
- [ ] Launcher shows "not detected" for all integrations
- [ ] NPMplus admin works normally
- [ ] Proxy hosts function correctly
- [ ] Logs are created (for future CrowdSec)

**NPMplus + CrowdSec**:
- [ ] CrowdSec shows as "detected"
- [ ] Automatic enable when both installed
- [ ] Manual disable/enable toggle works
- [ ] Bouncer blocks malicious IPs
- [ ] AppSec blocks suspicious patterns
- [ ] Metrics display in launcher
- [ ] Uninstalling CrowdSec disables integration gracefully

**NPMplus + Authentik** (future):
- [ ] Authentik shows as "detected"
- [ ] Automatic enable when both installed
- [ ] Manual disable/enable toggle works
- [ ] SSO login flow works
- [ ] Metrics display in launcher
- [ ] Uninstalling Authentik disables integration gracefully

**Multi-Integration** (future):
- [ ] Both CrowdSec and Authentik detected
- [ ] Both integrations work simultaneously
- [ ] Independent enable/disable toggles
- [ ] No conflicts between integrations

## Troubleshooting

### Integration Not Detected

**Check companion app is running**:
```bash
docker ps | grep crowdsec
docker ps | grep authentik
```

**Check port accessibility from NPMplus**:
```bash
docker exec saltedlolly-npm-plus_npmplus_1 wget -qO- http://host.docker.internal:8080/health
```

**Check NPMplus wrapper logs**:
```bash
docker logs saltedlolly-npm-plus_npmplus_1 2>&1 | grep "Auto-Discovery"
```

### Integration Enabled But Not Working

**Check configuration file**:
```bash
cat ~/umbrel/app-data/saltedlolly-npm-plus/launcher-config/npm-settings.env
```

**Check CrowdSec configuration**:
```bash
cat ~/umbrel/app-data/saltedlolly-npm-plus/data/data/crowdsec/crowdsec.conf
```

**Check environment variables**:
```bash
docker exec saltedlolly-npm-plus_npmplus_1 env | grep CROWDSEC
docker exec saltedlolly-npm-plus_npmplus_1 env | grep AUTHENTIK
```

## Future Enhancements

- [ ] Real-time metrics from CrowdSec API
- [ ] Real-time metrics from Authentik API
- [ ] Integration health monitoring
- [ ] Automatic retry on temporary connection failures
- [ ] Integration-specific troubleshooting guides
- [ ] Support for custom integration endpoints
- [ ] Integration templates for other reverse proxies (Caddy, Traefik)
