"""Tests for ocr.py on synthetic PDFs. Run: .venv/bin/python -m unittest test_ocr"""
import ctypes
import tempfile
import unittest
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as raw

import ocr

TEXT = "Synthetic invoice for Jan Kowalski, 12 EUR, paid on 2025-03-14. " * 2


def make_pdf(path, annot=None, pages=1):
    """A digital PDF with TEXT in each page's text layer, plus an optional annotation subtype."""
    pdf = pdfium.PdfDocument.new()
    font = raw.FPDFText_LoadStandardFont(pdf.raw, b"Helvetica")
    for _ in range(pages):
        page = pdf.new_page(595, 842)
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


class MarkPagesTest(unittest.TestCase):
    """Page markers for the Vision path: blank pages must keep their number."""

    def test_blank_first_page_keeps_its_number(self):
        # Swift prints nothing for a blank page, so the text starts with the separator.
        # Dropping that marker would make page 2 look like page 1.
        self.assertEqual(ocr.mark_pages("\fSECOND PAGE\ntext"), "\f\fSECOND PAGE\ntext")

    def test_blank_last_page_keeps_its_number(self):
        # A trailing separator means a blank last page: keep it, so the count stays 2.
        self.assertEqual(ocr.mark_pages("FIRST PAGE\ntext\f"), "\fFIRST PAGE\ntext\f")

    def test_two_blank_pages_in_the_middle(self):
        self.assertEqual(ocr.mark_pages("A\f\f\fD"), "\fA\f\f\fD")


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

    def test_two_pages_carry_page_markers(self):
        # Text starts with \f and has exactly one marker per page, so `chunk` can number pages.
        make_pdf(self.path, pages=2)
        text = ocr.pdf_text(self.path)
        self.assertTrue(text.startswith("\f"))
        self.assertEqual(text.count("\f"), 2)


if __name__ == "__main__":
    unittest.main()
