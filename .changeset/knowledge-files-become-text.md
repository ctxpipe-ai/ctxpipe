---
"@ctxpipe/aws-cdk": patch
---

feature: The knowledge plane converts PDF, DOCX, PPTX, XLSX, HTML and SVG files and images to text at projection time. The worker image now holds the file converter (`ctxpipe-convert`). A new ClickHouse table, `image_texts`, keeps the readings of the vision model.

One vision model reads the images. The default is `openai/gpt-6.1-terra`; set `MODEL_VISION_NAME` to use another OpenRouter model that takes image input and has a ZDR endpoint.
