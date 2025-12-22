UMBREL_DATA_DIR="${UMBREL_ROOT}/data"
UMBREL_DATA_STORAGE_DIR="${UMBREL_DATA_DIR}/storage"
UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_DIR="${UMBREL_DATA_STORAGE_DIR}/Audiobookshelf"
UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR="${UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_DIR}/Audiobooks"
UMBREL_DATA_STORAGE_PODCASTS_DIR="${UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_DIR}/Podcasts"
UMBREL_DATA_STORAGE_ABS_CONFIG="${UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_DIR}/app-data/config"
UMBREL_DATA_STORAGE_ABS_METADATA="${UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_DIR}/app-data/metadata"
UMBREL_DATA_STORAGE_ABS_LOGS="${UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_LOGS}/app-data/metadata/logs"
DESIRED_OWNER="1000:1000"

# Ensure all Audiobookshelf directories exist
if [[ ! -d "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}"
fi

if [[ ! -d "${UMBREL_DATA_STORAGE_PODCASTS_DIR}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_PODCASTS_DIR}"
fi

if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_CONFIG}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_ABS_CONFIG}"
fi

if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_METADATA}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_ABS_METADATA}"
fi

if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_LOGS}" ]]; then
	mkdir -p "${UMBREL_DATA_STORAGE_ABS_LOGS}"
fi

# Set correct permissions (Paperless-style approach)
set_correct_permissions() {
	local -r path="${1}"

	if [[ -d "${path}" ]]; then
		owner=$(stat -c "%u:%g" "${path}")

		if [[ "${owner}" != "${DESIRED_OWNER}" ]]; then
			chown -R "${DESIRED_OWNER}" "${path}"
		fi
	fi
}

set_correct_permissions "${UMBREL_DATA_STORAGE_DIR}"
set_correct_permissions "${UMBREL_DATA_STORAGE_AUDIOBOOKSHELF_DIR}"