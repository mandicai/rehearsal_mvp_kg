"""AI-generated animated storyboard preview per shot (see server.py's
/paper/generate_animated_sketch, /paper/generate_video_from_text, and
/paper/generate_sketch_sequence routes), for the storyboard tool's per-shot
"Pan"/"Push in"/"Pull out" actions - a short clip demonstrating one specific
camera technique. Three interchangeable ways to produce that clip, all
selectable from the same UI (see js/paper-extract.js's
animate-method-select):
  - generate_animated_sketch: animates that shot's already-generated rough
    sketch (see sketch_llm.py) via a real image-to-video model. Most
    faithful to the exact composition the researcher already saw.
  - generate_text_to_video: builds a prompt from the shot's own visual
    description (the same text sketch_llm.py's generate_sketch would draw
    from) and generates a clip directly, with no sketch image required
    first.
  - build_sequence_prompts + compose_gif: a cheaper non-video-model
    alternative - generates 2-3 still sketches depicting progressive
    stages of the camera move (via sketch_llm.py, called once per frame),
    then stitches them into a hard-cut, looping animated GIF locally (via
    Pillow). No model call at all for the "animation" itself, and no video
    encoding either - a genuine GIF, not a video file.

Same env vars as sketch_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL is NOT used here - like sketch_llm.py, the model is hardcoded
    (see MODEL below): verified live against this proxy's actual catalog
    (client.models.list()), which exposes real Veo video models via
    vertex_ai/ - most of this proxy's catalog is permission-gated, so
    nothing about model availability can be assumed without checking.

No local fallback for the two model-based paths - there's no non-LLM way to
generate a video, so those raise AnimateLLMCallError if unconfigured.
"""
import io
import os
import time

import httpx
from PIL import Image

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

# Verified live (see the plan this was built from) - a real image-to-video
# model on this proxy's catalog, routed through Vertex AI. Not
# LLM_MODEL-configurable on purpose, same reasoning as sketch_llm.py's MODEL.
MODEL = 'vertex_ai/veo-3.1-fast-generate-001'

# Same 4-direction vocabulary as edit_plan_llm.py's ken_burns.pan (_PANS) -
# kept as its own constant here rather than imported, matching this
# codebase's existing convention of small shared vocabularies kept in sync
# by convention rather than cross-imported (e.g. documentary_modes.py's
# DOCUMENTARY_MODE_KEYS vs. js/paper-extract.js's DOCUMENTARY_MODES) - this
# module has no other reason to depend on edit_plan_llm.py, and the two
# features (export-time zoom vs. a live preview clip) are otherwise unrelated.
TECHNIQUES = ('left_to_right', 'right_to_left', 'in', 'out')

_TECHNIQUE_PROMPTS = {
    'left_to_right': 'The camera slowly pans from left to right across the scene.',
    'right_to_left': 'The camera slowly pans from right to left across the scene.',
    'in': 'The camera slowly pushes in toward the main subject.',
    'out': 'The camera slowly pulls back, away from the scene.',
}

# Same stylistic axis as sketch_llm.py's _MODE_SKETCH_STYLE, adapted to
# movement quality rather than composition/lighting - not asserted against
# DOCUMENTARY_MODE_KEYS since it's only ever looked up with `.get`, same as
# an optional clause below.
_MODE_CAMERA_FEEL = {
    'expository': 'smooth, deliberate movement',
    'observational': 'handheld, slightly unsteady movement, as if caught in the moment',
    'participatory': 'a gentle, natural movement',
    'poetic': 'slow, dreamlike movement',
}

# Veo output is a fixed 1280x720/4s clip - both are the smallest supported
# combination on this proxy's Literal-typed size/seconds enums, kept short
# since this is a rough preview of a technique, not a finished shot.
SECONDS = '4'
SIZE = '1280x720'

# Live-measured full round trip is ~50s for a 4s clip - this caps a stuck
# job well above that. Polled manually (not via the SDK's own
# create_and_poll/poll helpers) because those only keep polling while
# status is 'in_progress' or 'queued' (OpenAI/Sora's own vocabulary) -
# verified live that this proxy's Vertex-routed Veo jobs report 'processing'
# instead, which poll() doesn't recognize as non-terminal, so it returns
# immediately with the job still running.
_POLL_INTERVAL_SECONDS = 5
_POLL_TIMEOUT_SECONDS = 280

# Per-technique framing at the start/middle/end of the move, for the
# sketch-sequence/GIF path (build_sequence_prompts below) - each appended to the
# shot's own visual description as an extra clause, so sketch_llm.py's
# generate_sketch draws the SAME scene at a different point in the camera
# move rather than three unrelated images. There's no image-to-image
# conditioning here (this proxy's image model wasn't verified to support
# it) - consistency across frames relies on prompt wording alone (see
# build_sequence_prompts' own consistency_clause), which is looser than a
# real interpolation model but consistent with this feature's "very rough,
# not photorealistic" bar throughout.
_TECHNIQUE_FRAME_CLAUSES = {
    'left_to_right': (
        'Framed toward the right side of the scene, as if the camera has not yet begun moving.',
        'A midpoint framing, midway through a left-to-right camera pan.',
        'Framed toward the left side of the scene, as if the camera has finished panning left.',
    ),
    'right_to_left': (
        'Framed toward the left side of the scene, as if the camera has not yet begun moving.',
        'A midpoint framing, midway through a right-to-left camera pan.',
        'Framed toward the right side of the scene, as if the camera has finished panning right.',
    ),
    'in': (
        'A wide establishing framing of the scene, before the camera begins pushing in.',
        'A medium framing, midway through a push in toward the main subject.',
        'A close, tight framing of the main subject, as if the camera has finished pushing in.',
    ),
    'out': (
        'A close, tight framing of the main subject, before the camera begins pulling back.',
        'A medium framing, midway through a pull back from the main subject.',
        'A wide establishing framing of the scene, as if the camera has finished pulling back.',
    ),
}

# How long each still is held on screen in compose_gif below (milliseconds,
# via the GIF's own per-frame duration field) - not user-facing, so tuned
# once rather than exposed as a setting.
_FRAME_HOLD_SECONDS = 1.3


class AnimateLLMCallError(Exception):
    pass


class AnimateLLMClient:
    def __init__(self):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            # Measured ~50s live for a 4s clip (create() call itself ~16s,
            # then polling until the job completes) - comfortably under this
            # budget. max_retries=0 so the SDK's own default retries don't
            # compound with a caller-level retry into a much longer wait
            # than either alone.
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(180.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def _create_and_wait(self, client, **create_kwargs):
        """Shared by generate_animated_sketch/generate_text_to_video below -
        the only difference between an image-to-video and a text-to-video
        call is whether create_kwargs includes input_reference, so both
        just build their own prompt/kwargs and hand off here."""
        video = client.videos.create(**create_kwargs)

        start = time.monotonic()
        while video.status not in ('completed', 'failed'):
            if time.monotonic() - start > _POLL_TIMEOUT_SECONDS:
                raise ValueError(f'video generation timed out after {_POLL_TIMEOUT_SECONDS}s (last status={video.status!r})')
            time.sleep(_POLL_INTERVAL_SECONDS)
            video = client.videos.retrieve(video.id)

        if video.status != 'completed':
            raise ValueError(f'video generation failed: {video.error}')

        content = client.videos.download_content(video.id)
        return content.read()

    def generate_animated_sketch(self, sketch_png_bytes, technique, documentary_mode=None):
        """sketch_png_bytes: an already-generated rough sketch for this shot
        (see sketch_llm.py's generate_sketch) - animated in place, not
        redrawn from a text description, so the clip actually demonstrates
        the same composition the researcher already saw.
        technique: one of TECHNIQUES.
        documentary_mode: optional key into DOCUMENTARY_MODE_KEYS (see
        documentary_modes.py) - same stylistic axis as sketch_llm.py,
        biasing movement quality rather than mood/composition.
        Returns raw MP4 bytes."""
        if not self.is_configured():
            raise AnimateLLMCallError('LLM client is not configured (missing API key or openai package)')
        if technique not in TECHNIQUES:
            raise AnimateLLMCallError(f'technique must be one of {TECHNIQUES}')

        feel_clause = f' Use {_MODE_CAMERA_FEEL[documentary_mode]}.' if documentary_mode in _MODE_CAMERA_FEEL else ''
        prompt = (
            'Animate this rough black-and-white pencil-sketch storyboard panel exactly as drawn - '
            'keep the loose hand-drawn line art style, do not redraw it realistically or add color. '
            f'{_TECHNIQUE_PROMPTS[technique]}{feel_clause}'
        )

        try:
            client = self._get_client()
            return self._create_and_wait(
                client, prompt=prompt, model=MODEL,
                input_reference=('sketch.png', sketch_png_bytes, 'image/png'),
                seconds=SECONDS, size=SIZE,
            )
        except Exception as exc:  # network errors, malformed response, API errors
            raise AnimateLLMCallError(f'Animated sketch generation failed: {exc}')

    def generate_text_to_video(self, visual, technique, documentary_mode=None):
        """visual: a shot's storyboard 'visual' text (the same field
        sketch_llm.py's generate_sketch draws from) - no sketch image
        required first, unlike generate_animated_sketch above.
        technique: one of TECHNIQUES.
        documentary_mode: see generate_animated_sketch.
        Returns raw MP4 bytes."""
        if not self.is_configured():
            raise AnimateLLMCallError('LLM client is not configured (missing API key or openai package)')
        if technique not in TECHNIQUES:
            raise AnimateLLMCallError(f'technique must be one of {TECHNIQUES}')

        feel_clause = f' Use {_MODE_CAMERA_FEEL[documentary_mode]}.' if documentary_mode in _MODE_CAMERA_FEEL else ''
        # A softer "rough pencil sketch style, not photorealistic" phrasing
        # (matching generate_animated_sketch's own prompt above) was verified
        # live to NOT be enough here - with no reference image to anchor it,
        # this model defaults to fully photorealistic, cinematic footage
        # regardless. The blunter, repeated negatives below (also verified
        # live) are what actually gets a hand-drawn pencil-sketch result.
        prompt = (
            'A 2D hand-drawn animatic in the style of a rough film storyboard - flat black-and-white '
            'pencil sketch line art with visible pencil strokes and cross-hatching, like a rough '
            'animated pencil test. Absolutely NOT photorealistic, NOT live-action, NOT cinematic '
            'footage, NOT 3D rendered - a loose 2D sketch drawing style throughout, like a hand-drawn '
            f'flipbook animation. {_TECHNIQUE_PROMPTS[technique]}{feel_clause} The scene: {visual}'
        )

        try:
            client = self._get_client()
            return self._create_and_wait(client, prompt=prompt, model=MODEL, seconds=SECONDS, size=SIZE)
        except Exception as exc:  # network errors, malformed response, API errors
            raise AnimateLLMCallError(f'Text-to-video generation failed: {exc}')


def build_sequence_prompts(visual, technique, frame_count=3):
    """Turns one shot's visual description into 2-3 variants, each biased
    toward a different stage of the given camera technique (see
    _TECHNIQUE_FRAME_CLAUSES) - fed to sketch_llm.py's generate_sketch once
    per frame (by the caller - this module has no sketch_llm dependency),
    then those stills go to compose_gif below. Pure string
    building, no LLM/network call here."""
    if technique not in _TECHNIQUE_FRAME_CLAUSES:
        raise AnimateLLMCallError(f'technique must be one of {TECHNIQUES}')
    if frame_count not in (2, 3):
        raise AnimateLLMCallError('frame_count must be 2 or 3')

    clauses = _TECHNIQUE_FRAME_CLAUSES[technique]
    chosen = (clauses[0], clauses[-1]) if frame_count == 2 else clauses
    consistency_clause = (
        ' Keep the exact same subject, setting, and character(s) as the rest of this shot - '
        'change only the camera framing/distance described next.'
    )
    return [f'{visual}{consistency_clause} {clause}' for clause in chosen]


def compose_gif(frame_png_bytes_list):
    """Stitches 2-3 still images (already-generated sketches, one per
    build_sequence_prompts entry) into a single looping animated GIF - a
    hard cut between frames, no crossfade/blend, genuinely "like a GIF"
    rather than a video. No model inference in this function at all, just
    local compositing (via Pillow, no ffmpeg needed here), which is what
    makes this path cheaper than generate_animated_sketch/
    generate_text_to_video above."""
    if not (2 <= len(frame_png_bytes_list) <= 3):
        raise AnimateLLMCallError('sketch sequence needs 2 or 3 frames')

    frames = [Image.open(io.BytesIO(png_bytes)).convert('RGB') for png_bytes in frame_png_bytes_list]
    buffer = io.BytesIO()
    frames[0].save(
        buffer, format='GIF', save_all=True, append_images=frames[1:],
        duration=int(_FRAME_HOLD_SECONDS * 1000), loop=0,
    )
    return buffer.getvalue()
