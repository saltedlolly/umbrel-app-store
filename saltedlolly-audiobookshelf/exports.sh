UMBREL_DATA_DIR="${UMBREL_ROOT}/data"
UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR="${UMBREL_DATA_DIR}/storage/downloads/audiobooks"
UMBREL_DATA_STORAGE_PODCASTS_DIR="${UMBREL_DATA_DIR}/storage/downloads/podcasts"
UMBREL_DATA_STORAGE_ABS_CONFIG="${UMBREL_DATA_DIR}/storage/audiobookshelf-data/config"
UMBREL_DATA_STORAGE_ABS_METADATA="${UMBREL_DATA_DIR}/storage/audiobookshelf-data/metadata"
DESIRED_OWNER="1000:1000"

# Create audiobooks directory
if [[ ! -d "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}"
	chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}"
fi

# Create podcasts directory
if [[ ! -d "${UMBREL_DATA_STORAGE_PODCASTS_DIR}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_PODCASTS_DIR}"
	chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_PODCASTS_DIR}"
fi

# Create persistent config directory (survives uninstall)
if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_CONFIG}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_ABS_CONFIG}"
	chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_ABS_CONFIG}"
fi

# Create persistent metadata directory (survives uninstall)
if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_METADATA}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_ABS_METADATA}"
	chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_ABS_METADATA}"
fi