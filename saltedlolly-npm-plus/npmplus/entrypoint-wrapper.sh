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

# Companion apps are found by their ports on the Docker host. The background
# re-check near the end reuses these.
crowdsec_up() {
    wget -q --spider --timeout=2 "http://${DOCKER_HOST_IP}:8080/health" 2>/dev/null || \
        wget -q --spider --timeout=2 "http://${DOCKER_HOST_IP}:8080" 2>/dev/null
}

# The Authentik app publishes its server on the gateway at :9810 (umbreld
# itself owns host port 9000)
authentik_up() {
    wget -q --spider --timeout=2 "http://${DOCKER_HOST_IP}:9810/-/health/live/" 2>/dev/null
}

# CrowdSec's AppSec (WAF) listener. Older CrowdSec app versions don't run it.
appsec_up() {
    nc -z -w 2 "$DOCKER_HOST_IP" 7422 2>/dev/null
}

if crowdsec_up; then
    CROWDSEC_DETECTED=true
    echo "[Auto-Discovery] ✓ CrowdSec detected (LAPI responding on ${DOCKER_HOST_IP}:8080)"
else
    CROWDSEC_DETECTED=false
    echo "[Auto-Discovery] ○ CrowdSec not detected"
fi

if authentik_up; then
    AUTHENTIK_DETECTED=true
    echo "[Auto-Discovery] ✓ Authentik detected (responding on ${DOCKER_HOST_IP}:9810)"
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

STATUS_DIR="/data/integration-status"
CROWDSEC_SYSLOG_CONF="/usr/local/nginx/conf/conf.d/crowdsec-syslog.conf"
LOG_PREFIX=""

# Write the bouncer settings for CROWDSEC_EFFECTIVE. Runs now, and again from
# the background re-check if CrowdSec turns up later.
configure_crowdsec() {
    if [ -f "$CROWDSEC_CONF" ]; then
        if [ "$CROWDSEC_EFFECTIVE" = "true" ]; then
            echo "${LOG_PREFIX}[CrowdSec] Enabling bouncer integration"

            # Always use detected gateway IP (ignore any env vars with old host.docker.internal)
            CROWDSEC_LAPI_URL="http://${DOCKER_HOST_IP}:8080"

            # Only use AppSec (WAF) if CrowdSec's listener is actually up
            if appsec_up; then
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

            echo "${LOG_PREFIX}[CrowdSec] ✓ Bouncer enabled"
            echo "${LOG_PREFIX}[CrowdSec]   LAPI: ${CROWDSEC_LAPI_URL}"
            if [ "$CROWDSEC_APPSEC_ENABLED" = "true" ]; then
                echo "${LOG_PREFIX}[CrowdSec]   AppSec: ${CROWDSEC_APPSEC_URL} (on failure: passthrough)"
            else
                echo "${LOG_PREFIX}[CrowdSec]   AppSec: disabled (not listening on ${DOCKER_HOST_IP}:7422)"
            fi
        else
            echo "${LOG_PREFIX}[CrowdSec] Disabling bouncer integration"
            sed -i 's/^ENABLED=.*/ENABLED=false/' "$CROWDSEC_CONF"
            echo "${LOG_PREFIX}[CrowdSec] ○ Bouncer disabled"
        fi
    else
        echo "${LOG_PREFIX}[CrowdSec] ⚠ Warning: crowdsec.conf not found at $CROWDSEC_CONF"
    fi

    # Forward access logs to CrowdSec over syslog so it can detect patterns
    # across requests (scanners, brute force). nginx includes conf.d/*.conf in
    # its http block and no proxy host sets its own access_log, so this applies
    # to every host alongside the normal log file. Uses the same `alog` format
    # as access.log; CrowdSec's ZoeyVid/npmplus-logs parser matches the
    # `npmplus` tag. UDP to a port nobody listens on is simply dropped, so this
    # is harmless with CrowdSec versions that don't receive logs.
    # This file lives in the container, not /data, so it's rebuilt every start.
    if [ -f "$CROWDSEC_CONF" ] && [ "$CROWDSEC_EFFECTIVE" = "true" ]; then
        echo "access_log syslog:server=${DOCKER_HOST_IP}:4242,tag=npmplus alog;" > "$CROWDSEC_SYSLOG_CONF"
        CROWDSEC_LOG_SHARING=true
        echo "${LOG_PREFIX}[CrowdSec]   Logs: syslog to ${DOCKER_HOST_IP}:4242"
    else
        rm -f "$CROWDSEC_SYSLOG_CONF"
        CROWDSEC_LOG_SHARING=false
    fi

    # Publish the bouncer state for the launcher, which can't see crowdsec.conf.
    # No secrets here - the launcher mounts this directory read-only.
    mkdir -p "$STATUS_DIR"
    if [ -f "$CROWDSEC_CONF" ] && [ "$CROWDSEC_EFFECTIVE" = "true" ]; then
        CROWDSEC_BOUNCER_ENABLED=true
    else
        CROWDSEC_BOUNCER_ENABLED=false
    fi
    cat > "$STATUS_DIR/crowdsec.env.tmp" <<EOF
BOUNCER_ENABLED=${CROWDSEC_BOUNCER_ENABLED}
MODE=${CROWDSEC_ENABLED:-auto}
DETECTED_AT_START=${CROWDSEC_DETECTED_AT_START}
LAPI_URL=${CROWDSEC_LAPI_URL:-}
APPSEC_ENABLED=${CROWDSEC_APPSEC_ENABLED:-false}
LOG_SHARING=${CROWDSEC_LOG_SHARING}
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    mv "$STATUS_DIR/crowdsec.env.tmp" "$STATUS_DIR/crowdsec.env"
}

CROWDSEC_DETECTED_AT_START=$CROWDSEC_DETECTED
configure_crowdsec

# ============================================================
# Configure Authentik (forward auth)
# ============================================================
# NPMplus has built-in Authentik forward auth: choosing "authentik" under a
# proxy host's Auth Request makes nginx ask Authentik's embedded outpost
# before letting a visitor through. It needs Authentik's address, which is
# this env var unless the host sets its own "Auth Request Upstream".
# Set it even when Authentik isn't detected: with no address, a host set to
# "authentik" would get an empty nginx upstream. With it, a missing or
# stopped Authentik only affects the hosts that use it (they fail closed:
# an error page, never an unprotected site).
echo ""
AUTH_REQUEST_AUTHENTIK_UPSTREAM="http://${DOCKER_HOST_IP}:9810"
export AUTH_REQUEST_AUTHENTIK_UPSTREAM
echo "[Authentik] Forward auth upstream: ${AUTH_REQUEST_AUTHENTIK_UPSTREAM} (detected=${AUTHENTIK_DETECTED})"

# For the launcher's Authentik card (no secrets). The background re-check
# rewrites it if Authentik turns up later.
AUTHENTIK_DETECTED_AT_START=$AUTHENTIK_DETECTED
write_authentik_status() {
    cat > "$STATUS_DIR/authentik.env.tmp" <<EOF
DETECTED=${AUTHENTIK_DETECTED}
DETECTED_AT_START=${AUTHENTIK_DETECTED_AT_START}
UPSTREAM=${AUTH_REQUEST_AUTHENTIK_UPSTREAM}
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    mv "$STATUS_DIR/authentik.env.tmp" "$STATUS_DIR/authentik.env"
}
write_authentik_status

# ============================================================
# Port forwarding check for the launcher
# ============================================================
# The launcher's setup guide ticks off each router port forward once real
# visits from the internet arrive on it. The main access log can't show
# that: its host field comes from the Host header, not the port the visitor
# connected to. So log just the time, port and protocol of each visit from
# a public address (no addresses or URLs). HTTP/3.0 means UDP 443 works.
# NPMplus's logrotate handles /data/nginx/logs/*.log, this file included.
# nginx includes conf.d/*.conf in its http block and no proxy host sets its
# own access_log, so this applies to every host. Rebuilt every start.
cat > /usr/local/nginx/conf/conf.d/umbrel-port-check.conf <<'EOF'
# Written by the NPMplus for Umbrel wrapper on every start
map $remote_addr $umbrel_internet_visit {
    default 1;
    "~^(127|10)\." 0;
    "~^192\.168\." 0;
    "~^172\.(1[6-9]|2[0-9]|3[01])\." 0;
    "~^169\.254\." 0;
    "~^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\." 0;
    "~^(::1$|f[cd]|fe[89ab])" 0;
    "~^unix:" 0;
}
log_format umbrel_port_check '$msec $server_port $server_protocol';
access_log /data/nginx/logs/port-check.log umbrel_port_check if=$umbrel_internet_visit;
EOF
echo ""
echo "[Port check] Logging the port and protocol of visits from the internet for the launcher"

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
echo "CrowdSec Protection: $([ "$CROWDSEC_BOUNCER_ENABLED" = "true" ] && echo "ENABLED" || echo "DISABLED")"
echo "Authentik: $([ "$AUTHENTIK_DETECTED" = "true" ] && echo "detected" || echo "not detected") (forward auth upstream ${AUTH_REQUEST_AUTHENTIK_UPSTREAM})"
echo "Log Rotation: ENABLED"
echo "========================================"
echo ""

# ============================================================
# Keep looking for companion apps that weren't up yet
# ============================================================
# After a reboot or umbrelOS update every app starts at once, and NPMplus is
# often ready before CrowdSec or Authentik. The single check above used to
# leave CrowdSec protection off until NPMplus was next restarted. So keep
# checking in the background: every 30 seconds for the first 10 minutes,
# then every 5 minutes, which also picks up CrowdSec if it's installed after
# NPMplus. Sites keep working meanwhile.
#
# When CrowdSec answers, turn the bouncer on the way NPMplus's start.sh does
# at startup (copy its nginx block into conf.d), then reload nginx. The
# reload runs as the npmplus user: nginx runs as npmplus, and without
# CAP_KILL root here can't signal another user's process.

NGINX_CONF_D="/usr/local/nginx/conf/conf.d"

enable_crowdsec_nginx() {
    if [ ! -s "$NGINX_CONF_D/crowdsec.conf" ] && [ -s "$NGINX_CONF_D/crowdsec.conf.disabled" ]; then
        cp -a "$NGINX_CONF_D/crowdsec.conf.disabled" "$NGINX_CONF_D/crowdsec.conf"
    fi
    # sed -i above ran as root and replaced the files; give them back
    chown npmplus:npmplus "$CROWDSEC_CONF" "$NGINX_CONF_D/crowdsec.conf" "$CROWDSEC_SYSLOG_CONF" 2>/dev/null || true
}

reload_nginx() {
    output=$(su-exec npmplus nginx -s reload 2>&1)
    result=$?
    [ -n "$output" ] && echo "$output" | sed 's/^/[Re-check] nginx: /'
    return $result
}

watch_companions() {
    LOG_PREFIX="[Re-check] "
    checks=0
    reload_pending=false
    while :; do
        if [ "$checks" -lt 20 ]; then sleep 30; else sleep 300; fi
        checks=$((checks + 1))

        # crowdsec.conf is created by NPMplus's start.sh, so on a first install
        # it only exists after the wrapper has run
        if [ "$WATCH_CROWDSEC" = "true" ] && [ -f "$CROWDSEC_CONF" ] && crowdsec_up; then
            echo "[Re-check] ✓ CrowdSec is now responding on ${DOCKER_HOST_IP}:8080"
            CROWDSEC_DETECTED=true
            CROWDSEC_EFFECTIVE=true
            configure_crowdsec
            enable_crowdsec_nginx
            WATCH_CROWDSEC=false
            reload_pending=true
        elif [ "$CROWDSEC_BOUNCER_ENABLED" = "true" ] && [ "$CROWDSEC_APPSEC_ENABLED" != "true" ] && appsec_up; then
            # CrowdSec's API came up before its WAF listener. configure_crowdsec
            # checks the port again; only reload if AppSec really got turned on.
            echo "[Re-check] ✓ CrowdSec AppSec is now listening on ${DOCKER_HOST_IP}:7422"
            configure_crowdsec
            enable_crowdsec_nginx
            if [ "$CROWDSEC_APPSEC_ENABLED" = "true" ]; then
                reload_pending=true
            fi
        fi

        if [ "$WATCH_AUTHENTIK" = "true" ] && authentik_up; then
            echo "[Re-check] ✓ Authentik is now responding on ${DOCKER_HOST_IP}:9810"
            AUTHENTIK_DETECTED=true
            write_authentik_status
            WATCH_AUTHENTIK=false
        fi

        if [ "$reload_pending" = "true" ]; then
            if reload_nginx; then
                echo "[Re-check] ✓ nginx reloaded with the new CrowdSec settings"
                reload_pending=false
            else
                echo "[Re-check] ⚠ nginx reload failed, trying again at the next check"
            fi
        fi

        if [ "$WATCH_CROWDSEC" != "true" ] && [ "$WATCH_AUTHENTIK" != "true" ] && \
           [ "$reload_pending" != "true" ] && \
           { [ "$CROWDSEC_BOUNCER_ENABLED" != "true" ] || [ "$CROWDSEC_APPSEC_ENABLED" = "true" ]; }; then
            echo "[Re-check] All companion apps found, no more checks needed"
            return 0
        fi
    done
}

# CrowdSec turned off in the launcher stays off
WATCH_CROWDSEC=false
if [ "$CROWDSEC_BOUNCER_ENABLED" != "true" ] && [ "${CROWDSEC_ENABLED:-auto}" != "false" ]; then
    WATCH_CROWDSEC=true
fi
WATCH_AUTHENTIK=false
if [ "$AUTHENTIK_DETECTED" != "true" ]; then
    WATCH_AUTHENTIK=true
fi

if [ "$WATCH_CROWDSEC" = "true" ] || [ "$WATCH_AUTHENTIK" = "true" ] || \
   { [ "$CROWDSEC_BOUNCER_ENABLED" = "true" ] && [ "$CROWDSEC_APPSEC_ENABLED" != "true" ]; }; then
    echo "[Re-check] Will keep checking for companion apps in the background"
    # A failed check must not end the loop
    ( set +e; watch_companions ) &
fi

# ============================================================
# Start NPMplus
# ============================================================
echo "[Startup] Launching NPMplus..."
echo ""

# Execute original NPMplus entrypoint
# The NPMplus image uses tini with entrypoint.sh
exec tini -- entrypoint.sh
