"""Extract text from every document in a folder into data/ocr/<same path>.<method>.txt.

Digital PDFs are read directly (method "text"); scans and photos go through Apple Vision ("vision").
Usage: .venv/bin/python ocr.py <folder> [--only=<path relative to folder>] [--out=<dir>]
"""
import argparse
import subprocess
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


def main(folder, out_root=OUT, only=None):
    if not VISION_BIN.exists() or VISION_BIN.stat().st_mtime < VISION_SRC.stat().st_mtime:
        VISION_BIN.parent.mkdir(exist_ok=True)
        subprocess.run(["swiftc", "-O", VISION_SRC, "-o", VISION_BIN], check=True)
    for src in sorted(p for p in folder.rglob("*") if p.suffix.lower() in TYPES):
        rel = src.relative_to(folder)
        # --only=<path relative to FOLDER>: one document, used by `lets-rag-docs add`.
        if only is not None and str(rel) != only:
            continue
        t = time.time()
        text = pdf_text(src) if src.suffix.lower() == ".pdf" else None
        how = "text" if text else "vision"
        out = out_root / rel.parent / f"{src.name}.{how}.txt"
        if out.exists() and out.stat().st_mtime > src.stat().st_mtime:
            print(f"skip    {src.name}")
            continue
        if text is None:
            text = vision(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text)
        print(f"{how:<7} {src.name}  ({time.time() - t:.1f}s, {len(text)} chars)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="OCR documents into <method>.txt files.")
    ap.add_argument("folder", help="folder whose documents are OCR'd (recursively)")
    ap.add_argument("--only", metavar="REL", help="process only this path relative to FOLDER")
    ap.add_argument("--out", metavar="DIR", help=f"where to write the .txt files (default {OUT})")
    args = ap.parse_args()
    main(Path(args.folder).expanduser(),
         Path(args.out).expanduser() if args.out else OUT,
         args.only)
