UMBREL_DATA_DIR="${UMBREL_ROOT}/data"
UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR="${UMBREL_DATA_DIR}/storage/Audiobookshelf/Audiobooks"
UMBREL_DATA_STORAGE_PODCASTS_DIR="${UMBREL_DATA_DIR}/storage/Audiobookshelf/Podcasts"
UMBREL_DATA_STORAGE_ABS_CONFIG="${UMBREL_DATA_DIR}/storage/Audiobookshelf/app-data/config"
UMBREL_DATA_STORAGE_ABS_METADATA="${UMBREL_DATA_DIR}/storage/Audiobookshelf/app-data/metadata"
DESIRED_OWNER="1000:1000"

echo "[EXPORTS] Ensuring Audiobookshelf persistent storage directories exist..."

# Create audiobooks directory
if [[ ! -d "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}" ]]; then
	echo "[EXPORTS] Creating Audiobooks directory: ${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}"
	if mkdir -p "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}" && chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_AUDIOBOOKS_DIR}"; then
		echo "[EXPORTS] ✓ Audiobooks directory created successfully"
	else
		echo "[EXPORTS] ERROR: Failed to create Audiobooks directory" >&2
	fi
else
	echo "[EXPORTS] ✓ Audiobooks directory already exists"
fi

# Create podcasts directory
if [[ ! -d "${UMBREL_DATA_STORAGE_PODCASTS_DIR}" ]]; then
	echo "[EXPORTS] Creating Podcasts directory: ${UMBREL_DATA_STORAGE_PODCASTS_DIR}"
	if mkdir -p "${UMBREL_DATA_STORAGE_PODCASTS_DIR}" && chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_PODCASTS_DIR}"; then
		echo "[EXPORTS] ✓ Podcasts directory created successfully"
	else
		echo "[EXPORTS] ERROR: Failed to create Podcasts directory" >&2
	fi
else
	echo "[EXPORTS] ✓ Podcasts directory already exists"
fi

# Create persistent config directory (survives uninstall)
if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_CONFIG}" ]]; then
	echo "[EXPORTS] Creating config directory: ${UMBREL_DATA_STORAGE_ABS_CONFIG}"
	if mkdir -p "${UMBREL_DATA_STORAGE_ABS_CONFIG}" && chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_ABS_CONFIG}"; then
		echo "[EXPORTS] ✓ Config directory created successfully"
	else
		echo "[EXPORTS] ERROR: Failed to create config directory" >&2
	fi
else
	echo "[EXPORTS] ✓ Config directory already exists"
fi

# Create persistent metadata directory (survives uninstall)
if [[ ! -d "${UMBREL_DATA_STORAGE_ABS_METADATA}" ]]; then
	echo "[EXPORTS] Creating metadata directory: ${UMBREL_DATA_STORAGE_ABS_METADATA}"
	if mkdir -p "${UMBREL_DATA_STORAGE_ABS_METADATA}" && chown "${DESIRED_OWNER}" "${UMBREL_DATA_STORAGE_ABS_METADATA}"; then
		echo "[EXPORTS] ✓ Metadata directory created successfully"
	else
		echo "[EXPORTS] ERROR: Failed to create metadata directory" >&2
	fi
else
	echo "[EXPORTS] ✓ Metadata directory already exists"
fi

echo "[EXPORTS] Persistent storage initialization complete"