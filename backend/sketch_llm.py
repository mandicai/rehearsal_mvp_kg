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

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

# Verified live (see the plan this was built from) - the best speed/quality
# balance among this proxy's actually-usable image models. Not
# LLM_MODEL-configurable on purpose; most of the catalog 403s at this key's
# permission level, so this isn't a generic "pick your model" setting.
MODEL = 'gemini-3.1-flash-image'

# Mood/composition style per documentary mode (see documentary_modes.py) -
# same stylistic axis as storyboard_llm.py/edit_plan_llm.py's _MODE_GUIDANCE,
# but a short clause appended to the image prompt rather than a paragraph of
# instructions. Keys must exactly match DOCUMENTARY_MODE_KEYS - checked below.
_MODE_SKETCH_STYLE = {
    'expository': 'clear, evenly lit, diagram-like composition',
    'observational': 'candid, naturalistic framing, as if caught in the moment',
    'participatory': 'framed like an interview shot, subject facing the camera',
    'poetic': 'moody, atmospheric, soft lighting',
}
assert set(_MODE_SKETCH_STYLE) == set(DOCUMENTARY_MODE_KEYS), 'sketch_llm._MODE_SKETCH_STYLE keys must match documentary_modes.DOCUMENTARY_MODE_KEYS'


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

    def generate_sketch(self, visual, documentary_mode=None):
        """visual: a shot's storyboard 'visual' text (storyboard_llm.py's
        generate_storyboard output) - a plain-English scene description,
        already free of literal academic jargon.
        documentary_mode: optional key into DOCUMENTARY_MODE_KEYS (see
        documentary_modes.py) - same stylistic axis as storyboard/edit-plan,
        biasing sketch mood/composition rather than narration/pacing.
        Returns raw PNG bytes. No tolerant-parsing/retry-loop here (unlike
        the text clients) - an image call either returns a usable image or
        it doesn't; there's no partial-response case to patch around."""
        if not self.is_configured():
            raise SketchLLMCallError('LLM client is not configured (missing API key or openai package)')

        style_clause = f' Style: {_MODE_SKETCH_STYLE[documentary_mode]}.' if documentary_mode in _MODE_SKETCH_STYLE else ''
        prompt = (
            'A single storyboard panel, rough black-and-white pencil sketch style - loose hand-drawn '
            'line art, not a finished illustration. Include a small corner label with a shot number, '
            'and a brief camera-direction note (framing/movement) below or beside the panel, like a '
            f'real film storyboard.{style_clause} The panel depicts: {visual}'
        )

        try:
            client = self._get_client()
            response = client.images.generate(model=MODEL, prompt=prompt, size='1024x1024', n=1)
            b64_data = response.data[0].b64_json
            if not b64_data:
                raise ValueError('response had no b64_json image data')
            return base64.b64decode(b64_data)
        except Exception as exc:  # network errors, malformed response, API errors
            raise SketchLLMCallError(f'Sketch generation failed: {exc}')
