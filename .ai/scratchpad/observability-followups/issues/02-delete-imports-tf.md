# Delete imports.tf after the first apply

Status: ready-for-human

Delete [`ops/observability/terraform/imports.tf`](../../../../ops/observability/terraform/imports.tf) after the first successful apply on `main`.

The file adopts API-created services. Import blocks do nothing once that address is in state. A fresh project has nothing to import: delete the file before planning so the plan creates only `railway.tf` resources.

## Comments
