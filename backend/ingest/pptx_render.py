"""Render an uploaded .pptx into one snapshot PNG per slide.

LibreOffice has no native "render each slide to PNG" mode that preserves
layout as faithfully as its own PDF export, so this goes .pptx -> .pdf (via
`soffice --headless`) -> one PNG per page (via PyMuPDF), rather than asking
soffice for PNGs directly.
"""
import subprocess
import tempfile
import uuid
from pathlib import Path

import fitz  # PyMuPDF
from pptx import Presentation
from pptx.exc import PackageNotFoundError


class PptxRenderError(Exception):
    pass


class SofficeNotFoundError(PptxRenderError):
    pass


def _validate_pptx(pptx_path):
    """Fail fast on a corrupt/non-pptx upload before paying for the much
    slower soffice subprocess call."""
    try:
        prs = Presentation(str(pptx_path))
    except PackageNotFoundError:
        raise PptxRenderError('Uploaded file is not a valid .pptx package')
    except Exception as exc:
        raise PptxRenderError(f'Could not read .pptx file: {exc}')

    if len(prs.slides) == 0:
        raise PptxRenderError('Uploaded .pptx has no slides')


def _convert_to_pdf(pptx_path, tmp_dir, config):
    # -env:UserInstallation points soffice at a throwaway profile directory
    # unique to this call, so a lock held by a concurrent/crashed headless
    # instance never surfaces as "please close LibreOffice and try again".
    profile_dir = tmp_dir / f'soffice-profile-{uuid.uuid4().hex}'
    try:
        result = subprocess.run(
            [
                config.soffice_binary,
                '--headless',
                '--norestore',
                f'-env:UserInstallation=file://{profile_dir}',
                '--convert-to', 'pdf',
                '--outdir', str(tmp_dir),
                str(pptx_path),
            ],
            capture_output=True,
            timeout=config.soffice_timeout_seconds,
        )
    except FileNotFoundError:
        raise SofficeNotFoundError(
            'LibreOffice (soffice) is not installed or not on PATH. '
            'Install it (e.g. brew install --cask libreoffice) and retry.'
        )
    except subprocess.TimeoutExpired:
        raise PptxRenderError(f'soffice timed out after {config.soffice_timeout_seconds}s converting the deck to PDF')

    if result.returncode != 0:
        stderr = result.stderr.decode('utf-8', errors='replace').strip()
        raise PptxRenderError(f'soffice failed to convert .pptx to PDF: {stderr or "unknown error"}')

    pdf_path = tmp_dir / (pptx_path.stem + '.pdf')
    if not pdf_path.exists():
        raise PptxRenderError('soffice reported success but produced no PDF output')
    return pdf_path


def _rasterize_pdf(pdf_path, output_dir, config):
    output_dir.mkdir(parents=True, exist_ok=True)
    written = []

    doc = fitz.open(str(pdf_path))
    try:
        for i, page in enumerate(doc, start=1):
            zoom = config.snapshot_target_width_px / page.rect.width
            matrix = fitz.Matrix(zoom, zoom)
            pix = page.get_pixmap(matrix=matrix)
            slide_path = output_dir / f'slide_{i:02d}.png'
            pix.save(str(slide_path))
            written.append(slide_path)
    finally:
        doc.close()

    return written


def render_pptx_to_slides(pptx_path, output_dir, config):
    """Convert `pptx_path` into one PNG per slide, written to `output_dir`
    as slide_01.png, slide_02.png, ... (matching the existing
    snapshots/slide_NN.png naming convention). Returns the list of written
    Paths, in slide order."""
    pptx_path = Path(pptx_path)
    output_dir = Path(output_dir)

    _validate_pptx(pptx_path)

    with tempfile.TemporaryDirectory(prefix='pptx-render-') as tmp:
        tmp_dir = Path(tmp)
        pdf_path = _convert_to_pdf(pptx_path, tmp_dir, config)
        return _rasterize_pdf(pdf_path, output_dir, config)
