"""Orchestrates every stage: structure -> units -> embeddings ->
entities/keyphrases -> boundaries -> refine -> label -> schema.

Each stage already guards its own n<2/empty edge cases (structure.py on an
empty document, refine.py on a single unit, boundaries.py on fewer than two
units), so this module stays pure orchestration plus the top-level
empty-input short-circuit.
"""
import uuid
from concurrent.futures import ThreadPoolExecutor

import spacy

from .boundaries import BoundaryScorer
from .config import PipelineConfig
from .embeddings import EmbeddingModel, windowed_embeddings
from .entities import SpacyEntityExtractor
from .keyphrases import extract_keyphrase_set
from .labeling import build_labeler
from .refine import SegmentRefiner
from .schema import export_json, to_schema_dict
from .structure import parse_structure
from .units import build_base_units

_LABEL_WORKERS = 4  # segment labeling calls are independent and, in LLM mode, I/O-bound


class SegmentationPipeline:
    def __init__(self, config: PipelineConfig = None, device=None):
        self.config = config or PipelineConfig()
        self.nlp = spacy.load('en_core_web_sm')
        self.embedder = EmbeddingModel(self.config.embedding_model, device=device)

    def run(self, text: str, document_id: str = None) -> list:
        if not text or not text.strip():
            return []

        document_id = document_id or uuid.uuid4().hex

        elements = parse_structure(text)

        units = build_base_units(elements, self.nlp, document_id)
        if not units:
            return []

        raw_embeddings = self.embedder.encode([u.text for u in units])
        windowed = windowed_embeddings(raw_embeddings, self.config.window_size)
        unit_embeddings = {u.unit_id: windowed[i] for i, u in enumerate(units)}

        entity_extractor = SpacyEntityExtractor()
        unit_entities = {u.unit_id: entity_extractor.extract(u) for u in units}
        unit_keyphrases = {u.unit_id: extract_keyphrase_set(u) for u in units}

        scorer = BoundaryScorer(weights=self.config.boundary_weights, threshold=self.config.similarity_threshold)
        forced, soft = scorer.score(units, unit_embeddings, unit_entities, unit_keyphrases)

        refiner = SegmentRefiner(self.config)
        segments = refiner.refine(units, forced, soft, unit_embeddings, unit_entities, unit_keyphrases)
        if not segments:
            return []

        labeler = build_labeler(self.config.labeling_method, self.config.llm_model)
        with ThreadPoolExecutor(max_workers=_LABEL_WORKERS) as pool:
            label_results = list(pool.map(lambda seg: labeler.label(seg, text, unit_entities), segments))

        return [
            to_schema_dict(segment, i, document_id, text, label_result)
            for i, (segment, label_result) in enumerate(zip(segments, label_results))
        ]

    def export(self, segments: list, path: str = None) -> None:
        export_json(segments, path or self.config.output_path)
