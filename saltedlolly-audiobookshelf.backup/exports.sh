# Audiobookshelf exports
# Config and metadata are stored in ${APP_DATA_DIR} (provided by Umbrel)
# Media files are stored in /home/Audiobookshelf (visible in Files app, survives uninstall)

# Define media directory paths
export AUDIOBOOKSHELF_HOME_DIR="${UMBREL_ROOT}/home/Audiobookshelf"
export AUDIOBOOKS_DIR="${AUDIOBOOKSHELF_HOME_DIR}/Audiobooks"
export PODCASTS_DIR="${AUDIOBOOKSHELF_HOME_DIR}/Podcasts"

# Create media directories in /home (config/metadata in APP_DATA_DIR is auto-created by Umbrel)
if [[ ! -d "${AUDIOBOOKS_DIR}" ]]; then
	mkdir -p "${AUDIOBOOKS_DIR}"
fi

if [[ ! -d "${PODCASTS_DIR}" ]]; then
	mkdir -p "${PODCASTS_DIR}"
fi