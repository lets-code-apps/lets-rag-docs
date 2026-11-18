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
# Annotations that put text on the page: Preview's text boxes (FreeText) and filled form fields
# (Widget). The embedded text layer leaves them out; a render shows them. Links etc. don't count.
TEXT_ANNOTS = {pdfium.raw.FPDF_ANNOT_FREETEXT, pdfium.raw.FPDF_ANNOT_WIDGET}


def has_text_annots(page):
    for i in range(pdfium.raw.FPDFPage_GetAnnotCount(page.raw)):
        annot = pdfium.raw.FPDFPage_GetAnnot(page.raw, i)
        subtype = pdfium.raw.FPDFAnnot_GetSubtype(annot)
        pdfium.raw.FPDFPage_CloseAnnot(annot)
        if subtype in TEXT_ANNOTS:
            return True
    return False


def pdf_text(path):
    """Embedded text of a digital PDF, or None if any page looks scanned or has text annotations."""
    pages = []
    for page in pdfium.PdfDocument(path):
        if has_text_annots(page):
            return None  # Vision reads the rendered page, annotations included
        pages.append(page.get_textpage().get_text_range())
    if all(len(p.strip()) >= MIN_CHARS for p in pages):
        return mark_pages("\f".join(pages))


def mark_pages(text):
    """Turn page-separated text into text where every page starts with a \f marker.

    Split on \f FIRST and trim inside each page: a blank page keeps its marker, so a
    blank first or last page never shifts later page numbers.
    """
    return "".join("\f" + page.strip() for page in text.split("\f"))


def vision(path):
    """OCR an image, or every page of a scanned PDF, with Apple Vision (Neural Engine, fully offline)."""
    with tempfile.TemporaryDirectory() as tmp:
        images = [path]
        if path.suffix.lower() == ".pdf":
            images = []
            pdf = pdfium.PdfDocument(path)
            pdf.init_forms()  # before loading pages, or filled form fields don't render
            for i, page in enumerate(pdf):
                images.append(Path(tmp) / f"{i}.png")
                page.render(scale=PDF_DPI / 72).to_pil().save(images[-1])
        out = subprocess.run([VISION_BIN, *images], check=True, capture_output=True, text=True).stdout
    return mark_pages(out)


def main(folder, out_root=OUT, only=None):
    # --only must name an existing document of a supported type: fail non-zero with a message
    # now, instead of silently processing nothing and letting the caller (lets-rag-docs add)
    # treat that as success.
    if only is not None:
        target = folder / only
        if not target.is_file() or target.suffix.lower() not in TYPES:
            raise SystemExit(
                f"error: --only={only} is not an existing file with one of "
                f"{', '.join(sorted(TYPES))} suffixes under {folder}"
            )
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
        # A PDF that switched method (e.g. annotations added) must not leave its old text behind:
        # ingest would index both under the same source.
        other = "vision" if how == "text" else "text"
        (out_root / rel.parent / f"{src.name}.{other}.txt").unlink(missing_ok=True)
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
