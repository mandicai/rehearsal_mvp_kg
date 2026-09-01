"""Match a scene's footage clips to the stretch of narration each one depicts.

Serves POST /narration/match_footage (see backend/server.py), which the Act
Board's "Smart arrange" action calls (see smartArrangeActBoardScene in
js/paper-extract.js) for the clips it could not place by exact text matching.

This deliberately returns CHARACTER OFFSETS into the supplied transcript, never
seconds. The caller already holds word-level Whisper timestamps for that
transcript, so it converts an offset window into real times itself; a model
guessing at seconds would be strictly worse than the timestamps we already have.

Env vars: PROXY_API_KEY (or OPENROUTER_API_KEY), PROXY_BASE_URL (or
OPENAI_BASE_URL), LLM_MODEL.
"""
import json
import os

import httpx

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


_SYSTEM_PROMPT = """You align documentary footage clips to the narration they illustrate.

You receive one narration transcript and a list of footage clips. Each clip has an id and a short label describing what it shows.

For each clip, find the span of the transcript that the clip illustrates, and return that span's character offsets into the transcript exactly as supplied.

Return only JSON in this shape:
{"matches":[{"id":"f1","start":21,"end":35,"confidence":0.9}]}

Rules:
- start and end are character offsets into the supplied transcript. end is exclusive. Count characters in the transcript exactly as given, including punctuation and spaces.
- Choose the SHORTEST span that carries the idea the clip shows - a noun phrase or short clause, not a whole sentence, and never the whole transcript.
- confidence is 0..1. Use below 0.5 when the clip only loosely relates to the narration.
- Omit a clip entirely rather than guessing when nothing in the transcript relates to it. A missing clip is handled gracefully; a wrong span puts the shot on the wrong words.
- Never return overlapping spans for two different clips unless the clips genuinely depict the same moment.
- Do not invent clip ids. Only return ids that were supplied.
"""


class FootageMatchLLMCallError(Exception):
    pass


class FootageMatchLLMClient:
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

    def match_footage(self, transcript, clips, documentary_mode=''):
        """Return [{'id', 'start', 'end', 'confidence'}] for the clips it could place.

        Clips the model omits or places out of bounds are dropped, not guessed
        at - the caller parks unmatched clips after the matched ones, which is
        a better outcome than a shot cut to the wrong words.
        """
        if not transcript or not clips:
            return []
        if not self.is_configured():
            raise FootageMatchLLMCallError(
                'Footage-match LLM is not configured (missing API key or openai package)')

        listing = '\n'.join(
            f"- id={clip['id']} label={clip.get('label') or ''!r}"
            + (f" search_query={clip['query']!r}" if clip.get('query') else '')
            for clip in clips)
        user_message = (
            f'Transcript ({len(transcript)} characters):\n{transcript}\n\n'
            f'Footage clips:\n{listing}\n\n'
            + (f'Documentary mode: {documentary_mode}\n\n' if documentary_mode else '')
            + 'Respond with a JSON object of the exact shape '
              '{"matches": [{"id": "...", "start": <int>, "end": <int>, "confidence": <float>}]}. '
              'Respond with only the JSON object, no other text.'
        )

        valid_ids = {str(clip['id']) for clip in clips}
        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                response = self._get_client().chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_message},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.2,
                )
                parsed = json.loads(response.choices[0].message.content)
                raw = parsed.get('matches')
                if not isinstance(raw, list):
                    raise ValueError('response omitted a matches list')

                # Same tolerant-parsing approach as edit_plan_llm: drop anything
                # that is not usable rather than failing the whole batch over one
                # bad entry. An offset outside the transcript would silently place
                # a shot at the wrong moment, so bounds are enforced here.
                matches = []
                seen = set()
                for item in raw:
                    if not isinstance(item, dict):
                        continue
                    clip_id = str(item.get('id') or '')
                    if clip_id not in valid_ids or clip_id in seen:
                        continue
                    try:
                        start = int(item.get('start'))
                        end = int(item.get('end'))
                    except (TypeError, ValueError):
                        continue
                    if not 0 <= start < end <= len(transcript):
                        continue
                    confidence = item.get('confidence')
                    confidence = (float(confidence)
                                  if isinstance(confidence, (int, float)) else 0.5)
                    seen.add(clip_id)
                    matches.append({
                        'id': clip_id,
                        'start': start,
                        'end': end,
                        'confidence': max(0.0, min(1.0, confidence)),
                    })
                return matches
            except Exception as exc:
                last_error = exc
        raise FootageMatchLLMCallError(f'Footage matching failed after retry: {last_error}')


def fallback_match_footage(transcript, clips):
    """Deterministic case-insensitive substring match, used with no LLM key.

    Only reports a clip whose label literally appears in the transcript, so the
    no-key path never places a shot on words it does not name. Scans forward so
    two clips sharing a label land on successive occurrences rather than both on
    the first one.
    """
    if not transcript or not clips:
        return []
    haystack = transcript.lower()
    matches = []
    search_from = 0
    for clip in clips:
        label = str(clip.get('label') or '').strip().lower()
        if not label:
            continue
        found = haystack.find(label, search_from)
        if found < 0:
            found = haystack.find(label)  # allow an out-of-order repeat
        if found < 0:
            continue
        search_from = found + len(label)
        matches.append({
            'id': str(clip['id']),
            'start': found,
            'end': found + len(label),
            'confidence': 1.0,
        })
    return matches
