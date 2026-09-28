export APP_SALTEDLOLLY_AUTHENTIK_SECRET_KEY="$(derive_entropy "${app_entropy_identifier}-secret-key")"
export APP_SALTEDLOLLY_AUTHENTIK_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-db-password")"
