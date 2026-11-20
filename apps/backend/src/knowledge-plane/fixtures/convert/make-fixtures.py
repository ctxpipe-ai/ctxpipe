# /// script
# dependencies = ["python-docx==1.2.0", "python-pptx==1.0.2", "openpyxl==3.1.5", "reportlab==4.4.4", "pypdf==6.1.1"]
# ///
"""Make the converter test fixtures. All content is made up.

Run from this folder: uv run make-fixtures.py
"""
import io
import os
import zipfile
import zlib

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

# DOCX: a heading, a paragraph, a list and a table.
doc = Document()
doc.add_heading("Incident review: cache outage", level=1)
doc.add_paragraph("The cache cluster lost its primary at 09:12 UTC.")
for step in ["Fail over to the replica", "Rebuild the primary", "Write the postmortem"]:
    doc.add_paragraph(step, style="List Number")
table = doc.add_table(rows=3, cols=2)
for row, (a, b) in enumerate([("Metric", "Value"), ("Downtime", "14 minutes"), ("Requests lost", "0")]):
    table.cell(row, 0).text, table.cell(row, 1).text = a, b
doc.save("sample.docx")

# PPTX: two slides with a title, bullets and speaker notes.
deck = Presentation()
for title, bullets, notes in [
    ("Roadmap Q3", ["Search ranking", "Image text"], "Say that the dates are estimates."),
    ("Risks", ["Vision model cost", "Parser edge cases"], "Ask for the budget."),
]:
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = title
    body = slide.placeholders[1].text_frame
    body.text = bullets[0]
    for bullet in bullets[1:]:
        body.add_paragraph().text = bullet
    slide.notes_slide.notes_text_frame.text = notes
deck.save("sample.pptx")

# XLSX: two sheets with text, numbers and a date.
import datetime
book = Workbook()
sheet = book.active
sheet.title = "Budget"
for row in [("Item", "Cost"), ("Vision calls", 120.5), ("Embeddings", 30)]:
    sheet.append(row)
plan = book.create_sheet("Plan")
plan.append(("Milestone", "Date"))
plan.append(("Converter ships", datetime.date(2026, 12, 1)))
book.save("sample.xlsx")

# PDF: two pages with text.
def pdf_pages(path, pages):
    c = canvas.Canvas(path, pagesize=A4, invariant=1)
    for lines in pages:
        y = 800
        for line in lines:
            c.drawString(72, y, line)
            y -= 18
        c.showPage()
    c.save()

pdf_pages("sample.pdf", [["Runbook: rotate the signing key", "1. Create the new key."], ["2. Publish the public key.", "3. Retire the old key after 24 hours."]])

# Encrypted PDF: a user password.
writer = PdfWriter(clone_from="sample.pdf")
writer.encrypt(user_password="secret", owner_password="owner", algorithm="RC4-128")
writer.write("encrypted.pdf")

# Image-only PDF: one page with an image and no text layer.
c = canvas.Canvas("image-only.pdf", pagesize=A4, invariant=1)
c.rect(72, 500, 300, 200, fill=1)
c.showPage()
c.save()

# 5,000 pages that share one content stream: above the page cap.
def raw_pdf(path, objects):
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    open(path, "wb").write(out.getvalue())

pages = 5_000
kids = " ".join(f"{i + 5} 0 R" for i in range(pages)).encode()
content = b"BT /F1 12 Tf 72 720 Td (Page) Tj ET"
raw_pdf("many-pages.pdf", [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(pages).encode() + b" >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream",
] + [b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>"] * pages)

# A zip bomb: 256 MiB of paragraphs in word/document.xml (anydoc's limit
# for one entry is 128 MiB).
CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
with zipfile.ZipFile("zip-bomb.docx", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr("[Content_Types].xml", CT)
    z.writestr("_rels/.rels", RELS)
    with z.open("word/document.xml", "w") as f:
        f.write(f'<?xml version="1.0"?><w:document {W}><w:body>'.encode())
        chunk = b"<w:p><w:r><w:t>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</w:t></w:r></w:p>" * 16384
        for _ in range(256 * 1024 * 1024 // len(chunk)):
            f.write(chunk)
        f.write(b"</w:body></w:document>")

# Billion laughs in a DOCX.
with zipfile.ZipFile("billion-laughs.docx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CT)
    z.writestr("_rels/.rels", RELS)
    entities = '<!ENTITY a0 "lol">' + "".join(f'<!ENTITY a{i} "{("&a%d;" % (i - 1)) * 10}">' for i in range(1, 10))
    z.writestr("word/document.xml", f'<?xml version="1.0"?><!DOCTYPE w:document [{entities}]><w:document {W}><w:body><w:p><w:r><w:t>&a9;</w:t></w:r></w:p></w:body></w:document>')

# A shared-strings bomb: one 4 KiB shared string in 50,000 small cells.
# The parts are small, but the text would be about 200 MiB (the text limit
# is 16 MiB).
X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
with zipfile.ZipFile("shared-strings-bomb.xlsx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    z.writestr("_rels/.rels", RELS.replace("word/document.xml", "xl/workbook.xml"))
    z.writestr("xl/workbook.xml", f'<?xml version="1.0"?><workbook xmlns="{X}" xmlns:r="{R}"><sheets><sheet name="Bomb" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr("xl/_rels/workbook.xml.rels", f'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    z.writestr("xl/sharedStrings.xml", f'<?xml version="1.0"?><sst xmlns="{X}" count="1" uniqueCount="1"><si><t>{"x" * 4096}</t></si></sst>')
    rows = "".join(f'<row r="{r}">' + '<c t="s"><v>0</v></c>' * 20 + "</row>" for r in range(1, 2_501))
    z.writestr("xl/worksheets/sheet1.xml", f'<?xml version="1.0"?><worksheet xmlns="{X}"><sheetData>{rows}</sheetData></worksheet>')

# Truncated and random files.
for source, target in [("sample.pdf", "truncated.pdf"), ("sample.docx", "truncated.docx")]:
    data = open(source, "rb").read()
    open(target, "wb").write(data[: len(data) // 2])
open("random.pptx", "wb").write(bytes((i * 7919 + 13) % 256 for i in range(20_000)))

# HTML with a script, a style and a navigation that the text leaves out.
open("sample.html", "w").write("""<!doctype html><html><head><title>Deploy guide</title><style>body{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/">Home</a></nav><main><h1>Deploy guide</h1><p>Run <code>make deploy</code> from the <strong>main</strong> branch.</p>
<ul><li>Check the dashboard</li><li>Watch the error rate</li></ul><table><tr><th>Stage</th><th>Time</th></tr><tr><td>Build</td><td>4 min</td></tr></table></main></body></html>
""")

# SVG attacks: entity expansion, an external image, a huge canvas.
open("billion-laughs.svg", "w").write('<?xml version="1.0"?><!DOCTYPE svg [' + entities + ']><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text x="10" y="50">&a9;</text></svg>')
open("external-image.svg", "w").write('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100"><image href="file:///etc/passwd" width="100" height="100"/><image xlink:href="https://example.com/x.png" width="100" height="100"/><text x="10" y="80">Local only</text></svg>')
open("huge-canvas.svg", "w").write('<svg xmlns="http://www.w3.org/2000/svg" width="1000000000" height="1000000000"><rect width="1000000000" height="1000000000" fill="blue"/><text x="10" y="80" font-size="100000000">Big</text></svg>')

for name in sorted(os.listdir(".")):
    print(name, os.path.getsize(name))
