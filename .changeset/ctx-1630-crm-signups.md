---
"@ctxpipe/aws-cdk": patch
---

The backend adds the table `crm_intake_outbox`. Hosted ctxpipe records each new sign-up there, and its worker sends the sign-up to the CRM of the ctxpipe team. A self-hosted deployment does not record or send anything: only a deployment with `DEPLOYMENT_ENVIRONMENT=production` and `CRM_INTAKE_URL` records, and a self-hosted deployment does not set them. The table stays empty.
