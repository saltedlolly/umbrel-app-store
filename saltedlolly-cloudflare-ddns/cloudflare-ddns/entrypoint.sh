#!/bin/sh
set -e

# Simple wrapper that loads config from /data/cloudflare-ddns.env and restarts
# the the underlying command whenever the file changes. This avoids the need
# for the UI to control Docker via the host's docker.sock. The wrapper logs
# lifecycle events to /data/logs/cloudflare-ddns.log

LOGFILE=/data/logs/cloudflare-ddns.log
ENVFILE=/data/cloudflare-ddns.env
STATUSFILE=/data/status.json
ERROR_MSG=
LAST_SUCCESSFUL_UPDATE=

mkdir -p $(dirname "$LOGFILE")

log() {
  echo "$(date --iso-8601=seconds) $*" >> "$LOGFILE" 2>/dev/null || true
}

# Prune the log file when it grows too large to avoid unbounded disk usage.
# Configurable via LOG_MAX_SIZE_MB and LOG_MAX_LINES; defaults are safe for Umbrel devices.
prune_log() {
  max_size_mb=${LOG_MAX_SIZE_MB:-5}
  max_lines=${LOG_MAX_LINES:-10000}
  [ -f "$LOGFILE" ] || return 0
  # Determine current size in bytes (prefer coreutils stat; fallback to wc)
  if command -v stat >/dev/null 2>&1; then
    size=$(stat -c %s "$LOGFILE" 2>/dev/null || echo 0)
  else
    size=$(wc -c < "$LOGFILE" 2>/dev/null || echo 0)
  fi
  limit_bytes=$((max_size_mb * 1024 * 1024))
  if [ "$size" -gt "$limit_bytes" ]; then
    # Keep only the last N lines to preserve recent context
    tail -n "$max_lines" "$LOGFILE" > "${LOGFILE}.tmp" 2>/dev/null || true
    mv "${LOGFILE}.tmp" "$LOGFILE" 2>/dev/null || true
    echo "$(date --iso-8601=seconds) Pruned log to last ${max_lines} lines (exceeded ${max_size_mb}MB)" >> "$LOGFILE" 2>/dev/null || true
  fi
}

write_status() {
  enabled="${ENABLED:-true}"
  running="false"
  pidval=null
  status="stopped"
  if [ -n "$child" ]; then
    if kill -0 "$child" 2>/dev/null; then
      running="true"
      pidval=$child
    fi
  fi
  if [ "$enabled" = "true" ]; then
    # Accept CLOUDFLARE_API_TOKEN + DOMAINS only (legacy ZONE/SUBDOMAIN removed)
    if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then
      if [ -n "${API_KEY}" ]; then
        CLOUDFLARE_API_TOKEN="$API_KEY"
      fi
    fi
    if [ -z "${CLOUDFLARE_API_TOKEN}" ] || [ -z "${DOMAINS}" ]; then
      status="misconfigured"
      cat > "$STATUSFILE" <<EOF
{"enabled": $enabled, "running": $running, "status": "$status", "pid": $pidval, "lastStartedAt": "${LAST_STARTED_AT:-null}", "error": "missing CLOUDFLARE_API_TOKEN or DOMAINS"}
EOF
      return
    fi
    if [ "$running" = "true" ]; then
      status="running"
    else
      status="starting"
    fi
  else
    status="disabled"
  fi
  # include lastSuccessfulUpdate and error if present
  if [ -n "${LAST_SUCCESSFUL_UPDATE}" ]; then
    lastSuccessJson="\"${LAST_SUCCESSFUL_UPDATE}\""
  else
    lastSuccessJson=null
  fi
  if [ -n "${ERROR_MSG}" ]; then
    errorJson="\"${ERROR_MSG}\""
  else
    errorJson=null
  fi
  cat > "$STATUSFILE" <<EOF
{"enabled": $enabled, "running": $running, "status": "$status", "pid": $pidval, "lastStartedAt": "${LAST_STARTED_AT:-null}", "lastSuccessfulUpdate": ${lastSuccessJson}, "error": ${errorJson}}
EOF
}

load_env() {
  if [ -f "$ENVFILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENVFILE"
    set +a
    # Normalize common 'undefined' values that can be accidentally written
    if [ "$ENABLED" = "undefined" ]; then
      unset ENABLED
    fi
    if [ "$PROXIED" = "undefined" ]; then
      unset PROXIED
    fi
    if [ "$API_KEY" = "undefined" ]; then
      unset API_KEY
    fi
    if [ "$CLOUDFLARE_API_TOKEN" = "undefined" ]; then
      unset CLOUDFLARE_API_TOKEN
    fi
    if [ "$DOMAINS" = "undefined" ]; then
      unset DOMAINS
    fi
  fi
}

set_env_var() {
  key="$1"; value="$2"
  if [ -f "$ENVFILE" ]; then
    # Avoid rewriting the file (and updating mtime) when the value is unchanged
    existing=$(grep -E "^$key=" "$ENVFILE" 2>/dev/null | head -n1 | sed 's/^[^=]*=//') || existing=""
    if [ "$existing" = "$value" ]; then
      return 0
    fi
    if grep -q "^$key=" "$ENVFILE" 2>/dev/null; then
      sed -i "s/^$key=.*/$key=$value/" "$ENVFILE" 2>/dev/null || true
    else
      echo "$key=$value" >> "$ENVFILE"
    fi
  else
    echo "$key=$value" > "$ENVFILE"
  fi
}

check_for_token_error() {
  # scan last lines of logfile for Cloudflare auth/token related errors
  load_env
  # If token is missing, prefer a clear "missing" error (overrides stale invalid)
  if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then
    set_env_var ENABLED false
    if [ "$ERROR_MSG" != "Missing Cloudflare API token" ]; then
      ERROR_MSG="Missing Cloudflare API token"
      stop_child
      write_status
    fi
    return 0
  fi
  if [ ! -f "$LOGFILE" ]; then
    return 1
  fi
  txt=$(tail -n 200 "$LOGFILE" 2>/dev/null || true)
  # Find the most recent "NEW TOKEN CONFIGURED" marker, if any
  # Only check for errors AFTER this marker (ignore old errors from previous tokens)
  marker_line=$(echo "$txt" | grep -n "NEW TOKEN CONFIGURED" | tail -1 | cut -d: -f1)
  if [ -n "$marker_line" ]; then
    # Only scan lines after the marker
    txt=$(echo "$txt" | tail -n +$((marker_line + 1)))
  fi
  if echo "$txt" | grep -Ei "Needs either CLOUDFLARE_API_TOKEN|Invalid request headers|Invalid request header|Invalid or missing authentication|403|401|Unauthorized|permission denied|invalid auth|invalid token" >/dev/null 2>&1; then
    log "Detected Cloudflare API token/auth error in logs; disabling service and stopping child"
    set_env_var ENABLED false
    # mark error for status file so UI can show a clear message
    ERROR_MSG="Invalid Cloudflare API token"
    # reload env to get updated flag and unset token if necessary
    load_env
    stop_child
    write_status
    return 0
  fi
  # No error found - clear any previous error message
  if [ -n "$ERROR_MSG" ]; then
    ERROR_MSG=""
    write_status
  fi
  return 1
}

check_for_update() {
  if [ ! -f "$LOGFILE" ]; then
    return 1
  fi
  txt=$(tail -n 200 "$LOGFILE" 2>/dev/null || true)
  # detect lines indicating a successful *change* (not 'already up to date')
  # match patterns like: "record was updated", "set the IP address", "A records.*updated" etc.
  # exclude: "already up to date", "unchanged", "no change"
  if echo "$txt" | grep -Eqi "(a records.*were|updated.*record|record.*updated|set the ip|successfully updated|update successful)" | grep -Eqvi "already up to date|unchanged|no change"; then
    # Use current time as success time
    LAST_SUCCESSFUL_UPDATE=$(date --iso-8601=seconds)
    ERROR_MSG=""
    write_status
    return 0
  fi
  return 1
}

start_child() {
  # Validate minimum config before starting the child; CLOUDFLARE_API_TOKEN and DOMAINS are required
  if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then
    if [ -n "${API_KEY}" ]; then
      CLOUDFLARE_API_TOKEN="$API_KEY"
    fi
  fi
  if [ -z "${CLOUDFLARE_API_TOKEN}" ] || [ -z "${DOMAINS}" ]; then
    log "Config invalid: missing CLOUDFLARE_API_TOKEN or DOMAINS; not starting child"
    LAST_STARTED_AT="null"
    write_status
    return 1
  fi

  # Build the start command. If the wrapper was invoked with args, use them; otherwise
  # try to detect favonia `ddns` or fallback to legacy `ddclient`.
  if [ "$#" -gt 0 ]; then
    CMD="$*"
  else
    if command -v ddns >/dev/null 2>&1; then
      CMD="ddns --foreground"
    elif command -v ddclient >/dev/null 2>&1; then
      CMD="ddclient --foreground"
    elif [ -x /usr/local/bin/ddclient ]; then
      CMD="/usr/local/bin/ddclient --foreground"
    else
      log "No start command found and ddclient not present; not starting child"
      return 1
    fi
  fi
  log "Starting: $CMD"
  # Clear any previous error message when starting a new child
  ERROR_MSG=""
  # Redirect child stdout/stderr to the logfile so healthchecks can detect updates
  sh -c "$CMD" >> "$LOGFILE" 2>&1 &
  child=$!
  LAST_STARTED_AT=$(date --iso-8601=seconds)
  write_status
  # Start a tail process to stream the log to container stdout for easier `docker logs`
  if [ -z "$tail_pid" ] || ! kill -0 "$tail_pid" 2>/dev/null; then
    tail -F "$LOGFILE" 2>/dev/null &
    tail_pid=$!
  fi
}

stop_child() {
  if [ -n "$child" ]; then
    log "Stopping pid $child"
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    child=""
    write_status
  fi
}

stop_tail() {
  if [ -n "$tail_pid" ]; then
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
    tail_pid=""
  fi
}

cleanup() {
  stop_child
  stop_tail
  log "Exiting wrapper"
  write_status
  exit 0
}

trap 'cleanup' INT TERM

# Initial environment & child
load_env
# Log loaded configuration (avoid logging secrets)
log "Loaded config: PROXIED=${PROXIED:-''} CLOUDFLARE_API_TOKEN_SET=${CLOUDFLARE_API_TOKEN:+true} ENABLED=${ENABLED:-'unset'}"
if [ -z "${ENABLED}" ] || [ "$ENABLED" = "true" ]; then
  start_child "$@" || true
else
  log "ENABLED=false; not starting child"
fi
LAST_STARTED_AT=$(date --iso-8601=seconds)
write_status

# compute last mtime if env exists
last_mtime=0
if [ -f "$ENVFILE" ]; then
  if command -v stat >/dev/null 2>&1; then
    last_mtime=$(stat -c %Y "$ENVFILE" 2>/dev/null || 0)
  else
    last_mtime=$(date -r "$ENVFILE" +%s 2>/dev/null || 0)
  fi
fi

restart_count=0
restart_window_start=0
# Polling loop: check for env file changes and restart the child when changed
while true; do
  sleep 3
  # Periodically prune log to avoid unlimited growth
  prune_log || true
  cur_mtime=0
  if [ -f "$ENVFILE" ]; then
    if command -v stat >/dev/null 2>&1; then
      cur_mtime=$(stat -c %Y "$ENVFILE" 2>/dev/null || 0)
    else
      cur_mtime=$(date -r "$ENVFILE" +%s 2>/dev/null || 0)
    fi
  fi
  # scan logs for token/auth problems and disable the service if detected
  check_for_token_error || true
  check_for_update || true
  if [ "$cur_mtime" != "$last_mtime" ]; then
    log "Config changed, reloading"
    load_env
    # Respect ENABLED flag: stop child if ENABLED set to false
    if [ "$ENABLED" = "false" ]; then
      stop_child
      LAST_STARTED_AT="null"
    else
      stop_child
      if start_child "$@"; then
        restart_count=0
        restart_window_start=0
      fi
      LAST_STARTED_AT=$(date --iso-8601=seconds)
    fi
    write_status
    last_mtime=$cur_mtime
  fi
  # If child died unexpectedly, re-exec it once
  if [ -n "$child" ]; then
      if ! kill -0 "$child" 2>/dev/null; then
      log "Child $child exited unexpectedly, restarting"
      # If the log shows a token/auth issue, disable and don't restart
      if check_for_token_error; then
        log "Token/auth error detected; not restarting child"
        continue
      fi
      check_for_update || true
      # implement a small backoff if crash loops happen too frequently
      now=$(date +%s)
      if [ "$restart_window_start" -eq 0 ] || [ $((now - restart_window_start)) -gt 60 ]; then
        restart_window_start=$now
        restart_count=0
      fi
      restart_count=$((restart_count + 1))
      if [ "$restart_count" -gt 5 ]; then
        log "Child has restarted $restart_count times within a minute; pausing before restart"
        sleep 10
      fi
      start_child "$@" || true
      LAST_STARTED_AT=$(date --iso-8601=seconds)
      write_status
    fi
  fi
done

