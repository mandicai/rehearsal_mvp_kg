"""Stage 9: shape a finalized, labeled segment into the exact requested JSON
output format, and (optionally, for offline/CLI use) write it to disk.

`text` is always doc_text[char_start:char_end].strip() - a literal slice of
the original document - never a re-joined string, so it can never drift from
the char offsets it's exported alongside.
"""
import json

from .config import BoundaryReason

_REASON_DESCRIPTIONS = {
    BoundaryReason.HEADING: 'New section/subsection heading',
    BoundaryReason.SEMANTIC_SHIFT: 'Semantic shift in topic between adjacent text',
    BoundaryReason.ENTITY_SHIFT: 'Shift in named entities between adjacent text',
    BoundaryReason.KEYPHRASE_SHIFT: 'Shift in keyphrases between adjacent text',
    BoundaryReason.DOCUMENT_START: 'Start of document',
    BoundaryReason.DOCUMENT_END: 'End of document',
    BoundaryReason.LENGTH_MERGE: 'Merged with a neighboring segment to satisfy minimum length',
    BoundaryReason.LENGTH_SPLIT: 'Split from a longer segment to satisfy maximum length',
}


def _describe(reason: BoundaryReason) -> str:
    return _REASON_DESCRIPTIONS.get(reason, str(reason))


def to_schema_dict(segment, segment_index, document_id, doc_text, label_result) -> dict:
    top_entities = [e['text'] for e in label_result.get('top_entities', [])]
    paragraph_indices = segment.source_paragraph_indices

    return {
        'segment_id': f'{document_id}_seg{segment_index + 1}',
        'document_id': document_id,
        'topic_label': label_result.get('topic_label', ''),
        'summary': label_result.get('summary', ''),
        'text': doc_text[segment.char_start:segment.char_end].strip(),
        'top_entities': top_entities,
        'keyphrases': label_result.get('keyphrases', []),
        'relations': label_result.get('relations', []),
        'source_metadata': {
            'section_title': segment.section_title,
            'subsection_title': segment.subsection_title,
            'paragraph_start': min(paragraph_indices) if paragraph_indices else None,
            'paragraph_end': max(paragraph_indices) if paragraph_indices else None,
            'char_start': segment.char_start,
            'char_end': segment.char_end,
        },
        'boundary_evidence': {
            'start_reason': _describe(segment.start_reason),
            'end_reason': _describe(segment.end_reason),
        },
    }


def export_json(segments: list, path: str) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(segments, f, ensure_ascii=False, indent=2)
