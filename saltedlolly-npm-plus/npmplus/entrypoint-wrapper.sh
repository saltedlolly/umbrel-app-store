#!/bin/sh
set -e

CONFIG_FILE="/data/config/npm-settings.env"
CROWDSEC_CONF="/data/crowdsec/crowdsec.conf"

echo "========================================"
echo "NPMplus Wrapper - Companion App Framework"
echo "========================================"

# ============================================================
# Detect Docker host gateway IP
# ============================================================
# Get the default gateway IP (Docker host)
DOCKER_HOST_IP=$(ip route | grep default | awk '{print $3}')
if [ -z "$DOCKER_HOST_IP" ]; then
    # Fallback to common Docker gateway
    DOCKER_HOST_IP="172.17.0.1"
fi
echo "[Network] Docker host gateway: $DOCKER_HOST_IP"

# ============================================================
# Auto-detect companion apps
# ============================================================
echo ""
echo "[Auto-Discovery] Detecting companion apps..."

# Check CrowdSec LAPI (port 8080)
# Use wget to check if LAPI is responding
if wget -q --spider --timeout=2 "http://${DOCKER_HOST_IP}:8080/health" 2>/dev/null || \
   wget -q --spider --timeout=2 "http://${DOCKER_HOST_IP}:8080" 2>/dev/null; then
    CROWDSEC_DETECTED=true
    echo "[Auto-Discovery] ✓ CrowdSec detected (LAPI responding on ${DOCKER_HOST_IP}:8080)"
else
    CROWDSEC_DETECTED=false
    echo "[Auto-Discovery] ○ CrowdSec not detected"
fi

# Check Authentik
if wget -q --spider --timeout=2 "http://${DOCKER_HOST_IP}:9000/application/o/npmplus/.well-known/openid-configuration" 2>/dev/null; then
    AUTHENTIK_DETECTED=true
    echo "[Auto-Discovery] ✓ Authentik detected (OIDC responding on ${DOCKER_HOST_IP}:9000)"
else
    AUTHENTIK_DETECTED=false
    echo "[Auto-Discovery] ○ Authentik not detected"
fi

# ============================================================
# Load user configuration
# ============================================================
echo ""
echo "[Configuration] Loading user preferences..."

if [ -f "$CONFIG_FILE" ]; then
    echo "[Configuration] Reading $CONFIG_FILE"
    # Source the config file safely
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
else
    echo "[Configuration] No config file found, using defaults"
    PROXY_MODE="none"
    CROWDSEC_ENABLED="auto"
    AUTHENTIK_ENABLED="auto"
fi

# ============================================================
# Configure Trusted Proxy (existing functionality)
# ============================================================
echo ""
echo "[Trusted Proxy] Configuring proxy trust settings..."

case "${PROXY_MODE:-none}" in
    cloudflare)
        export TRUST_CLOUDFLARE=true
        export TRUST_IP=""
        echo "[Trusted Proxy] Mode: Cloudflare (TRUST_CLOUDFLARE=true)"
        ;;
    custom)
        export TRUST_CLOUDFLARE=false
        export TRUST_IP="${TRUST_IP}"
        echo "[Trusted Proxy] Mode: Custom (TRUST_IP=${TRUST_IP})"
        ;;
    none|*)
        export TRUST_CLOUDFLARE=false
        export TRUST_IP=""
        echo "[Trusted Proxy] Mode: None (direct connections)"
        ;;
esac

# ============================================================
# Configure CrowdSec Integration
# ============================================================
echo ""
echo "[CrowdSec] Configuring integration..."

# Determine if CrowdSec should be enabled
case "${CROWDSEC_ENABLED:-auto}" in
    auto)
        CROWDSEC_EFFECTIVE=$CROWDSEC_DETECTED
        echo "[CrowdSec] Mode: Auto (detected=$CROWDSEC_DETECTED)"
        ;;
    true)
        CROWDSEC_EFFECTIVE=true
        echo "[CrowdSec] Mode: Force enabled"
        ;;
    false)
        CROWDSEC_EFFECTIVE=false
        echo "[CrowdSec] Mode: Disabled by user"
        ;;
    *)
        CROWDSEC_EFFECTIVE=$CROWDSEC_DETECTED
        echo "[CrowdSec] Mode: Unknown setting, defaulting to auto"
        ;;
esac

# Write CrowdSec configuration
if [ -f "$CROWDSEC_CONF" ]; then
    if [ "$CROWDSEC_EFFECTIVE" = "true" ]; then
        echo "[CrowdSec] Enabling bouncer integration"

        # Always use detected gateway IP (ignore any env vars with old host.docker.internal)
        CROWDSEC_LAPI_URL="http://${DOCKER_HOST_IP}:8080"

        # Only use AppSec (WAF) if CrowdSec's listener is actually up - older
        # CrowdSec app versions don't run it
        if nc -z -w 2 "$DOCKER_HOST_IP" 7422 2>/dev/null; then
            CROWDSEC_APPSEC_ENABLED=true
            CROWDSEC_APPSEC_URL="http://${DOCKER_HOST_IP}:7422"
        else
            CROWDSEC_APPSEC_ENABLED=false
            CROWDSEC_APPSEC_URL=""
        fi

        # Write the config
        sed -i 's/^ENABLED=.*/ENABLED=true/' "$CROWDSEC_CONF"
        sed -i "s|^API_URL=.*|API_URL=${CROWDSEC_LAPI_URL}|" "$CROWDSEC_CONF"
        sed -i "s|^API_KEY=.*|API_KEY=${APP_SALTEDLOLLY_CROWDSEC_NPMPLUS_BOUNCER_KEY}|" "$CROWDSEC_CONF"
        sed -i "s|^APPSEC_URL=.*|APPSEC_URL=${CROWDSEC_APPSEC_URL}|" "$CROWDSEC_CONF"
        # If AppSec is unreachable or errors, let the request through rather
        # than blocking it. NPMplus ships `deny`, which banned every visitor
        # while AppSec wasn't running (r1.12).
        sed -i "s|^APPSEC_FAILURE_ACTION=.*|APPSEC_FAILURE_ACTION=passthrough|" "$CROWDSEC_CONF"

        echo "[CrowdSec] ✓ Bouncer enabled"
        echo "[CrowdSec]   LAPI: ${CROWDSEC_LAPI_URL}"
        if [ "$CROWDSEC_APPSEC_ENABLED" = "true" ]; then
            echo "[CrowdSec]   AppSec: ${CROWDSEC_APPSEC_URL} (on failure: passthrough)"
        else
            echo "[CrowdSec]   AppSec: disabled (not listening on ${DOCKER_HOST_IP}:7422)"
        fi
    else
        echo "[CrowdSec] Disabling bouncer integration"
        sed -i 's/^ENABLED=.*/ENABLED=false/' "$CROWDSEC_CONF"
        echo "[CrowdSec] ○ Bouncer disabled"
    fi
else
    echo "[CrowdSec] ⚠ Warning: crowdsec.conf not found at $CROWDSEC_CONF"
fi

# Forward access logs to CrowdSec over syslog so it can detect patterns
# across requests (scanners, brute force). nginx includes conf.d/*.conf in
# its http block and no proxy host sets its own access_log, so this applies
# to every host alongside the normal log file. Uses the same `alog` format
# as access.log; CrowdSec's ZoeyVid/npmplus-logs parser matches the
# `npmplus` tag. UDP to a port nobody listens on is simply dropped, so this
# is harmless with CrowdSec versions that don't receive logs.
# This file lives in the container, not /data, so it's rebuilt every start.
CROWDSEC_SYSLOG_CONF="/usr/local/nginx/conf/conf.d/crowdsec-syslog.conf"
if [ -f "$CROWDSEC_CONF" ] && [ "$CROWDSEC_EFFECTIVE" = "true" ]; then
    echo "access_log syslog:server=${DOCKER_HOST_IP}:4242,tag=npmplus alog;" > "$CROWDSEC_SYSLOG_CONF"
    CROWDSEC_LOG_SHARING=true
    echo "[CrowdSec]   Logs: syslog to ${DOCKER_HOST_IP}:4242"
else
    rm -f "$CROWDSEC_SYSLOG_CONF"
    CROWDSEC_LOG_SHARING=false
fi

# Publish the bouncer state for the launcher, which can't see crowdsec.conf.
# No secrets here - the launcher mounts this directory read-only.
STATUS_DIR="/data/integration-status"
mkdir -p "$STATUS_DIR"
if [ -f "$CROWDSEC_CONF" ] && [ "$CROWDSEC_EFFECTIVE" = "true" ]; then
    CROWDSEC_BOUNCER_ENABLED=true
else
    CROWDSEC_BOUNCER_ENABLED=false
fi
cat > "$STATUS_DIR/crowdsec.env.tmp" <<EOF
BOUNCER_ENABLED=${CROWDSEC_BOUNCER_ENABLED}
MODE=${CROWDSEC_ENABLED:-auto}
DETECTED_AT_START=${CROWDSEC_DETECTED}
LAPI_URL=${CROWDSEC_LAPI_URL:-}
APPSEC_ENABLED=${CROWDSEC_APPSEC_ENABLED:-false}
LOG_SHARING=${CROWDSEC_LOG_SHARING}
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
mv "$STATUS_DIR/crowdsec.env.tmp" "$STATUS_DIR/crowdsec.env"

# ============================================================
# Configure Authentik Integration
# ============================================================
echo ""
echo "[Authentik] Configuring SSO integration..."

# Determine if Authentik should be enabled
case "${AUTHENTIK_ENABLED:-auto}" in
    auto)
        AUTHENTIK_EFFECTIVE=$AUTHENTIK_DETECTED
        echo "[Authentik] Mode: Auto (detected=$AUTHENTIK_DETECTED)"
        ;;
    true)
        AUTHENTIK_EFFECTIVE=true
        echo "[Authentik] Mode: Force enabled"
        ;;
    false)
        AUTHENTIK_EFFECTIVE=false
        echo "[Authentik] Mode: Disabled by user"
        ;;
    *)
        AUTHENTIK_EFFECTIVE=$AUTHENTIK_DETECTED
        echo "[Authentik] Mode: Unknown setting, defaulting to auto"
        ;;
esac

if [ "$AUTHENTIK_EFFECTIVE" = "true" ]; then
    echo "[Authentik] Enabling SSO integration"
    # Always use detected gateway IP (ignore any env vars with old host.docker.internal)
    AUTHENTIK_URL="http://${DOCKER_HOST_IP}:9000"
    export AUTHENTIK_URL
    export AUTHENTIK_CLIENT_ID="${APP_SALTEDLOLLY_NPM_PLUS_AUTHENTIK_CLIENT_ID}"
    export AUTHENTIK_CLIENT_SECRET="${APP_SALTEDLOLLY_NPM_PLUS_AUTHENTIK_CLIENT_SECRET}"
    echo "[Authentik] ✓ SSO enabled"
    echo "[Authentik]   URL: $AUTHENTIK_URL"
else
    echo "[Authentik] ○ SSO disabled"
fi

# ============================================================
# Enable log rotation (required for CrowdSec log parsing)
# ============================================================
export LOGROTATE=true
echo ""
echo "[Logging] Log rotation: ENABLED (required for CrowdSec)"

# ============================================================
# Summary
# ============================================================
echo ""
echo "========================================"
echo "Configuration Summary"
echo "========================================"
echo "Trusted Proxy: ${PROXY_MODE:-none}"
echo "  TRUST_CLOUDFLARE: ${TRUST_CLOUDFLARE}"
echo "  TRUST_IP: ${TRUST_IP}"
echo ""
echo "CrowdSec Protection: $([ "$CROWDSEC_EFFECTIVE" = "true" ] && echo "ENABLED" || echo "DISABLED")"
echo "Authentik SSO: $([ "$AUTHENTIK_EFFECTIVE" = "true" ] && echo "ENABLED" || echo "DISABLED")"
echo "Log Rotation: ENABLED"
echo "========================================"
echo ""

# ============================================================
# Start NPMplus
# ============================================================
echo "[Startup] Launching NPMplus..."
echo ""

# Execute original NPMplus entrypoint
# The NPMplus image uses tini with entrypoint.sh
exec tini -- entrypoint.sh
