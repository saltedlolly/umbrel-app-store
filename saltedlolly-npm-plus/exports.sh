export APP_SALTEDLOLLY_NPM_PLUS_DATA_DIR="${EXPORTS_APP_DATA_DIR}/data"
export APP_SALTEDLOLLY_NPM_PLUS_ADMIN_PORT="5181"
export APP_SALTEDLOLLY_NPM_PLUS_HTTP_PORT="50080"
export APP_SALTEDLOLLY_NPM_PLUS_HTTPS_PORT="50443"
export APP_SALTEDLOLLY_NPM_PLUS_COOKIE_SECRET="$(derive_entropy "${app_entropy_identifier}-cookie-secret")"

# Authentik OAuth2/OIDC client credentials (shared with Authentik app when installed)
export APP_SALTEDLOLLY_NPM_PLUS_AUTHENTIK_CLIENT_ID="npmplus-$(derive_entropy "${app_entropy_identifier}-authentik-client" | head -c 16)"
export APP_SALTEDLOLLY_NPM_PLUS_AUTHENTIK_CLIENT_SECRET="$(derive_entropy "${app_entropy_identifier}-authentik-secret")"
