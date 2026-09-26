#!/bin/sh
set -e

CONFIG_FILE="/data/config/npm-settings.env"
DEFAULT_TRUST_CLOUDFLARE="false"
DEFAULT_TRUST_IP=""

echo "[NPMplus Wrapper] Starting NPMplus with trusted proxy configuration..."

# Load settings from config file if it exists
if [ -f "$CONFIG_FILE" ]; then
    echo "[NPMplus Wrapper] Loading configuration from $CONFIG_FILE"

    # Source the config file safely
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"

    # Export based on PROXY_MODE
    case "${PROXY_MODE:-none}" in
        cloudflare)
            export TRUST_CLOUDFLARE=true
            echo "[NPMplus Wrapper] Cloudflare proxy mode enabled (TRUST_CLOUDFLARE=true)"
            ;;
        custom)
            export TRUST_CLOUDFLARE=false
            export TRUST_IP="${TRUST_IP}"
            echo "[NPMplus Wrapper] Custom trusted proxy mode (TRUST_IP=${TRUST_IP})"
            ;;
        none|*)
            export TRUST_CLOUDFLARE=false
            export TRUST_IP=""
            echo "[NPMplus Wrapper] No trusted proxy configured (direct mode)"
            ;;
    esac
else
    echo "[NPMplus Wrapper] No configuration file found at $CONFIG_FILE"
    echo "[NPMplus Wrapper] Using default settings (no trusted proxy)"
    export TRUST_CLOUDFLARE="$DEFAULT_TRUST_CLOUDFLARE"
    export TRUST_IP="$DEFAULT_TRUST_IP"
fi

# Log effective configuration
echo "[NPMplus Wrapper] Effective configuration:"
echo "[NPMplus Wrapper]   TRUST_CLOUDFLARE=${TRUST_CLOUDFLARE}"
echo "[NPMplus Wrapper]   TRUST_IP=${TRUST_IP}"
echo "[NPMplus Wrapper] Starting NPMplus..."
echo "----------------------------------------"

# Execute original NPMplus entrypoint
# The NPMplus image uses tini with entrypoint.sh
exec tini -- entrypoint.sh
