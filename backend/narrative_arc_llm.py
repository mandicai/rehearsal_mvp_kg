"""LLM classification of extracted paper sections into a three-act
documentary narrative arc (see server.py's /paper/narrative_arc route), for
index.html's paper-extraction tool - triggered by that page's "Arrange into
Narrative" button, over whichever sections the user hasn't excluded.

Same env vars as feedback_llm.py/ingest/objectives_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to judge where a section belongs
in a narrative arc, so this raises NarrativeArcLLMCallError if unconfigured.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_ACTS = ('beginning', 'middle', 'end')

_SYSTEM_PROMPT = """You are helping a filmmaker plan a video essay based on an academic paper, by arranging its sections into a three-act documentary narrative arc. The three acts are:
- "beginning": establishes the frame of reference - background, context, what's already known.
- "middle": introduces the change or issue needing resolution - the motivating problem, and the approach/methods used to address it.
- "end": summarizes or resolves the actions - what was found, and what it means.

For example, related-work/background sections often fit "beginning"; a motivating problem or methods section often fits "middle"; findings/discussion/implications often fit "end" - but these are illustrative examples, not fixed rules. Use your own judgment based on each section's actual title and text, since papers vary widely in structure and section naming.

You will be given a numbered list of sections (title + text). Respond with a single JSON object of the exact shape {"assignments": [{"index": <int>, "act": "beginning"|"middle"|"end"}, ...]}, with exactly one entry per section given, using each section's given index. Respond with only the JSON object, no other text."""


class NarrativeArcLLMCallError(Exception):
    pass


class NarrativeArcLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            kwargs = {'api_key': self.api_key}
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def assign_acts(self, sections, documentary_goal=''):
        """sections: [{'index': int, 'title': str, 'text': str}, ...].
        documentary_goal: optional free text, in the presenter's own words,
        naming what they want the documentary's message/focus to be - used
        to bias act placement toward what they've said they care about.
        Returns {index: 'beginning'|'middle'|'end'} with one entry per
        given section."""
        if not self.is_configured():
            raise NarrativeArcLLMCallError('LLM client is not configured (missing API key or openai package)')

        listing = '\n\n'.join(f"[{s['index']}] {s['title']}\n{s['text']}" for s in sections)
        goal_line = (
            f'\n\nThe presenter\'s stated documentary intent, in their own words: "{documentary_goal}"\n'
            'Use this to inform which act each section best serves, without inventing content not present '
            'in the sections themselves.'
        ) if documentary_goal else ''
        user_content = f'Sections:\n\n{listing}{goal_line}'
        expected_indices = {s['index'] for s in sections}

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.2,
                )
                parsed = json.loads(response.choices[0].message.content)
                assignments = parsed.get('assignments')
                if not isinstance(assignments, list) or not assignments:
                    raise ValueError(f'response missing assignments list: {parsed!r}')

                # Tolerant on purpose: with ~20-40 sections in one JSON
                # response, the model occasionally drops one index or
                # returns one that wasn't in the given set at all (a known
                # failure mode for long generated JSON arrays, not a sign
                # the whole response is garbage). Silently drop anything
                # not in expected_indices, then patch any indices the model
                # left out below, rather than discarding an otherwise-good
                # response and burning a retry over one bad entry.
                result = {}
                for entry in assignments:
                    if not isinstance(entry, dict):
                        continue
                    index = entry.get('index')
                    act = entry.get('act')
                    if index in expected_indices and act in _ACTS:
                        result[index] = act

                if not result:
                    raise ValueError(f'no valid assignments in response: {assignments!r}')

                for index in expected_indices - result.keys():
                    result[index] = 'middle'  # neutral default for the rare dropped index

                return result
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise NarrativeArcLLMCallError(f'Narrative arc arrangement failed after retry: {last_error}')
