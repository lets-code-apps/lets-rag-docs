"""Extract text from every document in a folder into data/ocr/<same path>.<method>.txt.

Digital PDFs are read directly (method "text"); scans and photos go through Apple Vision ("vision").
Usage: .venv/bin/python ocr.py <folder>
"""
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pypdfium2 as pdfium

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "ocr"
VISION_SRC = ROOT / "vision_ocr.swift"
VISION_BIN = ROOT / ".build" / "vision-ocr"
TYPES = {".pdf", ".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff"}
# ponytail: a page with fewer chars than this counts as a scan; a junk text layer would slip through
MIN_CHARS = 50
PDF_DPI = 300


def pdf_text(path):
    """Embedded text of a digital PDF, or None if any page looks scanned."""
    pages = [page.get_textpage().get_text_range() for page in pdfium.PdfDocument(path)]
    if all(len(p.strip()) >= MIN_CHARS for p in pages):
        return "\n\n".join(pages)


def vision(path):
    """OCR an image, or every page of a scanned PDF, with Apple Vision (Neural Engine, fully offline)."""
    with tempfile.TemporaryDirectory() as tmp:
        images = [path]
        if path.suffix.lower() == ".pdf":
            images = []
            for i, page in enumerate(pdfium.PdfDocument(path)):
                images.append(Path(tmp) / f"{i}.png")
                page.render(scale=PDF_DPI / 72).to_pil().save(images[-1])
        out = subprocess.run([VISION_BIN, *images], check=True, capture_output=True, text=True).stdout
    return out.strip().replace("\f", "\n\n")


def main(folder):
    if not VISION_BIN.exists() or VISION_BIN.stat().st_mtime < VISION_SRC.stat().st_mtime:
        VISION_BIN.parent.mkdir(exist_ok=True)
        subprocess.run(["swiftc", "-O", VISION_SRC, "-o", VISION_BIN], check=True)
    for src in sorted(p for p in folder.rglob("*") if p.suffix.lower() in TYPES):
        t = time.time()
        text = pdf_text(src) if src.suffix.lower() == ".pdf" else None
        how = "text" if text else "vision"
        out = OUT / src.relative_to(folder).parent / f"{src.name}.{how}.txt"
        if out.exists() and out.stat().st_mtime > src.stat().st_mtime:
            print(f"skip    {src.name}")
            continue
        if text is None:
            text = vision(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text)
        print(f"{how:<7} {src.name}  ({time.time() - t:.1f}s, {len(text)} chars)")


if __name__ == "__main__":
    main(Path(sys.argv[1]).expanduser())
