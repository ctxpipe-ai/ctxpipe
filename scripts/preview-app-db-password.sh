# shellcheck shell=bash
# preview_app_db_password
# Print the ctxpipe_app password for this run of a Railway PR preview. Migrate
# sets this password on the Neon branch, and every service DATABASE_URL holds
# it, so the two sides use one value.
#
# The password stays the same for the life of the preview. Migrate sets the
# password before it runs Drizzle, so a new password on each run breaks the
# services that are live: they hold the old URL until the deploy rolls them,
# and for all time when migrate or the deploy fails after the password change.
#
# - The preview backend DATABASE_URL has user ctxpipe_app on the host of this
#   Neon branch: use its password again.
# - Any other value (the production URL that `environment new --duplicate
#   production` copies, an other user, or a host of an earlier branch): make a
#   new password.
#
# Needs RAILWAY_PROJECT_ID, ENV_ID, BACKEND_SERVICE_ID, OWNER_DB_URL_POOLED and
# the caller's railway_graphql. Prints only the password on stdout, and never
# prints a value on stderr. The caller masks the password.
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

preview_app_db_password() {
  local name current password
  for name in RAILWAY_PROJECT_ID ENV_ID BACKEND_SERVICE_ID OWNER_DB_URL_POOLED; do
    if [[ -z "${!name:-}" ]]; then
      echo "preview-app-db-password: $name is required" >&2
      return 1
    fi
  done
  current="$(service_vars "$ENV_ID" "$BACKEND_SERVICE_ID" DATABASE_URL \
    | jq -r '.DATABASE_URL // ""')" || return 1
  # A URL that does not parse gets a new password. The except clause prints
  # nothing, so a parse error cannot show a value.
  password="$(CURRENT_URL="$current" python3 -c '
import os
from urllib.parse import urlparse, unquote
try:
    current = urlparse(os.environ["CURRENT_URL"])
    owner = urlparse(os.environ["OWNER_DB_URL_POOLED"])
    if current.username == "ctxpipe_app" and current.password and current.hostname and current.hostname == owner.hostname:
        print(unquote(current.password))
except Exception:
    pass
')" || return 1
  if [[ -n "$password" ]]; then
    echo "preview-app-db-password: the preview keeps its ctxpipe_app password" >&2
  else
    password="$(openssl rand -hex 24)"
    echo "preview-app-db-password: the preview gets a new ctxpipe_app password" >&2
  fi
  printf '%s\n' "$password"
}
