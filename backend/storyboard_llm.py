"""LLM-generated loose storyboard (visual + narration per section) for an
already-arranged documentary narrative arc (see server.py's
/paper/storyboard route), for index.html's paper-extraction tool - triggered
by that page's "Generate Storyboard" button, once sections have already been
placed into acts by narrative_arc_llm.py's assign_acts.

Same env vars as feedback_llm.py/narrative_arc_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to draft a storyboard, so this
raises StoryboardLLMCallError if unconfigured.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_SYSTEM_PROMPT = """You are a documentary scriptwriter turning an academic paper's sections, already arranged into a three-act structure, into a loose storyboard. You will be given a list of sections in order, each with its title, text, and which act it's been placed in:
- "beginning": frame of reference - background, context, what's already known.
- "middle": the change or issue needing resolution - the motivating problem and approach.
- "end": resolution - findings and what they mean.

For each section, suggest exactly one storyboard shot:
- "visual": a short visual direction for what's shown on screen (e.g. archival footage, a talking-head explainer, an on-screen diagram or key stat, relevant B-roll) - 1-2 sentences.
- "narration": a short voiceover line rewriting that section's content in accessible, engaging spoken language appropriate for a documentary, fitting its position in the arc - 1-2 sentences.
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
            kwargs = {'api_key': self.api_key}
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def generate_storyboard(self, sections, documentary_goal=''):
        """sections: [{'index': int, 'title': str, 'text': str, 'act': str,
        'entities': [{'name': str, ...}, ...] (optional)}, ...]. `entities`,
        when present, comes from segmentation_carta's per-chunk extraction
        (see server.py's paper_storyboard route) - used to ground shots in
        specific named things rather than generic language.
        documentary_goal: optional free text, in the presenter's own words,
        naming what they want the documentary's message/focus to be - used
        to bias each shot's visual/narration toward what they've said they
        care about.
        Returns {index: {'visual': str, 'narration': str, 'video_query': str,
        'audio_query': str}} with one entry per given section - any section
        the model drops entirely gets a generic fallback derived from its
        own title/text rather than failing the whole request over one bad
        entry (same lesson as narrative_arc_llm.assign_acts); a section with
        good visual/narration but a missing video_query/audio_query just
        gets that one field defaulted to its own title, rather than being
        discarded over a field that isn't essential to have well-formed."""
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
        user_content = f'Sections:\n\n{listing}{goal_line}'
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

                # Tolerant on purpose - see narrative_arc_llm.assign_acts for
                # why: a long generated JSON array occasionally drops or
                # mislabels one entry, which isn't a sign the whole response
                # is unusable. Anything not in the requested set is dropped;
                # anything the model left out gets a generic fallback below.
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
