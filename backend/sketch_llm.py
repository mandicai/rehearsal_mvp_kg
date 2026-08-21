"""AI-generated storyboard reference image per shot (see server.py's
/paper/generate_sketch route), for index.html's paper-extraction tool -
triggered by a "Generate Sketch" button next to Record Webcam/Find Footage/
Upload once a storyboard's `visual` text exists for that shot. Gives the
researcher something to actually look at for composition/framing before
they go film/record/find real footage.

Same env vars as storyboard_llm.py/edit_plan_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL is NOT used here - unlike the text LLM clients, the model is
    hardcoded (see MODEL below): most of this proxy's image-model catalog
    isn't actually usable at this key's permission level (dall-e-3 is
    explicitly blocked), and gemini-3.1-flash-image was verified live to be
    the best speed/quality balance among the ones that are.

No local fallback - there's no non-LLM way to sketch a shot, so this raises
SketchLLMCallError if unconfigured.
"""
import base64
import os
from concurrent.futures import ThreadPoolExecutor

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

# Ordered image models, tried in turn (see generate_sketch). The first is the
# best speed/quality; the rest are verified-working fallbacks for when it
# rate-limits. The rate limit is a *Vertex* quota (RESOURCE_EXHAUSTED), which
# the gemini-*-image models on this proxy likely share - so the last fallback
# is a non-Vertex gpt-image-* model with a separate quota pool, which keeps
# shots generating even when the whole Vertex bucket is exhausted. All three
# verified live to work at this key's permission level (most of the rest of
# the catalog 403s). Not LLM_MODEL-configurable on purpose.
IMAGE_MODELS = ('gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gpt-image-2')
MODEL = IMAGE_MODELS[0]  # kept for external reference/logging

# Cheaper/faster models for generating a BATCH of example frames to pick from
# (see generate_examples / server.py's /paper/generate_shot_examples), where
# quantity matters more than the polish of a single committed frame.
# gpt-image-1-mini is the low-cost OpenAI image model; the gemini flash-image
# ones are the fast fallback (and share the Vertex quota, so gpt-image leads).
EXAMPLE_IMAGE_MODELS = ('gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gpt-image-2')

# Rate-limit/overload/quota conditions ("RESOURCE_EXHAUSTED", 429, ...) - the
# only errors worth moving on to the next model for; a genuine bad-prompt/
# permission error fails fast (retrying or swapping models wouldn't fix it).
_RETRYABLE_MARKERS = (
    'resource', 'exhaust', 'rate limit', 'ratelimit', 'too many requests',
    '429', '503', 'overloaded', 'unavailable', 'quota', 'try again', 'temporarily',
)


def _is_retryable_image_error(exc):
    msg = str(exc).lower()
    return any(marker in msg for marker in _RETRYABLE_MARKERS)


def _image_size(model, style):
    """A widescreen size for shot frames, square for sketches. gpt-image-* only
    accepts specific sizes (1536x1024 is its 3:2 widescreen); gemini is lenient
    and returns its own resolution from the hint."""
    if style == 'shot_frame':
        return '1536x1024' if model.startswith('gpt-image') else '1792x1024'
    return '1024x1024'

# Mood/composition style per documentary mode (see documentary_modes.py) -
# same stylistic axis as storyboard_llm.py/edit_plan_llm.py's _MODE_GUIDANCE,
# but a short clause appended to the image prompt rather than a paragraph of
# instructions. Keys must exactly match DOCUMENTARY_MODE_KEYS - checked below.
_MODE_SKETCH_STYLE = {
    'expository': 'clear, evenly lit, diagram-like composition',
    'observational': 'candid, naturalistic framing, as if caught in the moment',
    'participatory': 'framed like an interview shot, subject facing the camera and the camera crew present',
    'poetic': 'artistic, moody, atmospheric, soft lighting',
}
assert set(_MODE_SKETCH_STYLE) == set(DOCUMENTARY_MODE_KEYS), 'sketch_llm._MODE_SKETCH_STYLE keys must match documentary_modes.DOCUMENTARY_MODE_KEYS'


def _build_image_prompt(visual, documentary_mode=None, style='sketch', framing=None):
    """The image prompt for a shot frame or a rough sketch panel - shared by
    generate_sketch and generate_examples. For 'shot_frame', a framing clause
    (shot size / perspective - see shot_plan_llm.framing_directive) LEADS the
    prompt so the model composes that specific perspective, not a generic mid-shot."""
    mode_clause = f' {_MODE_SKETCH_STYLE[documentary_mode]}.' if documentary_mode in _MODE_SKETCH_STYLE else ''

    if style == 'shot_frame':
        framing_clause = f'Shot framing: {framing.strip()}. ' if (framing or '').strip() else ''
        return (
            f'{framing_clause}A single cinematic documentary film frame, 16:9 widescreen composition. This image '
            'IS the shot itself - exactly what the camera captures, the footage the audience sees. Do NOT depict the '
            'filming equipment or crew (no camera, camera operator, film crew, boom microphone, tripod, or '
            'clapperboard, and no one holding or pointing a camera) - show only the subject(s) and setting being '
            'filmed, as seen through the lens. (Screens, monitors, or instruments that are part of the scene itself '
            'are fine.) Photorealistic documentary cinematography with natural textures, believable '
            'human features, physically plausible lighting, and a grounded real-world color palette. '
            'Treat this as a real film frame rather than an illustration or storyboard drawing. No text, '
            'no captions, no letterbox bars, no panel borders - just the framed scene '
            f'filling the whole image.{mode_clause} The frame shows: {visual}'
        )
    style_clause = f' Style:{mode_clause}' if mode_clause else ''
    return (
        'A single storyboard panel, rough black-and-white pencil sketch style - loose hand-drawn '
        'line art, not a finished illustration. Include a small corner label with a shot number, '
        'and a brief camera-direction note (framing/movement) below or beside the panel, like a '
        f'real film storyboard.{style_clause} The panel depicts: {visual}'
    )


class SketchLLMCallError(Exception):
    pass


class SketchLLMClient:
    def __init__(self):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            # Measured ~13s live for this model - comfortably under this
            # budget, but still well above the 30s text-call pattern's
            # connect timeout alone would allow for. max_retries=0 so the
            # SDK's own default retries don't compound with a caller-level
            # retry into a much longer wait than either alone.
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(45.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def generate_sketch(self, visual, documentary_mode=None, style='sketch', framing=None):
        """visual: a shot's visual description - a plain-English scene
        description, already free of literal academic jargon (from
        storyboard_llm's `visual` or shot_plan_llm's `visual_description`).
        documentary_mode: optional key into DOCUMENTARY_MODE_KEYS (see
        documentary_modes.py) - same stylistic axis as storyboard/edit-plan,
        biasing mood/composition.
        style: 'sketch' (default) = the rough B&W storyboard panel used by the
        Generate-Sketch flow; 'shot_frame' = a photorealistic 16:9
        documentary film frame in a natural palette,
        used for the narration-driven start/end frames (shot_plan_llm) that get
        hard-cut into the rendered MP4.
        Returns raw PNG bytes. On a rate-limit/overload/quota error it falls
        through to the next model in IMAGE_MODELS (a bad prompt/permission error
        fails fast instead); raises only if every model is exhausted."""
        if not self.is_configured():
            raise SketchLLMCallError('LLM client is not configured (missing API key or openai package)')

        prompt = _build_image_prompt(visual, documentary_mode, style, framing)

        # Try each model in turn: a rate-limited/exhausted model is skipped
        # immediately for the next (rather than waiting out a quota that may be
        # a shared-across-Vertex cap), while a genuine bad-prompt/permission
        # error fails fast without burning the fallbacks.
        client = self._get_client()
        last_error = None
        for model in IMAGE_MODELS:
            try:
                response = client.images.generate(model=model, prompt=prompt, size=_image_size(model, style), n=1)
                b64_data = response.data[0].b64_json
                if not b64_data:
                    raise ValueError('response had no b64_json image data')
                return base64.b64decode(b64_data)
            except Exception as exc:  # network errors, malformed response, API errors
                last_error = exc
                if not _is_retryable_image_error(exc):
                    raise SketchLLMCallError(f'Sketch generation failed: {exc}')

        # Every model was rate-limited/exhausted.
        raise SketchLLMCallError(
            'All image models are rate-limited or over quota right now (resources exhausted). '
            f'Wait a minute and try again. ({last_error})'
        )

    def generate_sketch_from_image(self, image_bytes, visual, documentary_mode=None, style='shot_frame'):
        """Image-to-image: re-frame an EXISTING frame (image_bytes, PNG) into a
        new framing (visual) while keeping the same subject/setting. Used for a
        shot's END frame so it's guaranteed to show the same people/place as the
        START frame it's edited from (see server.py's /paper/generate_shot) -
        text-to-image alone can't guarantee that even from an identical prompt.

        Same PNG-bytes contract as generate_sketch. Tries each model in
        IMAGE_MODELS via the images.edit endpoint; unlike generate_sketch it
        keeps trying on ANY error (a model that doesn't support editing just
        gets skipped for the next), and raises only if none can edit - so the
        caller can cleanly fall back to text-to-image."""
        if not self.is_configured():
            raise SketchLLMCallError('LLM client is not configured (missing API key or openai package)')

        mode_clause = f' {_MODE_SKETCH_STYLE[documentary_mode]}.' if documentary_mode in _MODE_SKETCH_STYLE else ''
        prompt = (
            'Re-frame the provided image into a new camera framing WITHOUT changing the scene: keep the exact '
            'same people (same faces, wardrobe, and number of people), the same objects, the same setting, the '
            'same lighting, color palette, and photorealistic documentary style as the provided image. Only the '
            f'framing/composition changes.{mode_clause} New framing: {visual[:800]}. '
            'No text, no captions, no letterbox bars, no panel borders - just the framed scene filling the image.'
        )

        client = self._get_client()
        last_error = None
        for model in IMAGE_MODELS:
            try:
                response = client.images.edit(
                    model=model,
                    image=('start.png', image_bytes, 'image/png'),
                    prompt=prompt,
                    size=_image_size(model, style),
                )
                b64_data = response.data[0].b64_json
                if not b64_data:
                    raise ValueError('response had no b64_json image data')
                return base64.b64decode(b64_data)
            except Exception as exc:  # incl. "edit not supported" - just try the next model
                last_error = exc

        raise SketchLLMCallError(f'Image-to-image edit unavailable/failed on all models: {last_error}')

    def generate_examples(self, specs, documentary_mode=None, style='shot_frame', reference_image_bytes=None):
        """A batch of independently sampled example frames, one per spec, using the
        cheap/fast EXAMPLE_IMAGE_MODELS (see server.py's
        /paper/generate_shot_examples). `specs` is a list of
        {'visual', 'framing'}; callers may repeat the same bold prompt to get
        multiple model interpretations. The specs are independent, so they're generated
        CONCURRENTLY (one thread per spec - the image client is blocking I/O)
        so the batch's wall-clock time is ~one image, not the sum. Returns a
        list of PNG bytes ALIGNED to specs, with None for any that failed;
        raises only if every spec failed."""
        if not self.is_configured():
            raise SketchLLMCallError('LLM client is not configured (missing API key or openai package)')

        client = self._get_client()
        specs = list(specs or [])

        errors = []

        def _one(spec):
            prompt = _build_image_prompt(spec.get('visual', ''), documentary_mode, style, spec.get('framing'))

            for model in EXAMPLE_IMAGE_MODELS:  # one image per spec, model fallback on failure
                try:
                    if reference_image_bytes:
                        resp = client.images.edit(
                            model=model,
                            image=('scene-sketch.png', reference_image_bytes, 'image/png'),
                            prompt=prompt + ' Preserve the concrete subjects, objects, setting, and action shown in the uploaded scene sketch.',
                            size=_image_size(model, style))
                    else:
                        resp = client.images.generate(model=model, prompt=prompt, size=_image_size(model, style), n=1)
                    if resp.data and resp.data[0].b64_json:
                        return base64.b64decode(resp.data[0].b64_json)
                except Exception as exc:
                    errors.append(exc)
                    continue
            return None

        if not specs:
            return []
        # map preserves order, so results stay ALIGNED to specs
        with ThreadPoolExecutor(max_workers=len(specs)) as pool:
            results = list(pool.map(_one, specs))

        if not any(r is not None for r in results):
            raise SketchLLMCallError(f'Example generation failed on all models: {errors[-1] if errors else "unknown"}')
        return results
