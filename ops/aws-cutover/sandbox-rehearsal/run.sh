#!/usr/bin/env bash
# The CTX-1217 cutover rehearsal in the selfhost-sandbox account: deploy the
# stack, run the task once, print its report, delete the stack.
#
#   ops/aws-cutover/sandbox-rehearsal/run.sh <image@sha256:…> [rows per table] [--keep]
#
# AWS_PROFILE defaults to ctxpipe-selfhost-sandbox. The script refuses an
# account that is not the selfhost-sandbox account below. --keep keeps the
# stack after the run. Needs the AWS CLI and jq.
set -euo pipefail

# The selfhost-sandbox account (the factory repo lists it in
# machines/aws-core/stacks/org/config.ts). An account id is not a secret.
sandbox_account=787752212265
usage="usage: run.sh <image@sha256:…> [rows per table] [--keep]"

keep=0
args=()
for arg in "$@"; do
  if [[ "$arg" == --keep ]]; then keep=1; else args+=("$arg"); fi
done
image="${args[0]:?$usage}"
rows="${args[1]:-}"
(( ${#args[@]} <= 2 )) || { echo "$usage" >&2; exit 2; }
command -v jq >/dev/null || { echo "Install jq." >&2; exit 2; }

export AWS_PROFILE="${AWS_PROFILE:-ctxpipe-selfhost-sandbox}"
export AWS_REGION=us-west-2
stack=ctx-1217-cutover-rehearsal
here="$(cd "$(dirname "$0")" && pwd)"

actual="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual" != "$sandbox_account" ]]; then
  echo "The profile $AWS_PROFILE is account $actual, not the selfhost-sandbox account $sandbox_account. Stopped." >&2
  exit 1
fi

cluster=""
task=""
cleanup() {
  if [[ -n "$task" ]]; then
    # A cluster with a running task cannot be deleted.
    aws ecs stop-task --cluster "$cluster" --task "$task" >/dev/null 2>&1 || true
    aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task" || true
  fi
  if (( keep )); then
    echo "--keep: the stack $stack stays. Delete it with: aws cloudformation delete-stack --stack-name $stack" >&2
    return
  fi
  echo "Deleting the stack…" >&2
  if aws cloudformation delete-stack --stack-name "$stack" &&
    aws cloudformation wait stack-delete-complete --stack-name "$stack"; then
    echo "Stack deleted." >&2
  else
    echo "The delete failed. Delete the stack $stack by hand: Aurora costs money while it runs." >&2
  fi
}
trap cleanup EXIT

echo "Deploying $stack (Aurora takes about 10 minutes)…" >&2
started=$(date +%s)
parameters=("Image=$image")
[[ -z "$rows" ]] || parameters+=("DefaultRows=$rows")
aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$here/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "${parameters[@]}" \
  --tags spike=ctx-1217 ctxpipe:purpose=cutover-rehearsal ctxpipe:data=synthetic
echo "Deployed in $(( $(date +%s) - started )) s." >&2

output() {
  aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
cluster="$(output TaskCluster)"
result="$(aws ecs run-task \
  --cluster "$cluster" \
  --launch-type FARGATE \
  --task-definition "$(output TaskDefinition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(output Subnet)],securityGroups=[$(output TaskSecurityGroup)],assignPublicIp=ENABLED}" \
  --output json)"
# run-task can succeed with no task and a list of failures.
if [[ "$(jq '.failures | length' <<<"$result")" != 0 ]]; then
  echo "run-task failed: $(jq -c .failures <<<"$result")" >&2
  exit 1
fi
task="$(jq -r '.tasks[0].taskArn // empty' <<<"$result")"
if [[ -z "$task" || "$task" == None ]]; then
  echo "run-task started no task." >&2
  exit 1
fi
echo "Task $task started." >&2

# The waiter of the CLI gives up after 10 minutes; a large rehearsal runs
# longer. A failed call or the deadline stops the script, and the EXIT trap
# deletes the stack.
deadline=$(( $(date +%s) + 90 * 60 ))
while :; do
  status="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].lastStatus' --output text)" || {
    echo "describe-tasks failed." >&2
    exit 1
  }
  [[ "$status" != STOPPED ]] || break
  if [[ -z "$status" || "$status" == None ]]; then
    echo "describe-tasks does not find the task $task." >&2
    exit 1
  fi
  if (( $(date +%s) > deadline )); then
    echo "The task did not stop in 90 minutes." >&2
    exit 1
  fi
  sleep 30
done
code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)"

# The task writes its log (progress) and then the report (JSON).
aws logs tail "$(output LogGroup)" --since 1d --format short >&2 || true
echo "The task ended with exit code $code." >&2
[[ "$code" == 0 ]]
