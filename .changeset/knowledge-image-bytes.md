---
---

The knowledge plane embeds the bytes of each PNG and JPEG image from the Workspace Git, and gives a failed document to an image that the model does not take. Jev gets the bytes of an image candidate through the new codesearch route `POST /{repoId}/blobs-query`, which reads only regular files from the Git object store at the served SHA. The EMBEDS_IMAGE relation holds the alt text of its image reference, and the documents table loses the unused s3_key column (CTX-1412).
