#!/bin/sh
set -e

CONFIG_FILE="/data/config/npm-settings.env"
CROWDSEC_CONF="/data/crowdsec/crowdsec.conf"

echo "========================================"
echo "NPMplus Wrapper - Companion App Framework"
echo "========================================"

# ============================================================
# Auto-detect companion apps
# ============================================================
echo ""
echo "[Auto-Discovery] Detecting companion apps..."

# Check CrowdSec LAPI
if wget -q --spider --timeout=2 http://host.docker.internal:8080/health 2>/dev/null; then
    CROWDSEC_DETECTED=true
    echo "[Auto-Discovery] ✓ CrowdSec detected (LAPI responding on :8080)"
else
    CROWDSEC_DETECTED=false
    echo "[Auto-Discovery] ○ CrowdSec not detected"
fi

# Check Authentik
if wget -q --spider --timeout=2 http://host.docker.internal:9000/application/o/npmplus/.well-known/openid-configuration 2>/dev/null; then
    AUTHENTIK_DETECTED=true
    echo "[Auto-Discovery] ✓ Authentik detected (OIDC responding on :9000)"
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

        # Read the existing config template
        sed -i 's/^ENABLED=.*/ENABLED=true/' "$CROWDSEC_CONF"
        sed -i "s|^API_URL=.*|API_URL=${CROWDSEC_LAPI_URL:-http://host.docker.internal:8080}|" "$CROWDSEC_CONF"
        sed -i "s|^API_KEY=.*|API_KEY=${APP_SALTEDLOLLY_CROWDSEC_NPMPLUS_BOUNCER_KEY}|" "$CROWDSEC_CONF"
        sed -i "s|^APPSEC_URL=.*|APPSEC_URL=${CROWDSEC_APPSEC_URL:-http://host.docker.internal:7422}|" "$CROWDSEC_CONF"

        echo "[CrowdSec] ✓ Bouncer enabled"
        echo "[CrowdSec]   LAPI: ${CROWDSEC_LAPI_URL:-http://host.docker.internal:8080}"
        echo "[CrowdSec]   AppSec: ${CROWDSEC_APPSEC_URL:-http://host.docker.internal:7422}"
    else
        echo "[CrowdSec] Disabling bouncer integration"
        sed -i 's/^ENABLED=.*/ENABLED=false/' "$CROWDSEC_CONF"
        echo "[CrowdSec] ○ Bouncer disabled"
    fi
else
    echo "[CrowdSec] ⚠ Warning: crowdsec.conf not found at $CROWDSEC_CONF"
fi

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
    export AUTHENTIK_URL="${AUTHENTIK_URL:-http://host.docker.internal:9000}"
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
