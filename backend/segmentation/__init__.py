# SegmentationPipeline deliberately NOT imported here (unlike PipelineConfig)
# - .pipeline imports spacy and sentence-transformers at module level, real
# memory (see server.py's own _get_pipeline() comment) that a package-level
# re-export would force on anyone importing *anything* from this package,
# even just PipelineConfig. Import it directly from segmentation.pipeline
# where actually needed (server.py's own lazy _get_pipeline()).
from .config import PipelineConfig

__all__ = ['PipelineConfig']
