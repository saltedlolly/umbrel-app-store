#!/bin/sh
set -e

# Kubo's bundled WebUI (served from this same node) calls its own RPC API
# as a separate absolute-origin request rather than a same-origin relative
# path, so the browser treats it as cross-origin - and Kubo's API refuses
# any request carrying an Origin header that isn't explicitly allow-listed
# here, even one that would otherwise look same-origin to the browser.
# Without this, the WebUI loads but immediately shows "Could not connect
# to the Kubo RPC" for every user.
#
# A wildcard is safe in this specific deployment: the API is never
# published directly (see docker-compose.yml) - the only path to it at
# all is through app_proxy, which requires an authenticated Umbrel SSO
# session first. A cross-site request without that session never reaches
# this far regardless of what Origin it claims. Runs on every container
# start (not just first init), via Kubo's own official /container-init.d
# hook, so it stays correct even if the repo config is ever reset.
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST"]'
