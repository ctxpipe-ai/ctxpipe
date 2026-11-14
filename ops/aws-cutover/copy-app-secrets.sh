#!/usr/bin/env bash
# Step C1 of the AWS cutover (CTX-1217, ADR-061 decision 12): copy the app
# secrets of Railway production into the AWS Secrets Manager secrets
# hosted/app/<NAME>, with their current values, then compare both sides.
#
# Who: the CTO, on the day before the window, in an SSO admin session of the
# production account, with the Railway CLI logged in.
#
#   export AWS_PROFILE=<production SSO admin profile> AWS_REGION=us-west-2
#   ops/aws-cutover/copy-app-secrets.sh           # copy, verify, restart the backend
#   ops/aws-cutover/copy-app-secrets.sh --verify  # compare only
#
# No value goes to the terminal, to a file or to a process argument: each value
# stays in this shell's memory and goes to the AWS CLI on stdin. The output is
# one line per secret: "NAME copied", "NAME match", "NAME MISMATCH" or
# "NAME FAILED".
#
# The list is APP_SECRETS of factory machines/hosted/src/app-secrets.ts,
# without DATABASE_APP_PASSWORD: that value is new on AWS, and migrate sets it
# on the Aurora role.
set -euo pipefail

keys=(
  AUTH_SECRET CONNECTION_SECRETS_ENCRYPTION_KEY MODEL_PROVIDER_API_KEY
  GITHUB_PRIVATE_KEY GITHUB_CLIENT_SECRET GITHUB_WEBHOOK_SECRET
  ATLASSIAN_CLIENT_ID ATLASSIAN_CLIENT_SECRET NOTION_CLIENT_ID NOTION_CLIENT_SECRET
  SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET
  LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET VERCEL_TOKEN
)

account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$account" != 213102790567 ]; then
  echo "This session is in the account $account, not production (213102790567). Nothing changed." >&2
  exit 1
fi

vars="$(railway variables --service backend --environment production --json)"

# The exact Railway value. The trailing "x" keeps a final newline, which a
# command substitution removes.
railway_value() {
  local value
  value="$(printf '%s' "$vars" | jq -j --arg k "$1" \
    '.[$k] | if type == "string" and length > 0 then . else error("missing") end' 2>/dev/null; printf x)" || return 1
  [ "$value" != x ] || return 1
  printf '%s' "${value%x}"
}

stored_value() {
  aws secretsmanager get-secret-value --secret-id "hosted/app/$1" \
    --query SecretString --output json | jq -j .
}

failed=0

if [ "${1:-}" != --verify ]; then
  for key in "${keys[@]}"; do
    if value="$(railway_value "$key"; printf x)" && [ "$value" != x ] &&
      printf '%s' "${value%x}" | aws secretsmanager put-secret-value \
        --secret-id "hosted/app/$key" --secret-string file:///dev/stdin \
        --query VersionId --output text >/dev/null; then
      echo "$key copied"
    else
      echo "$key FAILED"
      failed=1
    fi
    unset value
  done
fi

for key in "${keys[@]}"; do
  a="$(railway_value "$key" | shasum -a 256)" || a=none
  b="$(stored_value "$key" | shasum -a 256)" || b=none
  if [ "$a" != none ] && [ "$a" = "$b" ]; then
    echo "$key match"
  else
    echo "$key MISMATCH"
    failed=1
  fi
done
unset vars

if [ "$failed" != 0 ]; then
  echo "A secret failed or does not match. Do not start the window. Run the script again." >&2
  exit 1
fi

if [ "${1:-}" != --verify ]; then
  # The tasks read a secret when they start. The worker stays at 0 until G4,
  # and its tasks read the new values when they start.
  aws ecs update-service --cluster hosted --service backend --force-new-deployment \
    --query service.serviceName --output text
  aws ecs wait services-stable --cluster hosted --services backend
  echo "backend restarted with the copied secrets"
fi
