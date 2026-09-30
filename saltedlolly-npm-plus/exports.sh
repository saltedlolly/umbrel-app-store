export APP_SALTEDLOLLY_NPM_PLUS_DATA_DIR="${EXPORTS_APP_DATA_DIR}/data"
export APP_SALTEDLOLLY_NPM_PLUS_ADMIN_PORT="5181"
export APP_SALTEDLOLLY_NPM_PLUS_HTTP_PORT="50080"
export APP_SALTEDLOLLY_NPM_PLUS_HTTPS_PORT="50443"
export APP_SALTEDLOLLY_NPM_PLUS_COOKIE_SECRET="$(derive_entropy "${app_entropy_identifier}-cookie-secret")"

# CrowdSec bouncer key (shared with CrowdSec app - must use same derivation)
export APP_SALTEDLOLLY_CROWDSEC_NPMPLUS_BOUNCER_KEY="$(derive_entropy "saltedlolly-npmplus-crowdsec-shared-bouncer")"
