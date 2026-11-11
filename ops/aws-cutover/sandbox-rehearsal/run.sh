#!/usr/bin/env bash
# The CTX-1217 cutover rehearsal in the selfhost-sandbox account: deploy the
# stack, run the task once, print its report, delete the stack.
#
#   ops/aws-cutover/sandbox-rehearsal/run.sh <selfhost-sandbox account id> <image@sha256:…> [DefaultRows]
#
# AWS_PROFILE defaults to ctxpipe-selfhost-sandbox. The script refuses any
# other account. KEEP=1 keeps the stack after the run.
set -euo pipefail

account="${1:?usage: run.sh <selfhost-sandbox account id> <image@sha256:…> [DefaultRows]}"
image="${2:?usage: run.sh <selfhost-sandbox account id> <image@sha256:…> [DefaultRows]}"
rows="${3:-20000}"
export AWS_PROFILE="${AWS_PROFILE:-ctxpipe-selfhost-sandbox}"
export AWS_REGION=us-west-2
stack=ctx-1217-cutover-rehearsal
here="$(cd "$(dirname "$0")" && pwd)"

actual="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual" != "$account" ]]; then
  echo "The profile $AWS_PROFILE is account $actual, not $account. Use the selfhost-sandbox account only." >&2
  exit 1
fi

delete_stack() {
  if [[ "${KEEP:-}" == 1 ]]; then
    echo "KEEP=1: the stack $stack stays. Delete it with: aws cloudformation delete-stack --stack-name $stack" >&2
    return
  fi
  echo "Deleting the stack…" >&2
  aws cloudformation delete-stack --stack-name "$stack"
  aws cloudformation wait stack-delete-complete --stack-name "$stack"
  echo "Stack deleted." >&2
}
trap delete_stack EXIT

echo "Deploying $stack (Aurora takes about 10 minutes)…" >&2
started=$(date +%s)
aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$here/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "Image=$image" "DefaultRows=$rows" \
  --tags spike=ctx-1217 ctxpipe:purpose=cutover-rehearsal ctxpipe:data=synthetic
echo "Deployed in $(( $(date +%s) - started )) s." >&2

output() {
  aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
cluster="$(output TaskCluster)"
task="$(aws ecs run-task \
  --cluster "$cluster" \
  --launch-type FARGATE \
  --task-definition "$(output TaskDefinition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(output Subnet)],securityGroups=[$(output TaskSecurityGroup)],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)"
echo "Task $task started." >&2
# The waiter of the CLI gives up after 10 minutes; a large rehearsal runs longer.
until [[ "$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].lastStatus' --output text)" == STOPPED ]]; do
  sleep 30
done
code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)"

# The task prints its progress to stderr and the report (JSON) last.
aws logs tail "$(output LogGroup)" --since 1d --format short >&2 || true
echo "The task ended with exit code $code." >&2
[[ "$code" == 0 ]]
