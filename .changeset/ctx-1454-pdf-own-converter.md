---
"@ctxpipe/aws-cdk": patch
---

improvement: The two OpenAI-compatible model proxies of the backend convert each PDF file part to text with the backend's own converter before the model call. No file part goes to the model provider. A file part that is not a PDF, or a PDF that the converter cannot read, makes the request fail with a clear error. Image parts are not changed.
