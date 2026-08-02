# Copy this file to config/local/remote-deploy.sh and replace the placeholders.
# The destination is ignored by Git and excluded from Docker build contexts.
# This file is sourced by Bash. Default assignments let explicit environment
# variables override the local values for one-off operations.

: "${PERSISTENT_DEPLOY_SSH_BIN:=ssh}"
: "${PERSISTENT_DEPLOY_SSH_TARGET:=deploy-host}"
: "${PERSISTENT_DEPLOY_REMOTE_ROOT:=/srv/perseverance}"
: "${PERSISTENT_DEPLOY_STATE_HOME:=${PERSISTENT_DEPLOY_REMOTE_ROOT}/state}"
