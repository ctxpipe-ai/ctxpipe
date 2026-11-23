---
"@ctxpipe/aws-cdk": patch
---

Ingestion keeps each Related line of a shared file. When a Stream file or a store file passes the 64 KiB file limit, the next lines go to the parts of its list, and the skill does not stop as partial. A part of a file with a long name gets a short, fixed name. Each run of a skill page adds to the files that an earlier run of the page wrote. The new skill bundle version offers a re-ingestion (CTX-1528).
