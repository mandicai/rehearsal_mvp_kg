"""Generate stock-video and sound-effect search queries for one scene."""
import json
import os

import httpx

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


_SYSTEM_PROMPT = """You formulate two concise external-media search queries for one filmable narration highlight - a short clause the presenter has already chosen to illustrate with a shot.

VIDEO: the highlight IS the concrete visual beat - it defines what is depicted. Use the surrounding narration only to disambiguate the highlight's subject/setting (who or what it refers to), never to replace or broaden it. Documentary mode influences style and atmosphere, never the subject. Return a literal, filmable 3-10 word stock-video query. Avoid academic jargon and camera instructions that a stock search engine cannot match. If the highlight is abstract (academic jargon, an invisible process, a dataset, theory, metric, or idea with no literal footage), return a concrete query that metaphorically or observationally represents it instead (for example, researchers comparing charts, hands annotating data, a close-up of a computer screen).

AUDIO priority:
1. Translate the highlight into a SOUND YOU CAN HEAR, not a description of the research topic.
2. Prefer one familiar sound source or action plus an optional setting: "footsteps in hallway", "paper rustling", "quiet laboratory ambience", "keyboard typing".
3. Use the surrounding narration only to choose that broad, audible source; treat academic names, theories, species, datasets, institutions, and technical terms as context to paraphrase or discard.
4. Prefer common Freesound-style tags and generic searchable wording over rare proper nouns or exact details. If no literal sound is implied, choose a plausible environmental bed such as "room tone", "office ambience", "outdoor ambience", or "subtle machinery hum".
5. Documentary mode may shape the atmosphere (naturalistic, intimate, tense), but never replace the sound source.
Return exactly 2-5 ordinary words (up to 6 only when needed), lower-case, as a sound-effect or ambience search query. No sentence, explanation, abstract concept, music genre, camera language, visual metaphor, or proper noun.

Respond only as JSON: {"video_query":"...","audio_query":"..."}."""


class MediaQueryLLMCallError(Exception):
    pass


class MediaQueryLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('PROXY_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('PROXY_BASE_URL') or os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            kwargs = {'api_key': self.api_key, 'timeout': httpx.Timeout(30.0, connect=5.0), 'max_retries': 0}
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def generate_queries(self, highlight, narration='', documentary_mode=''):
        if not self.is_configured():
            raise MediaQueryLLMCallError('Media-query LLM is not configured (missing API key or openai package)')
        highlight = (highlight or '').strip()
        if not highlight:
            raise MediaQueryLLMCallError('highlight is required')
        payload = {
            'highlight': highlight,
            'narration': (narration or '').strip(),
            'documentary_mode': (documentary_mode or '').strip(),
        }
        try:
            response = self._get_client().chat.completions.create(
                model=self.model,
                messages=[
                    {'role': 'system', 'content': _SYSTEM_PROMPT},
                    {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
                ],
                response_format={'type': 'json_object'},
                temperature=0.35,
            )
            parsed = json.loads(response.choices[0].message.content)
            video = (parsed.get('video_query') or '').strip()
            audio = (parsed.get('audio_query') or '').strip()
            if not video or not audio:
                raise ValueError('response omitted video_query or audio_query')
            return {'video_query': video, 'audio_query': audio}
        except Exception as exc:
            raise MediaQueryLLMCallError(f'Could not generate media queries: {exc}') from exc
