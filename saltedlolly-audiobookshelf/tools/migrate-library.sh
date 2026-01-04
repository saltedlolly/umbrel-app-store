#!/usr/bin/env bash
#
# Audiobookshelf Library Migration Tool
# 
# This script helps you migrate your Audiobookshelf library between:
# - Official Audiobookshelf app from Umbrel App Store
# - Audiobookshelf: NAS Edition from Olly's Umbrel Community App Store
#
# The script backs up and restores:
# - Library configuration (settings, library data)
# - Metadata (database information, logs excluded)
#
# Media files (audiobooks and podcasts) are migrated directly without backup
# as they persist independently of the app
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saltedlolly/umbrel-apps/master/saltedlolly-audiobookshelf/tools/migrate-library.sh)
#
set -euo pipefail

# Configuration
readonly SCRIPT_VERSION="1.0.0"
readonly UMBREL_ROOT="${HOME}/umbrel"
readonly BACKUP_DIR="${UMBREL_ROOT}/home/abs-library-backup"
readonly OFFICIAL_APP_ID="audiobookshelf"
readonly NAS_APP_ID="saltedlolly-audiobookshelf"

# Media file paths for Official app
readonly OFFICIAL_AUDIOBOOKS="${UMBREL_ROOT}/home/Downloads/audiobooks"
readonly OFFICIAL_PODCASTS="${UMBREL_ROOT}/home/Downloads/podcasts"

# Media file paths for NAS Edition
readonly NAS_AUDIOBOOKS="${UMBREL_ROOT}/home/Audiobookshelf/Audiobooks"
readonly NAS_PODCASTS="${UMBREL_ROOT}/home/Audiobookshelf/Podcasts"

# Color codes for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color
readonly BOLD='\033[1m'

# Logging functions
log() {
    echo -e "${GREEN}✓${NC} $*"
}

log_info() {
    echo -e "${BLUE}ℹ${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $*"
}

log_error() {
    echo -e "${RED}✗${NC} $*" >&2
}

log_header() {
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}$*${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Ensure we have sudo cached early to avoid mid-run failures
ensure_sudo() {
    if ! command -v sudo >/dev/null 2>&1; then
        log_warn "sudo is not available; continuing without pre-caching credentials"
        return 0
    fi

    # Already have sudo without password
    if sudo -n true 2>/dev/null; then
        return 0
    fi

    log_info "Root privileges are needed later to fix file ownership (chown to 1000:1000) during backup/restore."
    log_info "Please enter your password now so the rest of the script can run without interruption."

    if ! sudo -v; then
        log_error "Could not obtain sudo privileges. Please rerun the script after providing the correct password."
        exit 1
    fi
}

# Prompt user for yes/no
prompt_yes_no() {
    local prompt="$1"
    local response
    
    while true; do
        read -p "$(echo -e "${BLUE}?${NC} ${prompt} (y/n): ")" response
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
}

# Check if a path is owned by the given user:group
is_owned_by() {
    local path="$1"
    local owner="$2"
    
    if [[ ! -e "${path}" ]]; then
        return 1
    fi
    
    local current_owner
    current_owner=$(stat -c '%U:%G' "${path}" 2>/dev/null || stat -f '%Su:%Sg' "${path}" 2>/dev/null)
    
    [[ "${current_owner}" == "${owner}" ]]
}

# Fix ownership of a path to 1000:1000, with graceful sudo handling
fix_ownership() {
    local path="$1"
    
    # Check if already owned correctly
    if is_owned_by "${path}" "1000:1000"; then
        return 0
    fi
    
    # Try without sudo first (will work if already root or user is owner)
    if chown -R 1000:1000 "${path}" 2>/dev/null; then
        return 0
    fi
    
    # Need sudo - try with sudo
    if sudo -n chown -R 1000:1000 "${path}" 2>/dev/null; then
        return 0
    fi
    
    # sudo -n failed (no passwordless sudo), ask user for password
    log_warn "Root access is needed to fix file permissions"
    log_info "Please provide your password to continue"
    
    if sudo chown -R 1000:1000 "${path}"; then
        return 0
    else
        return 1
    fi
}

# Check if an app is installed
is_app_installed() {
    local app_id="$1"
    local apps_list
    
    # Query installed apps from umbreld
    apps_list=$(umbreld client apps.list.query 2>/dev/null) || return 1
    
    # Check if the app_id exists in the list
    if echo "${apps_list}" | jq -e ".[] | select(.id == \"${app_id}\")" &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Check if an app is running (uses provided apps list)
is_app_running() {
    local app_id="$1"
    local apps_list="$2"
    
    # Check if app exists and state is "ready" (running)
    if echo "${apps_list}" | jq -e ".[] | select(.id == \"${app_id}\" and .state == \"ready\")" &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Wait for an app to finish installing
wait_for_install() {
    local app_id="$1"
    
    log_info "Checking if app is still installing..."
    
    local max_attempts=60  # Wait up to 2 minutes
    local attempt=0
    
    while [[ $attempt -lt $max_attempts ]]; do
        # Query app state
        local apps_list
        apps_list=$(umbreld client apps.list.query 2>/dev/null) || continue
        
        local app_state
        app_state=$(echo "${apps_list}" | jq -r ".[] | select(.id == \"${app_id}\") | .state" 2>/dev/null)
        
        if [[ "${app_state}" == "installing" ]]; then
            if [[ $attempt -eq 0 ]]; then
                log_info "App is currently installing, waiting for installation to complete..."
            fi
            sleep 2
            attempt=$((attempt + 1))
        elif [[ "${app_state}" == "ready" ]] || [[ "${app_state}" == "stopped" ]]; then
            log "App installation complete"
            return 0
        else
            # Some other state - continue anyway
            return 0
        fi
    done
    
    log_warn "App may still be installing after waiting"
    return 1
}

# Stop an app
stop_app() {
    local app_id="$1"
    
    log_info "Stopping ${app_id}..."
    
    # Use umbreld API to stop the app
    local stop_result
    stop_result=$(umbreld client apps.stop.mutate --appId "${app_id}" 2>/dev/null)
    
    if [[ "${stop_result}" != "true" ]]; then
        log_error "Failed to stop app"
        log_warn "Please stop the app manually:"
        log_warn "  1. Open Umbrel dashboard"
        log_warn "  2. Right-click the Audiobookshelf app icon"
        log_warn "  3. Select 'Stop'"
        log_warn "  4. Run this script again"
        exit 1
    fi
    
    log "App stop command sent"
    
    # Wait and verify the app has stopped by polling state
    log_info "Waiting for app to stop..."
    local max_attempts=10
    local attempt=0
    
    while [[ $attempt -lt $max_attempts ]]; do
        sleep 2
        attempt=$((attempt + 1))
        
        # Query app state
        local apps_list
        apps_list=$(umbreld client apps.list.query 2>/dev/null) || continue
        
        local app_state
        app_state=$(echo "${apps_list}" | jq -r ".[] | select(.id == \"${app_id}\") | .state" 2>/dev/null)
        
        if [[ "${app_state}" == "stopped" ]]; then
            log "App stopped successfully"
            return 0
        fi
    done
    
    log_error "App did not stop after waiting"
    log_warn "Please check the app status in the Umbrel dashboard"
    exit 1
}

# Start an app
start_app() {
    local app_id="$1"
    
    log_info "Starting ${app_id}..."
    
    # Use umbreld API to start the app
    local start_result
    start_result=$(umbreld client apps.start.mutate --appId "${app_id}" 2>/dev/null)
    
    if [[ "${start_result}" != "true" ]]; then
        log_warn "Could not start app automatically"
        log_info "Please start the app manually from the Umbrel dashboard"
        return 1
    fi
    
    log "App start command sent"
    
    # Wait and verify the app has started by polling state
    log_info "Waiting for app to start..."
    local max_attempts=30
    local attempt=0
    
    while [[ $attempt -lt $max_attempts ]]; do
        sleep 2
        attempt=$((attempt + 1))
        
        # Query app state
        local apps_list
        apps_list=$(umbreld client apps.list.query 2>/dev/null) || continue
        
        local app_state
        app_state=$(echo "${apps_list}" | jq -r ".[] | select(.id == \"${app_id}\") | .state" 2>/dev/null)
        
        if [[ "${app_state}" == "ready" ]]; then
            log "App started successfully"
            return 0
        fi
    done
    
    log_warn "App did not fully start after waiting"
    log_info "Please check the app status in the Umbrel dashboard"
    return 1
}

# Get app data directory
get_app_data_dir() {
    local app_id="$1"
    echo "${UMBREL_ROOT}/app-data/${app_id}/data"
}

# Get app name for display
get_app_name() {
    local app_id="$1"
    
    case "${app_id}" in
        "${OFFICIAL_APP_ID}")
            echo "Audiobookshelf (Official Umbrel App Store)"
            ;;
        "${NAS_APP_ID}")
            echo "Audiobookshelf: NAS Edition (Olly's Umbrel Community App Store)"
            ;;
        *)
            echo "${app_id}"
            ;;
    esac
}

# Check if media files exist in official locations
has_official_media() {
    if [[ -d "${OFFICIAL_AUDIOBOOKS}" ]] && [[ -n "$(ls -A "${OFFICIAL_AUDIOBOOKS}" 2>/dev/null)" ]]; then
        return 0
    fi
    if [[ -d "${OFFICIAL_PODCASTS}" ]] && [[ -n "$(ls -A "${OFFICIAL_PODCASTS}" 2>/dev/null)" ]]; then
        return 0
    fi
    return 1
}

# Check if media files exist in NAS locations
has_nas_media() {
    if [[ -d "${NAS_AUDIOBOOKS}" ]] && [[ -n "$(ls -A "${NAS_AUDIOBOOKS}" 2>/dev/null)" ]]; then
        return 0
    fi
    if [[ -d "${NAS_PODCASTS}" ]] && [[ -n "$(ls -A "${NAS_PODCASTS}" 2>/dev/null)" ]]; then
        return 0
    fi
    return 1
}


get_other_app_id() {
    local current_app_id="$1"
    
    if [[ "${current_app_id}" == "${OFFICIAL_APP_ID}" ]]; then
        echo "${NAS_APP_ID}"
    else
        echo "${OFFICIAL_APP_ID}"
    fi
}

# Detect installed Audiobookshelf app (uses provided apps list)
detect_installed_app() {
    local apps_list="$1"
    
    # Check for Official app first
    if echo "${apps_list}" | jq -e ".[] | select(.id == \"${OFFICIAL_APP_ID}\")" &>/dev/null; then
        echo "${OFFICIAL_APP_ID}"
    # Then check for NAS Edition
    elif echo "${apps_list}" | jq -e ".[] | select(.id == \"${NAS_APP_ID}\")" &>/dev/null; then
        echo "${NAS_APP_ID}"
    else
        echo ""
    fi
}

# Backup library
backup_library() {
    local app_id="$1"
    local app_data_dir
    app_data_dir=$(get_app_data_dir "${app_id}")
    
    log_header "Backing Up Library"
    
    log_info "Source: ${app_data_dir}"
    log_info "Destination: ${BACKUP_DIR}"
    
    # Create backup directory
    if ! mkdir -p "${BACKUP_DIR}"; then
        log_error "Failed to create backup directory"
        exit 1
    fi
    
    # Backup config
    if [[ -d "${app_data_dir}/config" ]]; then
        log_info "Backing up config..."
        if ! cp -r "${app_data_dir}/config" "${BACKUP_DIR}/"; then
            log_error "Failed to backup config directory"
            exit 1
        fi
        log "Config backed up successfully"
    else
        log_warn "No config directory found to backup"
    fi
    
    # Backup metadata (excluding logs)
    if [[ -d "${app_data_dir}/metadata" ]]; then
        log_info "Backing up metadata (excluding logs)..."
        
        # Create metadata directory
        mkdir -p "${BACKUP_DIR}/metadata"
        
        # Copy everything except logs
        if ! rsync -a --exclude='logs' "${app_data_dir}/metadata/" "${BACKUP_DIR}/metadata/"; then
            log_error "Failed to backup metadata directory"
            exit 1
        fi
        log "Metadata backed up successfully"
    else
        log_warn "No metadata directory found to backup"
    fi
    
    # Verify backup
    if [[ -d "${BACKUP_DIR}/config" ]] || [[ -d "${BACKUP_DIR}/metadata" ]]; then
        log ""
        log "${GREEN}${BOLD}Library backup completed successfully!${NC}"
        log_info "Backup location: ${BACKUP_DIR}"
        
        # Show backup size
        local backup_size
        backup_size=$(du -sh "${BACKUP_DIR}" | cut -f1)
        log_info "Backup size: ${backup_size}"
        
        return 0
    else
        log_error "Backup verification failed - no data was backed up"
        exit 1
    fi
}

# Migrate media files from Official to NAS Edition
migrate_media_to_nas() {
    log_header "Migrating Media Files to NAS Edition"
    
    local files_migrated=0
    
    # Migrate Audiobooks
    if [[ -d "${OFFICIAL_AUDIOBOOKS}" ]] && [[ -n "$(ls -A "${OFFICIAL_AUDIOBOOKS}" 2>/dev/null)" ]]; then
        log_info "Found audiobooks in official location"
        
        # Fix ownership of source files before moving
        log_info "Checking ownership of source files..."
        fix_ownership "${OFFICIAL_AUDIOBOOKS}" > /dev/null 2>&1 || true
        
        log_info "Creating NAS audiobooks directory..."
        mkdir -p "${NAS_AUDIOBOOKS}"
        
        log_info "Moving audiobooks to NAS location..."
        if ! mv "${OFFICIAL_AUDIOBOOKS}"/* "${NAS_AUDIOBOOKS}/"; then
            log_error "Failed to move audiobooks"
            exit 1
        fi
        files_migrated=$((files_migrated + 1))
        log "Audiobooks migrated successfully"
        
        # Remove empty source directory
        if [[ -z "$(ls -A "${OFFICIAL_AUDIOBOOKS}" 2>/dev/null)" ]]; then
            rmdir "${OFFICIAL_AUDIOBOOKS}"
            log "Removed empty audiobooks source directory"
        fi
    fi
    
    # Migrate Podcasts
    if [[ -d "${OFFICIAL_PODCASTS}" ]] && [[ -n "$(ls -A "${OFFICIAL_PODCASTS}" 2>/dev/null)" ]]; then
        log_info "Found podcasts in official location"
        
        # Fix ownership of source files before moving
        log_info "Checking ownership of source files..."
        fix_ownership "${OFFICIAL_PODCASTS}" > /dev/null 2>&1 || true
        
        log_info "Creating NAS podcasts directory..."
        mkdir -p "${NAS_PODCASTS}"
        
        log_info "Moving podcasts to NAS location..."
        if ! mv "${OFFICIAL_PODCASTS}"/* "${NAS_PODCASTS}/"; then
            log_error "Failed to move podcasts"
            exit 1
        fi
        files_migrated=$((files_migrated + 1))
        log "Podcasts migrated successfully"
        
        # Remove empty source directory
        if [[ -z "$(ls -A "${OFFICIAL_PODCASTS}" 2>/dev/null)" ]]; then
            rmdir "${OFFICIAL_PODCASTS}"
            log "Removed empty podcasts source directory"
        fi
    fi
    
    if [[ ${files_migrated} -gt 0 ]]; then
        # Fix permissions
        log_info "Checking permissions for NAS media directories..."
        for dir in "${NAS_AUDIOBOOKS}" "${NAS_PODCASTS}"; do
            if [[ -d "${dir}" ]]; then
                if ! fix_ownership "${dir}"; then
                    log_warn "Could not fix permissions for ${dir}"
                    log_warn "You may need to run: sudo chown -R 1000:1000 ${dir}"
                else
                    log "Permissions verified for ${dir}"
                fi
            fi
        done
        
        log ""
        log "${GREEN}${BOLD}Media files migrated to NAS Edition successfully!${NC}"
        return 0
    else
        log_info "No media files found to migrate"
        return 0
    fi
}

# Migrate media files from NAS Edition to Official
migrate_media_to_official() {
    log_header "Migrating Media Files to Official App"
    
    local files_migrated=0
    
    # Migrate Audiobooks
    if [[ -d "${NAS_AUDIOBOOKS}" ]] && [[ -n "$(ls -A "${NAS_AUDIOBOOKS}" 2>/dev/null)" ]]; then
        log_info "Found audiobooks in NAS location"
        
        # Fix ownership of source files before moving
        log_info "Checking ownership of source files..."
        fix_ownership "${NAS_AUDIOBOOKS}" > /dev/null 2>&1 || true
        
        log_info "Creating Official audiobooks directory..."
        mkdir -p "${OFFICIAL_AUDIOBOOKS}"
        
        log_info "Moving audiobooks to Official location..."
        if ! mv "${NAS_AUDIOBOOKS}"/* "${OFFICIAL_AUDIOBOOKS}/"; then
            log_error "Failed to move audiobooks"
            exit 1
        fi
        files_migrated=$((files_migrated + 1))
        log "Audiobooks migrated successfully"
        
        # Remove empty source directory
        if [[ -z "$(ls -A "${NAS_AUDIOBOOKS}" 2>/dev/null)" ]]; then
            rmdir "${NAS_AUDIOBOOKS}"
            log "Removed empty audiobooks source directory"
        fi
    fi
    
    # Migrate Podcasts
    if [[ -d "${NAS_PODCASTS}" ]] && [[ -n "$(ls -A "${NAS_PODCASTS}" 2>/dev/null)" ]]; then
        log_info "Found podcasts in NAS location"
        
        # Fix ownership of source files before moving
        log_info "Checking ownership of source files..."
        fix_ownership "${NAS_PODCASTS}" > /dev/null 2>&1 || true
        
        log_info "Creating Official podcasts directory..."
        mkdir -p "${OFFICIAL_PODCASTS}"
        
        log_info "Moving podcasts to Official location..."
        if ! mv "${NAS_PODCASTS}"/* "${OFFICIAL_PODCASTS}/"; then
            log_error "Failed to move podcasts"
            exit 1
        fi
        files_migrated=$((files_migrated + 1))
        log "Podcasts migrated successfully"
        
        # Remove empty source directory
        if [[ -z "$(ls -A "${NAS_PODCASTS}" 2>/dev/null)" ]]; then
            rmdir "${NAS_PODCASTS}"
            log "Removed empty podcasts source directory"
        fi
    fi
    
    # Remove empty parent Audiobookshelf directory if it exists and is empty
    local nas_parent="${UMBREL_ROOT}/home/Audiobookshelf"
    if [[ -d "${nas_parent}" ]] && [[ -z "$(ls -A "${nas_parent}" 2>/dev/null)" ]]; then
        rmdir "${nas_parent}"
        log "Removed empty Audiobookshelf parent directory"
    fi
    
    if [[ ${files_migrated} -gt 0 ]]; then
        # Fix permissions
        log_info "Checking permissions for Official media directories..."
        for dir in "${OFFICIAL_AUDIOBOOKS}" "${OFFICIAL_PODCASTS}"; do
            if [[ -d "${dir}" ]]; then
                if ! fix_ownership "${dir}"; then
                    log_warn "Could not fix permissions for ${dir}"
                    log_warn "You may need to run: sudo chown -R 1000:1000 ${dir}"
                else
                    log "Permissions verified for ${dir}"
                fi
            fi
        done
        
        log ""
        log "${GREEN}${BOLD}Media files migrated to Official app successfully!${NC}"
        return 0
    else
        log_info "No media files found to migrate"
        return 0
    fi
}

# Restore library
restore_library() {
    local app_id="$1"
    local app_data_dir
    app_data_dir=$(get_app_data_dir "${app_id}")
    
    log_header "Restoring Library"
    
    log_info "Source: ${BACKUP_DIR}"
    log_info "Destination: ${app_data_dir}"
    
    # Remove existing library files (preserve logs)
    log_info "Removing existing library files..."
    
    # Fix ownership before attempting removal (files might be owned by root)
    if [[ -d "${app_data_dir}/config" ]] || [[ -d "${app_data_dir}/metadata" ]]; then
        log_info "Checking file ownership before removal..."
        if [[ -d "${app_data_dir}/config" ]]; then
            fix_ownership "${app_data_dir}/config" > /dev/null 2>&1 || true
        fi
        if [[ -d "${app_data_dir}/metadata" ]]; then
            fix_ownership "${app_data_dir}/metadata" > /dev/null 2>&1 || true
        fi
    fi
    
    if [[ -d "${app_data_dir}/config" ]]; then
        rm -rf "${app_data_dir}/config"
        log "Removed existing config"
    fi
    
    if [[ -d "${app_data_dir}/metadata" ]]; then
        # Preserve logs if they exist
        local temp_logs="${app_data_dir}/metadata_logs_temp"
        if [[ -d "${app_data_dir}/metadata/logs" ]]; then
            mv "${app_data_dir}/metadata/logs" "${temp_logs}"
        fi
        
        rm -rf "${app_data_dir}/metadata"
        mkdir -p "${app_data_dir}/metadata"
        
        # Restore logs
        if [[ -d "${temp_logs}" ]]; then
            mv "${temp_logs}" "${app_data_dir}/metadata/logs"
        fi
        
        log "Removed existing metadata (preserved logs)"
    fi
    
    # Restore config
    if [[ -d "${BACKUP_DIR}/config" ]]; then
        log_info "Restoring config..."
        if ! cp -r "${BACKUP_DIR}/config" "${app_data_dir}/"; then
            log_error "Failed to restore config directory"
            exit 1
        fi
        log "Config restored successfully"
    fi
    
    # Restore metadata
    if [[ -d "${BACKUP_DIR}/metadata" ]]; then
        log_info "Restoring metadata..."
        if ! cp -r "${BACKUP_DIR}/metadata"/* "${app_data_dir}/metadata/"; then
            log_error "Failed to restore metadata directory"
            exit 1
        fi
        log "Metadata restored successfully"
    fi
    
    # Fix permissions
    log_info "Checking permissions (ownership should be 1000:1000)..."
    if ! fix_ownership "${app_data_dir}/config" || ! fix_ownership "${app_data_dir}/metadata"; then
        log_warn "Could not verify all permissions"
        log_warn "You may need to run: sudo chown -R 1000:1000 ${app_data_dir}"
    else
        log "Permissions verified successfully"
    fi
    
    # Migrate media files if needed
    log ""
    if [[ "${app_id}" == "${OFFICIAL_APP_ID}" ]]; then
        # Restoring to Official app - migrate from NAS to Official
        if has_nas_media; then
            log_info "Media files found in NAS Edition location"
            echo ""
            if prompt_yes_no "Do you want to migrate media files to the Official app location?"; then
                migrate_media_to_official
            else
                log_info "Media files will not be migrated"
            fi
        fi
    else
        # Restoring to NAS Edition - migrate from Official to NAS
        if has_official_media; then
            log_info "Media files found in Official app location"
            echo ""
            if prompt_yes_no "Do you want to migrate media files to the NAS Edition location?"; then
                migrate_media_to_nas
            else
                log_info "Media files will not be migrated"
            fi
        fi
    fi
    
    log ""
    log "${GREEN}${BOLD}Library restored successfully!${NC}"
}

# Delete backup
delete_backup() {
    log_header "Deleting Backup"
    
    if [[ ! -d "${BACKUP_DIR}" ]]; then
        log_warn "No backup found to delete"
        return 0
    fi
    
    local backup_size
    backup_size=$(du -sh "${BACKUP_DIR}" | cut -f1)
    
    log_warn "Backup location: ${BACKUP_DIR}"
    log_warn "Backup size: ${backup_size}"
    
    if ! prompt_yes_no "Are you sure you want to delete this backup?"; then
        log_info "Backup deletion cancelled"
        return 1
    fi
    
    if ! rm -rf "${BACKUP_DIR}"; then
        log_error "Failed to delete backup"
        exit 1
    fi
    
    log "Backup deleted successfully"
}

# Main menu when backup exists
backup_exists_menu() {
    local current_app_id="$1"
    local apps_list="$2"
    local current_app_name
    current_app_name=$(get_app_name "${current_app_id}")
    
    log_header "Existing Backup Found"
    
    local backup_size
    backup_size=$(du -sh "${BACKUP_DIR}" | cut -f1)
    
    log_info "Backup location: ${BACKUP_DIR}"
    log_info "Backup size: ${backup_size}"
    log_info "Currently installed: ${current_app_name}"
    
    echo ""
    echo "What would you like to do?"
    echo ""
    echo "  1) Restore backup to currently installed app"
    echo "     (Will overwrite existing library)"
    echo ""
    echo "  2) Delete existing backup"
    echo ""
    echo "  3) Exit without doing anything"
    echo ""
    
    local choice
    read -p "$(echo -e "${BLUE}?${NC} Enter your choice (1-3): ")" choice
    
    case "${choice}" in
        1)
            # Restore backup
            if is_app_running "${current_app_id}" "${apps_list}"; then
                log_warn "App is currently running and must be stopped"
                if prompt_yes_no "Stop the app now?"; then
                    stop_app "${current_app_id}"
                    sleep 2
                else
                    log_info "Please stop the app manually and run this script again"
                    exit 0
                fi
            else
                # App is not running, check if it's still installing
                wait_for_install "${current_app_id}"
            fi
            
            if prompt_yes_no "This will overwrite your current library. Continue?"; then
                restore_library "${current_app_id}"
                
                # Delete backup after successful restore
                log_info "Cleaning up backup..."
                rm -rf "${BACKUP_DIR}"
                log "Backup cleaned up"
                
                # Offer to start the app
                if prompt_yes_no "Start the app now?"; then
                    start_app "${current_app_id}"
                else
                    log_info "Please start the app from the Umbrel dashboard"
                fi
                
                log ""
                log "${GREEN}${BOLD}Migration completed successfully!${NC}"
            else
                log_info "Restore cancelled"
            fi
            ;;
        2)
            # Delete backup
            delete_backup
            ;;
        3)
            # Exit
            log_info "Exiting without changes"
            exit 0
            ;;
        *)
            log_error "Invalid choice"
            exit 1
            ;;
    esac
}

# Main menu when no backup exists
no_backup_menu() {
    local current_app_id="$1"
    local apps_list="$2"
    local current_app_name
    local other_app_id
    local other_app_name
    
    current_app_name=$(get_app_name "${current_app_id}")
    other_app_id=$(get_other_app_id "${current_app_id}")
    other_app_name=$(get_app_name "${other_app_id}")
    
    log_header "Library Migration Tool"
    
    log_info "Currently installed: ${current_app_name}"
    log_info "Migration target: ${other_app_name}"
    
    echo ""
    if ! prompt_yes_no "Do you want to backup your library to migrate to the other app?"; then
        log_info "Migration cancelled"
        exit 0
    fi
    
    # Check if app is running
    if is_app_running "${current_app_id}" "${apps_list}"; then
        log_warn "App is currently running and must be stopped before backup"
        if prompt_yes_no "Stop the app now?"; then
            stop_app "${current_app_id}"
            sleep 2
        else
            log_info "Please stop the app manually and run this script again"
            exit 0
        fi
    fi
    
    # Perform backup
    backup_library "${current_app_id}"
    
    # Offer to uninstall the current app
    log ""
    if prompt_yes_no "Do you want to uninstall ${current_app_name} now?"; then
        log_info "Uninstalling ${current_app_id}..."
        
        local uninstall_result
        uninstall_result=$(umbreld client apps.uninstall.mutate --appId "${current_app_id}" 2>/dev/null)
        
        if [[ "${uninstall_result}" != "true" ]]; then
            log_error "Failed to uninstall app"
            log_warn "Please uninstall the app manually from the Umbrel dashboard"
        else
            log "App uninstalled successfully"
        fi
    fi
    
    # Provide next steps
    log ""
    log_header "Next Steps"
    
    echo ""
    echo "To complete the migration:"
    echo ""
    echo "  1. Install ${other_app_name}:"
    
    if [[ "${other_app_id}" == "${OFFICIAL_APP_ID}" ]]; then
        echo "     - Open Umbrel App Store"
        echo "     - Search for 'Audiobookshelf'"
        echo "     - Install the official app"
        echo "     - Wait for the install to finish"
    else
        echo "     - Launch the App Store from your Umbrel Dashboard"
        echo "     - Click the ••• button in the top right, and click 'Community App Stores'"
        echo "     - Paste this URL: https://github.com/saltedlolly/umbrel-app-store"
        echo "     - Click 'Add'"
        echo "     - Click 'Open' next to \"Olly's Umbrel Community App Store\""
        echo "     - Find 'Audiobookshelf: NAS Edition' and install it"
        echo "     - Wait for the install to finish"
    fi
    
    echo ""
    echo "  2. Run this script again to restore your library"
    echo ""
    echo "     Note: Media files (audiobooks and podcasts) will be automatically"
    echo "     migrated during restore if they exist in the old app location."
    echo ""
    
    log_info "Backup will remain at: ${BACKUP_DIR}"
}

# Main function
main() {
    log_header "Audiobookshelf Library Migration Tool v${SCRIPT_VERSION}"
    
    # Check if running on Umbrel
    if [[ ! -d "${UMBREL_ROOT}" ]]; then
        log_error "This script must be run on an Umbrel system"
        log_error "Umbrel directory not found at: ${UMBREL_ROOT}"
        exit 1
    fi
    
    # Verify this is umbrelOS by checking for umbreld
    if ! command -v umbreld &> /dev/null; then
        log_error "This script must be run on umbrelOS"
        log_error "umbreld command not found - this does not appear to be umbrelOS"
        exit 1
    fi
    
    # Check umbrelOS version
    log_info "Checking umbrelOS version..."
    local version_output
    version_output=$(umbreld client system.version.query 2>/dev/null) || true
    if [[ -n "$version_output" ]]; then
        local version
        # Extract version using jq (available in umbrelOS 1.5.0+)
        version=$(echo "$version_output" | jq -r '.version' 2>/dev/null)
        
        if [[ -n "$version" ]] && [[ "$version" != "null" ]]; then
            log_info "Detected umbrelOS version: $version"
            
            # Compare version (requires 1.5.0 or higher)
            # Convert version to comparable number (e.g., 1.5.0 -> 10500)
            local version_num
            version_num=$(echo "$version" | awk -F. '{printf "%d%02d%02d", $1, $2, $3}')
            local min_version_num=10500  # 1.5.0
            
            if [[ $version_num -lt $min_version_num ]]; then
                log_error "This script requires umbrelOS 1.5.0 or higher"
                log_error "Your version: $version"
                log_error "Please update your Umbrel system before running this script"
                exit 1
            fi
            
            log "umbrelOS version check passed"
        else
            log_warn "Could not parse umbrelOS version, proceeding anyway..."
        fi
    else
        log_warn "Could not query umbrelOS version, proceeding anyway..."
    fi

    # Cache sudo credentials up-front so chown operations do not interrupt later
    ensure_sudo
    
    # Query installed apps once (this takes several seconds)
    log_info "Querying installed apps..."
    local apps_list
    apps_list=$(umbreld client apps.list.query 2>/dev/null) || {
        log_error "Failed to query installed apps"
        exit 1
    }
    
    # Detect installed app using the queried data
    local current_app_id
    current_app_id=$(detect_installed_app "${apps_list}")
    
    if [[ -z "${current_app_id}" ]]; then
        log_error "No Audiobookshelf app is currently installed"
        log_info "Please install either:"
        log_info "  - Audiobookshelf (Official Umbrel App Store)"
        log_info "  - Audiobookshelf: NAS Edition (Community App Store)"
        log_info "Then run this script again"
        exit 1
    fi
    
    # Check if backup exists
    if [[ -d "${BACKUP_DIR}" ]] && [[ -n "$(ls -A "${BACKUP_DIR}" 2>/dev/null)" ]]; then
        backup_exists_menu "${current_app_id}" "${apps_list}"
    else
        no_backup_menu "${current_app_id}" "${apps_list}"
    fi
}

# Run main function
main "$@"
