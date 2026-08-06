# Copy this file to config/local/self-hosted-deploy.sh and adjust the paths.
# The destination is ignored by Git and excluded from Docker build contexts.
# This file is sourced by Bash. Default assignments let explicit environment
# variables override the local values for one-off operations.

: "${PERSISTENT_DEPLOY_ROOT:=/srv/perseverance}"
: "${PERSISTENT_DEPLOY_STATE_HOME:=/var/lib/perseverance}"
# A deploy proceeds immediately when the most recent product/run activity is
# already older than this window. Otherwise the host worker waits by itself.
: "${PERSISTENT_DEPLOY_IDLE_SECONDS:=3600}"
: "${PERSISTENT_DEPLOY_POLL_SECONDS:=60}"
