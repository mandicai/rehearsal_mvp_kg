"""Stage 1: parse whatever structure is recoverable from plain text.

Real inputs to this pipeline (see helpers.js/main.js) are: raw .txt/.md file
contents, or a MediaWiki explaintext extract (Wikipedia URLs), or text
extracted client-side from a PDF via pdf.js (which has no paragraph/line
structure at all - pdf.js just joins each page's text items with spaces and
separates pages with "\n\n"). So headings are detected for markdown ('#'
syntax) and MediaWiki ('== Heading ==' syntax) only - for PDF-sourced text,
section/subsection titles will almost always come back None and paragraph
granularity will be page-granularity. That's a known, unavoidable limitation
of the client-side extraction, not something fixable here. Table/caption
detection is intentionally not implemented: MediaWiki's explaintext extract
strips tables, and PDF extraction has no structure to detect them from.
"""
import re
from dataclasses import dataclass
from typing import List, Optional

_MD_HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*#*\s*$')
_WIKI_HEADING_RE = re.compile(r'^(=+)\s*(.+?)\s*=+$')
_LIST_ITEM_RE = re.compile(r'^\s*(?:[-*+]|\d+[.)])\s+\S')


@dataclass
class StructureElement:
    kind: str  # 'heading' | 'paragraph' | 'list'
    text: str
    char_start: int
    char_end: int
    level: Optional[int] = None  # heading level (1 = top), else None
    index: int = 0  # sequential order among all elements

# find headings
def _heading_match(line):
    stripped = line.strip()
    if not stripped:
        return None
    m = _MD_HEADING_RE.match(stripped)
    if m:
        return len(m.group(1)), m.group(2).strip()
    m = _WIKI_HEADING_RE.match(stripped)
    if m:
        return len(m.group(1)) - 1, m.group(2).strip()
    return None

# label blocks of text as a heading, list, or a paragraph
def _classify_block(block_text):
    lines = block_text.splitlines()
    if len(lines) == 1:
        heading = _heading_match(lines[0])
        if heading:
            level, title = heading
            return 'heading', title, level
    if lines and all(_LIST_ITEM_RE.match(l) for l in lines if l.strip()):
        return 'list', block_text, None
    return 'paragraph', block_text, None

# parse text, classify blocks of text
def parse_structure(text: str) -> List[StructureElement]:
    lines = text.splitlines(keepends=True)

    line_starts = []
    pos = 0
    for line in lines:
        line_starts.append(pos)
        pos += len(line)

    elements = []
    i = 0
    n = len(lines)
    index = 0
    while i < n:
        if lines[i].strip() == '':
            i += 1
            continue
        j = i
        while j < n and lines[j].strip() != '':
            j += 1
        block_start = line_starts[i]
        last_line = lines[j - 1]
        block_end = line_starts[j - 1] + len(last_line.rstrip('\r\n'))
        block_text = text[block_start:block_end]

        kind, elem_text, level = _classify_block(block_text)
        elements.append(StructureElement(
            kind=kind,
            text=elem_text,
            char_start=block_start,
            char_end=block_end,
            level=level,
            index=index,
        ))
        index += 1
        i = j

    return elements
