# shellcheck shell=bash
# Neon helpers for the PR Deploy jobs that run no branch code. Source this
# file; it defines functions only. The functions need NEON_API_KEY and
# NEON_PROJECT_ID, call only the Neon API with curl and jq, and print no
# credential. They run no package manager, so scripts/ci/check-secret-jobs.mjs
# lets a job with a secret source this file.

# neon_api METHOD PATH [JSON_BODY]: prints the response body.
neon_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -X "$method" -H "Authorization: Bearer ${NEON_API_KEY}" -H "Accept: application/json")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}" "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}${path}"
}

# neon_branch_by_name NAME: prints the id of the branch NAME, or nothing.
neon_branch_by_name() {
  neon_api GET "/branches" | jq -r --arg n "$1" '[.branches[]? | select(.name == $n) | .id][0] // empty'
}

# neon_wait_operations JSON: waits until each operation in JSON (a Neon API
# response with an `operations` array) is finished.
neon_wait_operations() {
  local id status deadline
  deadline=$(($(date +%s) + 300))
  for id in $(printf '%s' "$1" | jq -r '.operations[]?.id'); do
    while true; do
      status="$(neon_api GET "/operations/${id}" | jq -r '.operation.status')"
      case "$status" in
        finished | skipped | cancelled) break ;;
        failed | error)
          echo "Neon operation $id ended with status $status" >&2
          return 1
          ;;
      esac
      if (($(date +%s) > deadline)); then
        echo "Neon operation $id did not finish in 5 minutes (status $status)" >&2
        return 1
      fi
      sleep 2
    done
  done
}

# neon_preview_branch_id PR_NUMBER: prints the id of the branch
# preview/pr-<PR_NUMBER>. Fails when there is no such branch, or when it is
# the default branch or the production branch. Without a branch id, the Neon
# API uses the default branch, which is production.
neon_preview_branch_id() {
  local name="preview/pr-$1" id branch production
  [[ "$1" =~ ^[0-9]+$ ]] || {
    echo "neon_preview_branch_id: the PR number must be a number" >&2
    return 1
  }
  id="$(neon_branch_by_name "$name")"
  [[ -n "$id" ]] || {
    echo "Neon has no branch $name" >&2
    return 1
  }
  branch="$(neon_api GET "/branches/${id}")"
  if [[ "$(printf '%s' "$branch" | jq -r '.branch.default')" == "true" ]]; then
    echo "Neon branch $name ($id) is the default branch; refusing to use it" >&2
    return 1
  fi
  production="$(neon_branch_by_name production)"
  if [[ "$(printf '%s' "$branch" | jq -r '.branch.name')" != "$name" || "$id" == "$production" ]]; then
    echo "Neon branch $id is not the preview branch $name; refusing to use it" >&2
    return 1
  fi
  printf '%s' "$id"
}

# neon_ensure_preview_branch PR_NUMBER EXPIRES_AT: creates the branch
# preview/pr-<PR_NUMBER> from production, with a read-write endpoint, when
# it does not exist. Prints nothing.
neon_ensure_preview_branch() {
  local name="preview/pr-$1" expires_at="$2" parent response
  [[ "$1" =~ ^[0-9]+$ ]] || {
    echo "neon_ensure_preview_branch: the PR number must be a number" >&2
    return 1
  }
  if [[ -n "$(neon_branch_by_name "$name")" ]]; then
    echo "Neon branch $name exists"
    return 0
  fi
  parent="$(neon_branch_by_name production)"
  [[ -n "$parent" ]] || {
    echo "Neon has no production branch to copy" >&2
    return 1
  }
  response="$(neon_api POST "/branches" "$(jq -nc --arg n "$name" --arg p "$parent" --arg e "$expires_at" \
    '{branch:{name:$n, parent_id:$p, expires_at:$e}, endpoints:[{type:"read_write"}]}')")"
  neon_wait_operations "$response"
  echo "Created Neon branch $name"
}

# neon_wait_branch_idle BRANCH_ID: waits until the branch has no running
# Neon operation. Neon refuses a change (HTTP 423) while an operation runs on
# the branch, for example the endpoint start of an earlier deploy.
neon_wait_branch_idle() {
  local running deadline
  deadline=$(($(date +%s) + 300))
  while true; do
    running="$(neon_api GET "/operations?limit=100" | jq -r --arg b "$1" \
      '[.operations[]? | select(.branch_id == $b and (.status | IN("finished", "skipped", "cancelled", "failed", "error") | not))] | length')"
    [[ "$running" == 0 ]] && return 0
    if (($(date +%s) > deadline)); then
      echo "Neon branch $1 still has $running running operations after 5 minutes" >&2
      return 1
    fi
    echo "Neon branch $1 has $running running operations; waiting"
    sleep 3
  done
}

# neon_reset_owner_password BRANCH_ID: gives neondb_owner a new password on
# this branch only. The branch copies the role from production, with the
# production password; after the reset, the old password does not work on
# this branch, and the new one does not work on production. It first waits
# until no operation runs on the branch.
neon_reset_owner_password() {
  local response
  neon_wait_branch_idle "$1"
  response="$(neon_api POST "/branches/$1/roles/neondb_owner/reset_password")"
  neon_wait_operations "$response"
}

# neon_owner_url BRANCH_ID POOLED: prints the neondb_owner connection URL of
# the branch. POOLED is true or false. The caller must mask the value.
neon_owner_url() {
  local uri
  [[ "$1" =~ ^[A-Za-z0-9-]+$ && "$2" =~ ^(true|false)$ ]] || {
    echo "neon_owner_url: bad branch id or pooled value" >&2
    return 1
  }
  uri="$(neon_api GET "/connection_uri?branch_id=$1&database_name=neondb&role_name=neondb_owner&pooled=$2" | jq -r '.uri')"
  [[ -n "$uri" && "$uri" != "null" ]] || {
    echo "Neon returned no owner URL for branch $1" >&2
    return 1
  }
  printf '%s' "$uri"
}
