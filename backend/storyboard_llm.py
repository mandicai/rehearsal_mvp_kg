"""LLM-generated loose storyboard (visual + narration per section) for an
already-arranged documentary narrative arc (see server.py's
/paper/storyboard route), for storyboard.html's arranged view - triggered
by the sticky action bar's "Generate Storyboard" button, over whichever
sections the presenter has manually placed into the accepted arc's parts
(js/paper-extract.js's renderMovieEditor).

Same env vars as feedback_llm.py/narrative_arc_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to draft a storyboard, so this
raises StoryboardLLMCallError if unconfigured.
"""
import json
import os

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

# Narration voice + visual grammar per documentary mode (see
# documentary_modes.py) - independent of arc structure/documentary_goal,
# this is what actually varies the storyboard's "voice." Keys must exactly
# match DOCUMENTARY_MODE_KEYS - checked below at import time.
_MODE_GUIDANCE = {
    'expository': (
        'Narration should read like a confident, authoritative voice-over explaining directly to the '
        'viewer - clear topic sentences, plain declarative language, occasional rhetorical questions to '
        'set up the next point. Visual direction favors illustrative B-roll, on-screen diagrams/key stats, '
        'and talking-head explainer shots that reinforce what the narration is saying.'
    ),
    'observational': (
        'Keep narration sparse or absent - prefer describing what the camera simply observes (a researcher '
        'at work, an experiment running) over having a narrator explain it. When narration is needed, keep '
        'it short and descriptive rather than didactic. Visual direction favors long, naturalistic B-roll of '
        'people/processes rather than diagrams or direct-to-camera address.'
    ),
    'participatory': (
        "Narration should read like something the researcher(s) themselves would say in an interview - "
        'first-person, conversational, reflecting on their own process/findings rather than a detached '
        'narrator explaining them. Visual direction favors interview-style talking-head shots and moments '
        'that show the filmmaker/researcher visibly engaging with the material.'
    ),
    'poetic': (
        'Narration should be sparse, evocative, and impressionistic rather than explanatory - short, '
        'image-rich phrases over dense exposition, comfortable with mood and ambiguity. Visual direction '
        'favors atmospheric, symbolic, or abstract imagery over literal illustrations of the content.'
    ),
}
assert set(_MODE_GUIDANCE) == set(DOCUMENTARY_MODE_KEYS), 'storyboard_llm._MODE_GUIDANCE keys must match documentary_modes.DOCUMENTARY_MODE_KEYS'

_SYSTEM_PROMPT = """You are a documentary scriptwriter turning an academic paper's sections, already arranged into a named documentary narrative arc, into a loose storyboard. You will be given the arc's named parts in order, then a list of sections in order, each with its title, text, and which arc part it's been placed in.

For each section, suggest exactly one storyboard shot:
- "visual": a short visual direction for what's shown on screen (e.g. archival footage, a talking-head explainer, an on-screen diagram or key stat, relevant B-roll) - 1-2 sentences.
- "narration": a short voiceover line rewriting that section's content in accessible, engaging spoken language appropriate for a documentary, fitting its arc part's role and position (an early part typically establishes/introduces, a middle part typically develops/complicates, a late part typically resolves/reflects - but infer the actual role of each part from its name and position in the given order, since arcs vary) - 1-2 sentences.
- "video_query": a short (3-8 word) stock-video search phrase describing a literal, filmable real-world scene that could stand in for this shot (e.g. "scientist analyzing data on computer screen", "city skyline timelapse", "researchers collaborating in office"). Never use academic terminology, abstract concepts, or entity names verbatim here (there is no stock footage of "gradient descent" or "ResNet-50") - translate the idea into something a camera could actually capture, informed by the section's content/entities without naming them literally.
- "audio_query": a short (3-8 word) stock-audio/ambience search phrase for a literal, recordable sound fitting the shot (e.g. "keyboard typing office ambience", "city street traffic", "quiet library ambience") - same rule: a real recordable sound, not an abstract concept.

Some sections list key entities extracted from their text (people, places, technologies, datasets, methods, etc.). When a section has entities listed, let them inform (but not literally appear in) video_query/audio_query, and ground visual/narration in those specific named things rather than generic language - but only ones actually listed; don't invent others.

This is a loose, rough storyboard for planning purposes, not a shot-by-shot final script.

Respond with a JSON object of the exact shape {"storyboard": [{"index": <int>, "visual": "...", "narration": "...", "video_query": "...", "audio_query": "..."}, ...]}, one entry per given section, using each section's given index. Respond with only the JSON object, no other text."""


class StoryboardLLMCallError(Exception):
    pass


class StoryboardLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            # Explicit short connect timeout: a bare `timeout=N` sets N as
            # the connect budget for *each* of the (often several) DNS-
            # resolved IPs httpx tries in turn, so a fully unreachable host
            # takes N*(IP count) to fail - observed as 120s to fail against
            # a 30s bare timeout with 4 A records. A tight connect timeout
            # (5s) with a more generous read timeout (30s, for a genuinely
            # slow-but-working response) keeps the worst case bounded and
            # fast. max_retries=0 because the retry loop below already
            # retries once itself - the SDK's own default (2) would
            # otherwise compound with it into a multi-minute hang that looks
            # indistinguishable from a genuine freeze to the presenter.
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(30.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def generate_storyboard(self, sections, documentary_goal='', arc_sections=None, documentary_mode=None):
        """sections: [{'index': int, 'title': str, 'text': str, 'act': str,
        'entities': [{'name': str, ...}, ...] (optional)}, ...]. `entities`,
        when present, comes from segmentation_carta's per-chunk extraction
        (see server.py's paper_storyboard route) - used to ground shots in
        specific named things rather than generic language.
        documentary_goal: optional free text, in the presenter's own words,
        naming what they want the documentary's message/focus to be - used
        to bias each shot's visual/narration toward what they've said they
        care about.
        arc_sections: optional ordered list of the resolved arc's part
        names - gives the prompt positional context (which parts come
        early/late) beyond just each section's own 'act', since paper order
        doesn't necessarily match arc order.
        documentary_mode: optional key into DOCUMENTARY_MODE_KEYS (see
        documentary_modes.py) - a stylistic axis independent of goal/arc,
        biasing narration voice and visual grammar (e.g. "observational"
        means sparse narration and naturalistic B-roll).
        Returns {index: {'visual': str, 'narration': str, 'video_query': str,
        'audio_query': str}} with one entry per given section - any section
        the model drops entirely gets a generic fallback derived from its
        own title/text rather than failing the whole request over one bad
        entry; a section with good visual/narration but a missing
        video_query/audio_query just gets that one field defaulted to its
        own title, rather than being discarded over a field that isn't
        essential to have well-formed."""
        if not self.is_configured():
            raise StoryboardLLMCallError('LLM client is not configured (missing API key or openai package)')

        def _entity_line(section):
            entities = section.get('entities')
            if not entities:
                return ''
            names = ', '.join(e['name'] for e in entities if e.get('name'))
            return f'\nKey entities: {names}' if names else ''

        listing = '\n\n'.join(
            f"[{s['index']}] ({s['act']}) {s['title']}\n{s['text']}{_entity_line(s)}" for s in sections
        )
        goal_line = (
            f'\n\nThe presenter\'s stated documentary intent, in their own words: "{documentary_goal}"\n'
            'Use this to inform which details each shot\'s visual/narration should emphasize, without '
            'inventing content not present in the sections themselves.'
        ) if documentary_goal else ''
        arc_line = f'Narrative arc parts, in order: {list(arc_sections)!r}\n\n' if arc_sections else ''
        mode_line = f'\n\nDocumentary mode: {_MODE_GUIDANCE[documentary_mode]}' if documentary_mode in _MODE_GUIDANCE else ''
        user_content = f'{arc_line}Sections:\n\n{listing}{goal_line}{mode_line}'
        expected_indices = {s['index'] for s in sections}
        by_index = {s['index']: s for s in sections}

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
                    temperature=0.7,
                )
                parsed = json.loads(response.choices[0].message.content)
                storyboard = parsed.get('storyboard')
                if not isinstance(storyboard, list) or not storyboard:
                    raise ValueError(f'response missing storyboard list: {parsed!r}')

                # Tolerant on purpose: a long generated JSON array
                # occasionally drops or mislabels one entry, which isn't a
                # sign the whole response is unusable. Anything not in the
                # requested set is dropped; anything the model left out gets
                # a generic fallback below.
                result = {}
                for entry in storyboard:
                    if not isinstance(entry, dict):
                        continue
                    index = entry.get('index')
                    visual = (entry.get('visual') or '').strip()
                    narration = (entry.get('narration') or '').strip()
                    if index in expected_indices and visual and narration:
                        title = by_index[index]['title']
                        result[index] = {
                            'visual': visual,
                            'narration': narration,
                            'video_query': (entry.get('video_query') or '').strip() or title,
                            'audio_query': (entry.get('audio_query') or '').strip() or title,
                        }

                if not result:
                    raise ValueError(f'no valid storyboard entries in response: {storyboard!r}')

                for index in expected_indices - result.keys():
                    section = by_index[index]
                    result[index] = {
                        'visual': f'Supporting visual for "{section["title"]}".',
                        'narration': section['text'][:200],
                        'video_query': section['title'],
                        'audio_query': section['title'],
                    }

                return result
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise StoryboardLLMCallError(f'Storyboard generation failed after retry: {last_error}')
