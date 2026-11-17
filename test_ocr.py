"""Tests for ocr.py on synthetic PDFs. Run: .venv/bin/python -m unittest test_ocr"""
import ctypes
import tempfile
import unittest
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as raw

import ocr

TEXT = "Synthetic invoice for Jan Kowalski, 12 EUR, paid on 2025-03-14. " * 2


def make_pdf(path, annot=None):
    """A one-page digital PDF with TEXT in its text layer, plus an optional annotation subtype."""
    pdf = pdfium.PdfDocument.new()
    page = pdf.new_page(595, 842)
    font = raw.FPDFText_LoadStandardFont(pdf.raw, b"Helvetica")
    obj = raw.FPDFPageObj_NewTextObj(pdf.raw, b"Helvetica", 10)
    wide = (TEXT + "\0").encode("utf-16-le")
    raw.FPDFText_SetText(obj, ctypes.cast(ctypes.c_char_p(wide), ctypes.POINTER(raw.FPDF_WCHAR)))
    raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 20, 800)
    raw.FPDFPage_InsertObject(page.raw, obj)
    raw.FPDFPage_GenerateContent(page.raw)
    raw.FPDFFont_Close(font)
    if annot is not None:
        a = raw.FPDFPage_CreateAnnot(page.raw, annot)
        raw.FPDFAnnot_SetRect(a, raw.FS_RECTF(20, 700, 200, 720))
        raw.FPDFPage_CloseAnnot(a)
    pdf.save(path)


class PdfTextTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "doc.pdf"

    def tearDown(self):
        self.dir.cleanup()

    def test_plain_digital_pdf_uses_its_text_layer(self):
        make_pdf(self.path)
        self.assertIn("Jan Kowalski", ocr.pdf_text(self.path))

    def test_text_box_on_top_sends_the_pdf_to_vision(self):
        make_pdf(self.path, raw.FPDF_ANNOT_FREETEXT)
        self.assertIsNone(ocr.pdf_text(self.path))

    def test_a_link_alone_keeps_the_text_layer(self):
        make_pdf(self.path, raw.FPDF_ANNOT_LINK)
        self.assertIsNotNone(ocr.pdf_text(self.path))


if __name__ == "__main__":
    unittest.main()
