---
"@ctxpipe/aws-cdk": patch
---

The knowledge plane converts PDF, DOCX, PPTX, XLSX, HTML and SVG files and images to text at projection time. The worker image now holds the file converter (`ctxpipe-convert`). A new ClickHouse table, `image_texts`, keeps the readings of the vision model.
