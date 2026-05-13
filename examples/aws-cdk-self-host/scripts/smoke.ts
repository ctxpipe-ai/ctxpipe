import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

const POLL_MS = 15_000;
const MAX_WAIT_MS = 20 * 60 * 1000;

/** Match deployed stack name when overriding `-c stackName=...`. */
const STACK_NAME =
  process.env.CDK_STACK_NAME ??
  process.env.STACK_NAME ??
  "CtxpipeSelfHostE2E";

async function main(): Promise<void> {
  const client = new CloudFormationClient({});
  const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = Stacks?.[0]?.Outputs ?? [];
  const appUrlOut = outputs.find((o) => (o.OutputKey ?? "").includes("AppUrl"));
  const base = appUrlOut?.OutputValue?.replace(/\/$/, "");
  if (!base) {
    throw new Error(`Stack "${STACK_NAME}" has no AppUrl output`);
  }

  const healthUrl = `${base}/health`;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { redirect: "manual" });
      if (res.ok) {
        console.log(`Smoke OK: ${healthUrl} (${res.status})`);
        return;
      }
      console.warn(`Smoke: ${healthUrl} returned ${res.status}, retry in ${POLL_MS / 1000}s`);
    } catch (err) {
      console.warn(`Smoke: request failed (${String(err)}), retry in ${POLL_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  throw new Error(`Smoke timed out after ${MAX_WAIT_MS / 1000}s: ${healthUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
