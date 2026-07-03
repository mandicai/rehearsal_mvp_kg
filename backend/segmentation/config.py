"""Configuration knobs for the segmentation pipeline (see segmentation/pipeline.py)."""
from dataclasses import dataclass, field
from enum import Enum


class BoundaryReason(str, Enum):
    HEADING = 'HEADING'
    SEMANTIC_SHIFT = 'SEMANTIC_SHIFT'
    ENTITY_SHIFT = 'ENTITY_SHIFT'
    KEYPHRASE_SHIFT = 'KEYPHRASE_SHIFT'
    DOCUMENT_START = 'DOCUMENT_START'
    DOCUMENT_END = 'DOCUMENT_END'
    LENGTH_MERGE = 'LENGTH_MERGE'
    LENGTH_SPLIT = 'LENGTH_SPLIT'


@dataclass
class BoundaryWeights:
    semantic: float = 0.5
    entity: float = 0.3
    keyphrase: float = 0.2


@dataclass
class PipelineConfig:
    # embeddings
    embedding_model: str = 'all-MiniLM-L6-v2'
    window_size: int = 1  # 1 = disabled; 2-4 = average adjacent units for boundary decisions

    # NER
    ner_method: str = 'spacy'  # only 'spacy' is implemented; kept for future extension

    # boundary detection
    boundary_weights: BoundaryWeights = field(default_factory=BoundaryWeights)
    similarity_threshold: float = 0.45  # soft boundary score cutoff, in [0, 1]

    # segment length constraints (words, except min which is sentences)
    min_sentences: int = 2
    target_min_words: int = 200
    target_max_words: int = 800
    max_words: int = 1500

    # labeling
    labeling_method: str = 'auto'  # 'auto' | 'llm' | 'local'
    llm_model: str = 'gpt-4o-mini'

    # export
    output_path: str = None
