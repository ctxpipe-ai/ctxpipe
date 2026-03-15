# Infra (Pulumi)

Pulumi project for provisioning infrastructure. Uses the [Any Terraform Provider](https://www.pulumi.com/docs/iac/concepts/providers/any-terraform-provider/) bridge to support Terraform providers that don’t have a native Pulumi package (e.g. [Railway](https://registry.terraform.io/providers/terraform-community-providers/railway/latest/docs)).

## Prerequisites

- Pulumi CLI (>= v3.147.0 for Terraform provider support): https://www.pulumi.com/docs/get-started/install/
- Node.js (>= 18) and pnpm (monorepo)

## Using the Railway Terraform provider in Pulumi

Pulumi can use the [Railway Terraform provider](https://registry.terraform.io/providers/terraform-community-providers/railway/latest/docs) via the **Any Terraform Provider** feature. No native Pulumi package is required.

### 1. Add the provider

From `ops/infra`:

```bash
pulumi package add terraform-provider terraform-community-providers/railway 0.4.2
```

This will:

- Add a `packages` entry for the Railway provider in `Pulumi.yaml`
- Generate a TypeScript SDK under `sdks/railway` (or similar)

Use a specific version (e.g. `0.4.2`) instead of omitting it, so builds are reproducible.

### 2. Install dependencies

```bash
pnpm install
# or
pulumi install
```

If the CLI instructs you to add the SDK as a local dependency (e.g. `npm add railway@file:sdks/railway`), do that so your IDE and compiler see the generated types.

### 3. Configure the provider

The Railway Terraform provider expects an API key. Set it via Pulumi config (prefer [Pulumi ESC](https://www.pulumi.com/docs/esc/) or env for secrets):

```bash
pulumi config set railway:apiKey YOUR_RAILWAY_API_TOKEN --secret
```

Exact config keys follow the Terraform provider’s arguments (often `api_key` → `railway:apiKey` in Pulumi config). Check the [provider docs](https://registry.terraform.io/providers/terraform-community-providers/railway/latest/docs) for the full list.

### 4. Use in code

Import the generated SDK (the exact module name is printed when you run `pulumi package add`). Example:

```ts
import * as pulumi from "@pulumi/pulumi";
import * as railway from "@pulumi/railway"; // or the package name shown by the CLI

// Example: create a Railway project (resource names/types from the Terraform provider docs)
const project = new railway.Project("my-project", {
  name: "my-app",
});

export const projectId = project.id;
```

Resource and data source names come from the [Railway Terraform provider documentation](https://registry.terraform.io/providers/terraform-community-providers/railway/latest/docs). You can inspect the generated schema:

```bash
pulumi package get-schema terraform-provider terraform-community-providers/railway
```

## Alternative: convert from Terraform

If you already have Terraform HCL that uses the Railway provider, you can convert it to Pulumi and get a generated SDK for that provider in one step:

```bash
pulumi convert --from terraform --language typescript --out .
```

See [Converting Terraform to Pulumi](https://www.pulumi.com/docs/iac/adopting-pulumi/migrating-to-pulumi/from-terraform/) and [Converting Terraform to Pulumi (blog)](https://www.pulumi.com/blog/converting-full-terraform-programs-to-pulumi/).

## Project layout

- `Pulumi.yaml` — Project and package config (including Terraform provider packages)
- `Pulumi.*.yaml` — Stack config (e.g. `Pulumi.dev.yaml`)
- `index.ts` — Main Pulumi program
- `sdks/` — Generated SDKs for Terraform providers added via `pulumi package add terraform-provider`

## References

- [Using any Terraform provider (Pulumi)](https://www.pulumi.com/docs/iac/concepts/providers/any-terraform-provider/)
- [Railway Terraform provider (registry)](https://registry.terraform.io/providers/terraform-community-providers/railway/latest/docs)
- [Pulumi convert from Terraform](https://www.pulumi.com/docs/iac/cli/commands/pulumi_convert/)