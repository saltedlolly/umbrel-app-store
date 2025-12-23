#!/usr/bin/env bash
#
# Audiobookshelf Library Migration Tool
# 
# This script helps you migrate your Audiobookshelf library between:
# - Official Audiobookshelf app from Umbrel App Store
# - Audiobookshelf: NAS Edition from Community App Store
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

# Check if an app is installed
is_app_installed() {
    local app_id="$1"
    local app_dir="${UMBREL_ROOT}/app-data/${app_id}"
    
    if [[ -d "${app_dir}" ]] && [[ -f "${app_dir}/umbrel-app.yml" ]]; then
        return 0
    else
        return 1
    fi
}

# Check if an app is running
is_app_running() {
    local app_id="$1"
    local container_name="${app_id}_web_1"
    
    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        return 0
    else
        return 1
    fi
}

# Stop an app
stop_app() {
    local app_id="$1"
    
    log_info "Stopping ${app_id}..."
    
    # Try using Umbrel CLI if available
    if command -v umbrel &> /dev/null; then
        if umbrel app stop "${app_id}" 2>/dev/null; then
            log "App stopped successfully"
            return 0
        fi
    fi
    
    # Fallback: stop docker containers directly
    local compose_file="${UMBREL_ROOT}/app-data/${app_id}/docker-compose.yml"
    if [[ -f "${compose_file}" ]]; then
        if docker-compose -f "${compose_file}" down 2>/dev/null; then
            log "App stopped successfully"
            return 0
        fi
    fi
    
    log_error "Failed to stop app automatically"
    log_warn "Please stop the app manually:"
    log_warn "  1. Open Umbrel dashboard"
    log_warn "  2. Right-click the Audiobookshelf app icon"
    log_warn "  3. Select 'Stop'"
    log_warn "  4. Run this script again"
    exit 1
}

# Start an app
start_app() {
    local app_id="$1"
    
    log_info "Starting ${app_id}..."
    
    # Try using Umbrel CLI if available
    if command -v umbrel &> /dev/null; then
        if umbrel app start "${app_id}" 2>/dev/null; then
            log "App started successfully"
            return 0
        fi
    fi
    
    log_warn "Could not start app automatically"
    log_info "Please start the app manually from the Umbrel dashboard"
}

# Get app data directory
get_app_data_dir() {
    local app_id="$1"
    echo "${UMBREL_ROOT}/app-data/${app_id}"
}

# Get app name for display
get_app_name() {
    local app_id="$1"
    
    case "${app_id}" in
        "${OFFICIAL_APP_ID}")
            echo "Audiobookshelf (Official Umbrel App Store)"
            ;;
        "${NAS_APP_ID}")
            echo "Audiobookshelf: NAS Edition (Community App Store)"
            ;;
        *)
            echo "${app_id}"
            ;;
    esac
}

# Get the other app ID
get_other_app_id() {
    local current_app_id="$1"
    
    if [[ "${current_app_id}" == "${OFFICIAL_APP_ID}" ]]; then
        echo "${NAS_APP_ID}"
    else
        echo "${OFFICIAL_APP_ID}"
    fi
}

# Detect installed Audiobookshelf app
detect_installed_app() {
    if is_app_installed "${OFFICIAL_APP_ID}"; then
        echo "${OFFICIAL_APP_ID}"
    elif is_app_installed "${NAS_APP_ID}"; then
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
    log_info "Fixing permissions (setting ownership to 1000:1000)..."
    if ! sudo chown -R 1000:1000 "${app_data_dir}/config" "${app_data_dir}/metadata"; then
        log_error "Failed to fix permissions"
        log_warn "You may need to run: sudo chown -R 1000:1000 ${app_data_dir}"
        exit 1
    fi
    log "Permissions fixed successfully"
    
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
            if is_app_running "${current_app_id}"; then
                log_warn "App is currently running and must be stopped"
                if prompt_yes_no "Stop the app now?"; then
                    stop_app "${current_app_id}"
                    sleep 2
                else
                    log_info "Please stop the app manually and run this script again"
                    exit 0
                fi
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
    if is_app_running "${current_app_id}"; then
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
    
    # Provide next steps
    log ""
    log_header "Next Steps"
    
    echo ""
    echo "Your library has been backed up. To complete the migration:"
    echo ""
    echo "  1. Uninstall the current app:"
    echo "     - Open Umbrel dashboard"
    echo "     - Right-click the Audiobookshelf app icon"
    echo "     - Select 'Uninstall'"
    echo ""
    echo "  2. Install ${other_app_name}:"
    
    if [[ "${other_app_id}" == "${OFFICIAL_APP_ID}" ]]; then
        echo "     - Open Umbrel App Store"
        echo "     - Search for 'Audiobookshelf'"
        echo "     - Install the official app"
    else
        echo "     - Open Umbrel App Store"
        echo "     - Go to Community App Stores"
        echo "     - Add saltedlolly's app store if not already added"
        echo "     - Search for 'Audiobookshelf: NAS Edition'"
        echo "     - Install the app"
    fi
    
    echo ""
    echo "  3. Run this script again to restore your library"
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
    
    # Detect installed app
    local current_app_id
    current_app_id=$(detect_installed_app)
    
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
        backup_exists_menu "${current_app_id}"
    else
        no_backup_menu "${current_app_id}"
    fi
}

# Run main function
main "$@"
