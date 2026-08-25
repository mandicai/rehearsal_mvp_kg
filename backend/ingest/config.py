"""Configuration knobs for the ingest package (see pptx_render.py,
transcription.py, align.py) - the data-collection pipeline behind
presenter-view.html. Independent of segmentation/segmentation_carta's configs;
this package has no shared imports with either."""
from dataclasses import dataclass


@dataclass
class IngestConfig:
    soffice_binary: str = 'soffice'          # must be on PATH - see requirements.txt for install instructions
    soffice_timeout_seconds: int = 120       # PDF conversion of a large deck can be slow; bail out rather than hang a request
    snapshot_target_width_px: int = 1280     # matches typical existing snapshots/slide_NN.png resolution
    transcription_model: str = 'whisper-1'  # OpenAI transcription endpoint; returns word/segment timestamps
