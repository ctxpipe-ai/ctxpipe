---
---

Jev gets no image bytes. An image candidate goes to Jev as its text, and the backend reads no image bytes at retrieval. The codesearch route `POST /{repoId}/blobs-query` is removed, because Jev was its only caller (CTX-1432).
