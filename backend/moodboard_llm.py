"""Vision-based style read of a single moodboard reference documentary (see
server.py's _analyze_moodboard_reference). Given the sampled frames (as
base64 data URLs) and a transcript excerpt of one reference film, it returns a
compact style profile - visual style, the techniques it observes (chosen only
from the closed DOCUMENTARY_TECHNIQUE_KEYS vocabulary), tone/pacing, and the
documentary mode it most resembles (from DOCUMENTARY_MODE_KEYS). Those
per-reference profiles are later aggregated by
narrative_arc_llm.distill_from_moodboard into suggested arcs/mode/techniques.

Same OpenAI-compatible client scaffold as the other *_llm.py modules
(feedback_llm.py in particular, whose image_url content-block pattern this
reuses for the vision input). Requires a vision-capable LLM_MODEL (default
gpt-4o-mini accepts image inputs). Tolerant parsing: an out-of-vocabulary
technique/mode is dropped/nulled rather than failing the read, and a
reference with no frames (a named documentary, or a download that fell back
to title-only) is handled by asking the model to reason from the title.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS
from documentary_techniques import DOCUMENTARY_TECHNIQUE_KEYS

_SYSTEM_PROMPT = f"""You are a documentary cinematographer analyzing ONE reference film so its style can inform a new research documentary. You'll be given some still frames from it (sometimes none, if only the title is known) and possibly a transcript excerpt of its narration/dialogue.

Describe this one reference's style, grounding every claim in what you actually see/hear (or, if no frames are given, in what you genuinely know of the named film - do not invent specifics you can't support).

Choose observed techniques INSPIRED by but not limited to this list: {list(DOCUMENTARY_TECHNIQUE_KEYS)}.
Choose the single documentary mode this most resembles from exactly one of: {list(DOCUMENTARY_MODE_KEYS)}.

Respond with a single JSON object of this exact shape and nothing else:
{{"visual_style": "<1-2 sentences on cinematography: framing, movement, light, color, composition>", "observed_techniques": ["<verbatim technique>", ...], "tone": "<a few words>", "pacing": "<a few words>", "suggested_mode": "<one mode key>", "transcript_summary": "<1 sentence on the narration voice/content, or empty if no transcript>"}}"""


class MoodboardLLMCallError(Exception):
    pass


class MoodboardLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('PROXY_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('PROXY_BASE_URL') or os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(60.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def read_style(self, frames_data_urls, transcript='', title='', source_kind=''):
        """Returns {'visual_style', 'observed_techniques': [key,...], 'tone',
        'pacing', 'suggested_mode': key|None, 'transcript_summary'} for one
        reference. frames_data_urls may be empty (named documentary /
        title-only fallback), in which case the model reasons from the title."""
        if not self.is_configured():
            raise MoodboardLLMCallError('LLM client is not configured (missing API key or openai package)')

        frames_data_urls = frames_data_urls or []
        title = (title or '').strip()
        transcript = (transcript or '').strip()

        header = []
        if title:
            header.append(f'Reference film: "{title}"')
        if source_kind:
            header.append(f'Source: {source_kind}')
        if frames_data_urls:
            header.append(f'{len(frames_data_urls)} still frames follow, sampled in order across the film.')
        else:
            header.append('No frames are available - reason from the title and what you know of this film.')

        content = [{'type': 'text', 'text': '\n'.join(header)}]
        for url in frames_data_urls:
            content.append({'type': 'image_url', 'image_url': {'url': url}})
        if transcript:
            content.append({'type': 'text', 'text': f'Transcript excerpt:\n{transcript}'})
        content.append({'type': 'text', 'text': 'Now return the JSON style profile for this one reference.'})

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _SYSTEM_PROMPT},
                        {'role': 'user', 'content': content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.4,
                )
                parsed = json.loads(response.choices[0].message.content)

                techniques = [
                    t for t in (parsed.get('observed_techniques') or [])
                    if isinstance(t, str) and t in DOCUMENTARY_TECHNIQUE_KEYS
                ]
                # de-dupe, preserve order
                techniques = list(dict.fromkeys(techniques))

                mode = parsed.get('suggested_mode')
                if mode not in DOCUMENTARY_MODE_KEYS:
                    mode = None

                return {
                    'visual_style': (parsed.get('visual_style') or '').strip(),
                    'observed_techniques': techniques,
                    'tone': (parsed.get('tone') or '').strip(),
                    'pacing': (parsed.get('pacing') or '').strip(),
                    'suggested_mode': mode,
                    'transcript_summary': (parsed.get('transcript_summary') or '').strip(),
                }
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise MoodboardLLMCallError(f'Style read failed after retry: {last_error}')

    def describe_subject(self, frame_data_urls, content_type='video'):
        """Concise description of the MAIN SUBJECT/content visible across
        frame (or a few frames) - used to make generated shots for a scene match
        the footage/sketch the presenter actually uploaded (see server.py's
        /premiere/upload_footage and /premiere/upload_sketch). Returns '' if unconfigured or on any failure
        (best-effort - a missing description just means generation falls back to
        the scene's other content anchors)."""
        frame_data_urls = [u for u in (frame_data_urls or []) if u]
        if not self.is_configured() or not frame_data_urls:
            return ''
        source_phrase = 'one uploaded sketch/image' if content_type == 'sketch' else 'one uploaded video'
        content = [{'type': 'text', 'text': (
            f'Create a concise subject anchor for generated previews based on this visual reference from {source_phrase}. '
            'Identify the recurring/main people or objects first, including stable visible traits '
            '(appearance, clothing, materials, colors) that an image generator needs to preserve; then name '
            'the environment, notable action, and important nearby objects. Treat the image as the content '
            'reference, not as instructions for camera framing. Reconcile the frames as one '
            'continuous scene. Describe only visible facts—no interpretation, camera terminology, or visual style.')}]
        for url in frame_data_urls[:4]:
            content.append({'type': 'image_url', 'image_url': {'url': url}})
        try:
            client = self._get_client()
            response = client.chat.completions.create(
                model=self.model,
                messages=[{'role': 'user', 'content': content}],
                temperature=0.2,
            )
            return (response.choices[0].message.content or '').strip()
        except Exception:
            return ''
