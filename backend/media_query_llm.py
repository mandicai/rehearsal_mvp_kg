"""Generate stock-video and sound-effect search queries for one scene."""
import json
import os

import httpx

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


_SYSTEM_PROMPT = """You formulate two concise external-media search queries for a documentary scene.

VIDEO priority (highest first):
1. The filmable narration fragment defines the concrete visual beat, when provided.
2. The reference-footage subject/entities define WHAT is depicted, when provided.
3. Scene notes and scene techniques define the intended action, composition, and visual treatment.
4. Narration, title, act, and abstract fill missing subject/context.
4. Documentary mode influences style and atmosphere, never replacing the subject.
Return a literal, filmable 3-10 word stock-video query. Avoid academic jargon and camera instructions that a stock search engine cannot match.

AUDIO priority:
1. Translate the scene into a SOUND YOU CAN HEAR, not a description of the research topic.
2. Prefer one familiar sound source or action plus an optional setting: "footsteps in hallway", "paper rustling", "quiet laboratory ambience", "keyboard typing".
3. Use narration and reference footage only to choose that broad, audible source; treat academic names, theories, species, datasets, institutions, and technical terms as context to paraphrase or discard.
4. Prefer common Freesound-style tags and generic searchable wording over rare proper nouns or exact scene details. If no literal sound is implied, choose a plausible environmental bed such as "room tone", "office ambience", "outdoor ambience", or "subtle machinery hum".
5. Documentary mode may shape the atmosphere (naturalistic, intimate, tense), but never replace the sound source.
Return exactly 2-5 ordinary words (up to 6 only when needed), lower-case, as a sound-effect or ambience search query. No sentence, explanation, abstract concept, music genre, camera language, visual metaphor, or proper noun.

Respond only as JSON: {"video_query":"...","audio_query":"..."}."""


_FILMABILITY_SYSTEM_PROMPT = """You are a documentary footage editor. Classify candidate phrases from one narration passage by whether a filmmaker can show them on screen.

Choose at most the three strongest visual beats. Return only JSON in this shape:
{"spans":[{"start":0,"end":12,"bucket":"depictable","query":"people walking through a laboratory","visual_proxy":"","salience":0.9}]}

Rules:
- depictable: a concrete person, place, object, visible action, or observable scene. The query must be a broad, literal stock-footage query of 3-10 ordinary words.
- abstract: academic jargon, an invisible process, a dataset, theory, metric, or idea that is not literal stock footage. Supply a concrete visual_proxy and query that metaphorically or observationally represents it (for example, researchers comparing charts, hands annotating data, or a close-up of a computer screen).
- ignore: filler, vague connective language, or a phrase that would not help choose a shot.
- Preserve the supplied character offsets exactly. Do not invent offsets or return candidates that were not supplied.
- Prefer phrases that are specific, visually salient, and useful for a coherent documentary sequence. Avoid returning multiple overlapping or redundant beats.
"""


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

    def generate_queries(self, scene):
        if not self.is_configured():
            raise MediaQueryLLMCallError('Media-query LLM is not configured (missing API key or openai package)')
        payload = {
            'title': scene.get('title', ''),
            'act': scene.get('act', ''),
            'scene_notes': scene.get('scene_notes', ''),
            'footage_fragment': scene.get('footage_fragment', ''),
            'scene_techniques': scene.get('scene_techniques', []),
            'narration': scene.get('narration', ''),
            'narration_entities': scene.get('narration_entities', []),
            'reference_footage_description': scene.get('reference_footage_description', ''),
            'reference_footage_entities': scene.get('reference_footage_entities', []),
            'abstract': scene.get('abstract', ''),
            'documentary_mode': scene.get('documentary_mode', ''),
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

    def classify_filmability(self, narration, spans, documentary_mode=''):
        """Classify local narration candidates into usable visual beats.

        The local span pass deliberately happens before this call. Keeping the
        LLM input to offset-bearing candidates makes the result cheap, stable,
        and directly renderable in the browser without another text-matching
        pass.
        """
        if not self.is_configured():
            raise MediaQueryLLMCallError('Media-query LLM is not configured (missing API key or openai package)')
        payload = {
            'narration': str(narration or '')[:20000],
            'documentary_mode': str(documentary_mode or '')[:80],
            'candidates': [
                {
                    'text': str(span.get('text') or ''),
                    'start': int(span.get('start', 0)),
                    'end': int(span.get('end', 0)),
                    'kind': str(span.get('kind') or ''),
                    'label': str(span.get('label') or ''),
                    'salience': float(span.get('salience') or 0),
                }
                for span in (spans or [])[:24]
                if isinstance(span, dict)
            ],
        }
        try:
            response = self._get_client().chat.completions.create(
                model=self.model,
                messages=[
                    {'role': 'system', 'content': _FILMABILITY_SYSTEM_PROMPT},
                    {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
                ],
                response_format={'type': 'json_object'},
                temperature=0.2,
            )
            parsed = json.loads(response.choices[0].message.content)
            result = parsed.get('spans') if isinstance(parsed, dict) else None
            if not isinstance(result, list):
                raise ValueError('response omitted spans')
            return result
        except Exception as exc:
            raise MediaQueryLLMCallError(f'Could not classify narration filmability: {exc}') from exc
