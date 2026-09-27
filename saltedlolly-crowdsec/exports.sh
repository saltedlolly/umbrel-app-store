export APP_SALTEDLOLLY_CROWDSEC_NPMPLUS_BOUNCER_KEY="$(derive_entropy "saltedlolly-npmplus-crowdsec-shared-bouncer")"
export APP_SALTEDLOLLY_CROWDSEC_WEBUI_PASSWORD="$(derive_entropy "${app_entropy_identifier}-webui-password")"
