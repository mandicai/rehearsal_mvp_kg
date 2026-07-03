"""Stage 2: turn structure elements into base text units.

Headings are never turned into their own units - they're attached as
section_title/subsection_title metadata on whatever paragraph/list unit
follows them. This sidesteps an entire class of degenerate cases (heading-only
segments, two adjacent headings with no body text between them) by
construction, at the cost of headings with genuinely empty sections simply
not being represented as a unit at all (acceptable: there is no content to
extract entities/relations from anyway).

Every unit keeps char_start/char_end that are always valid offsets into the
*original* document text, even after a paragraph is split into sentences -
`unit.text` is a cleaned copy used for embeddings/NER, but final exported
segment text (schema.py) always re-slices the original document rather than
joining unit.text values, so it can never drift from the offsets.
"""
from dataclasses import dataclass, field
from typing import List, Optional

from .structure import StructureElement

# Paragraphs longer than this are split into individual sentences so boundary
# detection isn't forced to treat a long wall of text as one atomic unit.
LONG_PARAGRAPH_WORD_THRESHOLD = 150

# Units shorter than this are flagged as candidates for the length-refinement
# merge pass (segment.py), not merged here - merging is a segment-level
# decision made after boundaries are drafted.
SHORT_UNIT_WORD_THRESHOLD = 30


@dataclass
class Unit:
    unit_id: str
    text: str
    char_start: int
    char_end: int
    source_paragraph_indices: List[int]
    section_title: Optional[str]
    subsection_title: Optional[str]
    spacy_doc: object = field(repr=False, default=None)
    is_merge_eligible: bool = False
    is_list: bool = False


def _split_long_paragraph(element: StructureElement, nlp):
    """Split one long paragraph into sentence-level sub-spans, propagating
    char offsets back to document-absolute positions."""
    doc = nlp(element.text) # split into sentence-level sub-spans
    spans = []
    for sent in doc.sents:
        text = sent.text.strip()
        if not text:
            continue
        spans.append((
            text,
            element.char_start + sent.start_char,
            element.char_start + sent.end_char, # keep char spans
        ))
    return spans


def build_base_units(elements: List[StructureElement], nlp, document_id: str) -> List[Unit]:
    units = []
    current_section = None
    current_subsection = None
    counter = 0

    for element in elements:
        if element.kind == 'heading':
            if element.level is not None and element.level <= 1: # if it is at the heading level
                current_section = element.text
                current_subsection = None
            else:
                current_subsection = element.text
            continue

        if element.kind == 'list':
            spans = [(element.text, element.char_start, element.char_end)] # keep char spans
        else: # if it's a paragraph
            word_count = len(element.text.split()) # split into words
            if word_count > LONG_PARAGRAPH_WORD_THRESHOLD:
                spans = _split_long_paragraph(element, nlp)
            else:
                spans = [(element.text, element.char_start, element.char_end)] # keep char spans

        # spans is a list of sets with these 3 elements
        for text, char_start, char_end in spans:
            text = text.strip()
            if not text:
                continue
            word_count = len(text.split())
            units.append(Unit(
                unit_id=f'{document_id}_u{counter}',
                text=text,
                char_start=char_start,
                char_end=char_end,
                source_paragraph_indices=[element.index],
                section_title=current_section,
                subsection_title=current_subsection,
                spacy_doc=nlp(text),
                is_merge_eligible=word_count < SHORT_UNIT_WORD_THRESHOLD,
                is_list=(element.kind == 'list'),
            ))
            counter += 1

    return units
