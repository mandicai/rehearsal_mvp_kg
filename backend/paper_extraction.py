"""Server-side PDF section extraction for html/index.html (see server.py's
/paper/extract route). Unlike the segmentation/feedback pipelines, this runs
entirely in-process - Docling (https://github.com/docling-project/docling)
is a Python library, not a separate service, so there's no client/config
module here, just a converter call.

Docling's DocumentConverter turns a PDF into a DoclingDocument: a flat,
ordered list of labeled items (section_header, title, text, paragraph,
list_item, caption, footnote, formula, code, picture, table, chart, ...).
Iterating that list and starting a new section on every heading-like label
gives the same {title, sections: [{title, text}]} shape js/paper-extract.js's
client-side heuristic already produces for .txt/.md uploads (see
buildSections there).

Confirmed against real generated PDFs this session:
- A heading Docling classifies as "section_header" rather than a separate
  "title" item, which is why title detection below doesn't special-case
  that label.
- An empty heading immediately followed by another heading (an "umbrella"
  header with no body text of its own, e.g. "Design Implications" ->
  "Interface Considerations") - handled below by chaining the umbrella's
  title onto that immediately-following heading, rather than discarding it.
  (Tried making the umbrella persist across every subsequent heading until
  the next umbrella, keyed off SectionHeaderItem.level - but that attribute
  came back uniformly 1 in testing, even against a PDF built from genuine
  Word "Heading 1"/"Heading 2" paragraph styles, so there's no reliable
  depth signal to bound a wider scope. Backed out in favor of this
  narrower, more predictable behavior.)
- A picture/table's caption shows up as its own "caption"-labeled item
  immediately after the figure in iterate_items()'s reading order (also
  resolvable via PictureItem.caption_text(doc) - same string either way).
  Occasionally, if a figure contains OCR-able text (e.g. in-chart labels),
  Docling emits that as a stray TextItem out of true reading order - a
  known, rare artifact this pass doesn't try to correct for.
- A figure's actual image is NOT populated by PictureItem.get_image(doc) by
  default (returns None) - it requires PdfPipelineOptions.generate_picture_
  images=True at converter-construction time, confirmed by rebuilding the
  converter with that flag and getting a real PIL image back.

The DocumentConverter is constructed once at import time, not per-request -
it lazily loads its layout/OCR models on first use, which is the expensive
part (including a one-time model download, needing internet access once).
"""
import base64
import io

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.io import DocumentStream

_HEADING_LABELS = {'section_header', 'title'}
_BODY_LABELS = {'text', 'paragraph', 'list_item', 'footnote', 'formula', 'code'}
_FIGURE_LABELS = {'picture', 'table', 'chart'}
_CAPTION_LABEL = 'caption'
_NO_CAPTION_PLACEHOLDER = '(no caption captured for this figure)'
_PREAMBLE_TITLE = 'Title / Preamble'

_pipeline_options = PdfPipelineOptions()
_pipeline_options.generate_picture_images = True  # otherwise PictureItem.get_image() is always None
_converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_pipeline_options)})


class PaperExtractionError(Exception):
    pass


def _picture_data_url(item, doc):
    """Returns a data: URL for a picture/table/chart item's cropped image,
    or None if Docling couldn't produce one (e.g. a table with no rendered
    image, or a page image that failed to crop)."""
    get_image = getattr(item, 'get_image', None)
    if get_image is None:
        return None
    try:
        image = get_image(doc)
    except Exception:
        return None
    if image is None:
        return None

    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    encoded = base64.b64encode(buffer.getvalue()).decode('ascii')
    return f'data:image/png;base64,{encoded}'


def extract_sections(pdf_bytes, filename):
    """Returns {'title': None, 'sections': [{'title': str, 'text': str, 'image': str|None}, ...]}.
    `title` (top-level) is always None - see module docstring for why a
    separate title field isn't reliably distinguishable from an ordinary
    heading. `image` is a data: URL for figure/table/chart sections when
    Docling could produce one, else None."""
    try:
        stream = DocumentStream(name=filename, stream=io.BytesIO(pdf_bytes))
        result = _converter.convert(stream)
    except Exception as exc:  # corrupt PDF, unsupported content, etc.
        raise PaperExtractionError(f'Failed to extract "{filename}": {exc}')

    doc = result.document
    sections = []
    current = {'title': _PREAMBLE_TITLE, 'text': '', 'image': None}
    last_heading_title = _PREAMBLE_TITLE
    figure_count = 0
    pending_figure = None  # the most recently pushed figure, if its caption hasn't arrived yet

    for item, _level in doc.iterate_items():
        label = str(getattr(item, 'label', ''))
        text = (getattr(item, 'text', '') or '').strip()

        if label in _FIGURE_LABELS:
            if current['text'].strip():
                sections.append(current)
            figure_count += 1
            pending_figure = {
                'title': f'Figure {figure_count}',
                'text': _NO_CAPTION_PLACEHOLDER,
                'image': _picture_data_url(item, doc),
            }
            sections.append(pending_figure)  # pushed immediately - a caption-less figure still shows up
            current = {'title': last_heading_title, 'text': '', 'image': None}  # fresh continuation
            continue

        if not text:
            continue

        if label == _CAPTION_LABEL:
            if pending_figure is not None:
                pending_figure['text'] = text
            else:
                current['text'] += (' ' if current['text'] else '') + text
            continue

        pending_figure = None  # only an immediately-following caption attaches to a figure

        if label in _HEADING_LABELS:
            if current['text'].strip():
                sections.append(current)
                new_title = text
            elif current['title'] not in (_PREAMBLE_TITLE,) and not current['title'].startswith('Figure '):
                # current was itself an empty heading (an "umbrella" with no
                # body text of its own) - carry it forward as a prefix onto
                # this immediately-following heading, instead of discarding it.
                new_title = f"{current['title']}: {text}"
            else:
                new_title = text
            current = {'title': new_title, 'text': '', 'image': None}
            last_heading_title = new_title
        elif label in _BODY_LABELS:
            current['text'] += (' ' if current['text'] else '') + text

    if current['text'].strip():
        sections.append(current)

    return {'title': None, 'sections': sections}
