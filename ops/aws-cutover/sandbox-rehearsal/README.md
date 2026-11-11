# Cutover rehearsal in the sandbox account

The AWS part of the CTX-1217 rehearsal, with synthetic data only. It runs the copy of the cutover (`copyDatabase`) and
migrate against a real Aurora PostgreSQL 17 Serverless v2 cluster. It measures what the local rehearsal cannot: the
`vector` version and the extension rights of the Aurora master user, TLS with the RDS CA bundle, the restore and the
HNSW index build at Aurora's ACUs, and the backend image as the one-off task of the runbook.

It does not measure the network from Neon: the source and the target are two databases on the same cluster. The real
rehearsal of the runbook reads a Neon branch.

## Run

1. Sign in: `aws sso login --sso-session ctxpipe` (the profile `ctxpipe-selfhost-sandbox`).
2. Take a backend image of `main` that has `apps/backend/src/scripts/cutoverRehearsal.ts`, for linux/arm64, by digest
   (`ghcr.io/ctxpipe-ai/backend@sha256:…`).
3. Run (the AWS CLI and `jq` must be installed):

   ```sh
   ops/aws-cutover/sandbox-rehearsal/run.sh ghcr.io/ctxpipe-ai/backend@sha256:<digest> [rows per table] [--keep]
   ```

The script holds the selfhost-sandbox account id (from the factory repo, `machines/aws-core/stacks/org/config.ts`). It
stops when the profile is in a different account. It deploys the stack (about 10 minutes for Aurora), runs the task,
prints its log and its JSON report, and deletes the stack, also after a failure. It stops the wait after 90 minutes,
and also when a call to ECS fails. `--keep` keeps the stack. The template sets 20000 rows per table when you give no
row count.

## What the stack holds

- A VPC with two subnets and an internet gateway. The task gets a public IP to pull the image from GHCR and to fetch
  the RDS CA bundle; its security group admits no inbound traffic. Aurora is not publicly accessible and admits only
  the task.
- Aurora PostgreSQL 17 Serverless v2, writer only, 0.5 to 8 ACU, encrypted, with an AWS-managed master password.
  No deletion protection and no final snapshot: the data is synthetic.
- One Fargate task (arm64, 2 vCPU, 4 GB, 60 GiB of ephemeral storage for the dump) with the master password from
  Secrets Manager as `PGPASSWORD`.
- A log group that keeps 1 day.

Every resource has the tags `spike=ctx-1217`, `ctxpipe:purpose=cutover-rehearsal` and `ctxpipe:data=synthetic`.

## Cost

A run of about 30 minutes costs well under 1 USD: Aurora at a few ACU-hours, one Fargate task, and the storage.
