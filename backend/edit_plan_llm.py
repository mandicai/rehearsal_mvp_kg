"""LLM-generated editing plan (transitions, pacing, Ken-Burns motion, text
overlays) for an already-arranged, already-storyboarded documentary arc (see
server.py's /paper/edit_plan route), for index.html's paper-extraction tool -
triggered by that page's "Generate Edit Plan" button, once a storyboard
already exists (storyboard_llm.py's generate_storyboard). This is the
"specific visual effects, shot sequences, editing choices" layer that a
Premiere Pro UXP plugin would eventually consume (see premiere-plugin/) -
this module only produces the plan; it has no dependency on Premiere itself.

Same env vars as feedback_llm.py/storyboard_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to draft an edit plan, so this
raises EditPlanLLMCallError if unconfigured.
"""
import json
import os

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_TRANSITIONS = ('hard_cut', 'cross_dissolve', 'dip_to_black', 'wipe')
_PANS = ('left_to_right', 'right_to_left', 'in', 'out')

# Pacing/transition/Ken-Burns/overlay tendencies per documentary mode (see
# documentary_modes.py) - independent of arc structure/documentary_goal,
# this is what actually varies the edit plan's "feel." Keys must exactly
# match DOCUMENTARY_MODE_KEYS - checked below at import time.
_MODE_GUIDANCE = {
    'expository': (
        "Favor brisk, clear hard cuts that keep pace with the narration's argument; text overlays are "
        'welcome for key stats/labels since this mode is comfortable being directly informative; Ken Burns '
        'motion on stills should be purposeful (zooming toward the detail being discussed).'
    ),
    'observational': (
        'Favor a slower, more patient pace with longer shot durations and few if any text overlays - let '
        'footage play out rather than interrupting it with on-screen text; transitions should be unobtrusive '
        '(hard cuts or very subtle dissolves), avoiding anything that calls attention to the edit itself.'
    ),
    'participatory': (
        'Pace around natural conversational rhythm - cut on the beats of what a researcher is saying, as if '
        'following an interview; cross-dissolves work well moving between an interview shot and the footage '
        'it references; text overlays are fine for naming a speaker or a key term they used.'
    ),
    'poetic': (
        'Favor a slower, more contemplative pace with generous cross-dissolves and gentle Ken Burns motion on '
        'stills; avoid text overlays almost entirely, since they undercut a poetic mood; let transitions '
        'breathe rather than cutting briskly.'
    ),
}
assert set(_MODE_GUIDANCE) == set(DOCUMENTARY_MODE_KEYS), 'edit_plan_llm._MODE_GUIDANCE keys must match documentary_modes.DOCUMENTARY_MODE_KEYS'

_SYSTEM_PROMPT = """You are a documentary editor planning specific editing choices for an already-arranged, already-storyboarded sequence of shots from an academic paper's documentary adaptation. You will be given the shots in final order, each with its title, text, which named arc part it's been placed in, visual direction, narration, and whether it has an actual figure image from the paper (rather than stock footage still to be sourced).

For each shot, decide:
- "transition_in": one of "hard_cut", "cross_dissolve", "dip_to_black", "wipe" - the transition INTO this shot from the previous one (the first shot is always "hard_cut", there's nothing before it to transition from). Ground the choice in pacing appropriate to the shot's position within the arc - e.g. brisker hard cuts are common through a sequence's early/middle stretch (urgency, momentum), a cross_dissolve is common moving into the arc's final part(s) (closure, reflection), dip_to_black is rare and reserved for a genuine beat/pause, wipe is rare and mostly for a hard topic change.
- "duration_seconds": a rough suggested shot length (typically 3-8 for B-roll, longer for a shot carrying dense narration).
- "ken_burns": {"enabled": bool, "pan": "left_to_right"|"right_to_left"|"in"|"out"} - a slow pan/zoom is primarily useful on a STILL IMAGE (a shot with has_figure_image true) since it adds motion a static image otherwise lacks; stock video shots usually don't need it (enabled: false).
- "text_overlay": an optional short (undefined "null" allowed) on-screen text/lower-third - a key stat, a name, a short label - only when it would genuinely help (don't add one to every shot).

Also provide one "overall_notes" string: brief pacing/music guidance for the whole piece (e.g. tempo changes across acts, where music should swell or drop out).

This is a loose editing plan for planning purposes, to be applied (in part) by a video editor or automated tool - not a frame-accurate final cut."""


class EditPlanLLMCallError(Exception):
    pass


class EditPlanLLMClient:
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

    def generate_edit_plan(self, sections, documentary_goal='', arc_sections=None, documentary_mode=None):
        """sections: [{'index': int, 'title': str, 'text': str, 'act': str,
        'visual': str, 'narration': str, 'has_figure_image': bool}, ...], in
        final arc order.
        documentary_goal: optional free text, in the presenter's own words -
        same role as in storyboard_llm.generate_storyboard.
        arc_sections: optional ordered list of the resolved arc's part
        names - same positional-context role as in generate_storyboard.
        documentary_mode: optional key into DOCUMENTARY_MODE_KEYS (see
        documentary_modes.py) - same stylistic-axis role as in
        generate_storyboard, but biasing pacing/transitions/Ken-Burns/
        overlays instead of narration/visual grammar.
        Returns ({index: {'transition_in', 'duration_seconds', 'ken_burns',
        'text_overlay'}}, overall_notes: str). Tolerant of a partially bad
        response the same way generate_storyboard is - a section the model
        drops gets safe defaults (hard_cut, no Ken Burns, no overlay) rather
        than failing the whole plan."""
        if not self.is_configured():
            raise EditPlanLLMCallError('LLM client is not configured (missing API key or openai package)')

        listing = '\n\n'.join(
            f"[{s['index']}] ({s['act']}) {s['title']}\n"
            f"Visual: {s.get('visual', '')}\nNarration: {s.get('narration', '')}\n"
            f"has_figure_image: {'true' if s.get('has_figure_image') else 'false'}"
            for s in sections
        )
        goal_line = (
            f'\n\nThe presenter\'s stated documentary intent, in their own words: "{documentary_goal}"\n'
            'Use this to inform pacing/emphasis choices, without inventing content not present in the shots themselves.'
        ) if documentary_goal else ''
        arc_line = f'Narrative arc parts, in order: {list(arc_sections)!r}\n\n' if arc_sections else ''
        mode_line = f'\n\nDocumentary mode: {_MODE_GUIDANCE[documentary_mode]}' if documentary_mode in _MODE_GUIDANCE else ''
        user_content = (
            f'{arc_line}Shots, in final order:\n\n{listing}{goal_line}{mode_line}\n\n'
            'Respond with a JSON object of the exact shape '
            '{"shots": [{"index": <int>, "transition_in": "...", "duration_seconds": <number>, '
            '"ken_burns": {"enabled": <bool>, "pan": "..."}, "text_overlay": "..." or null}, ...], '
            '"overall_notes": "..."}, one shot entry per given index. Respond with only the JSON object, no other text.'
        )
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
                    temperature=0.6,
                )
                parsed = json.loads(response.choices[0].message.content)
                shots = parsed.get('shots')
                if not isinstance(shots, list) or not shots:
                    raise ValueError(f'response missing shots list: {parsed!r}')

                # Same tolerant-parsing lesson as storyboard_llm/narrative_arc_llm:
                # drop anything not in the requested set, patch anything the
                # model left out with safe defaults below, rather than
                # failing the whole plan over one bad entry.
                result = {}
                for entry in shots:
                    if not isinstance(entry, dict):
                        continue
                    index = entry.get('index')
                    if index not in expected_indices:
                        continue
                    transition = entry.get('transition_in')
                    if transition not in _TRANSITIONS:
                        transition = 'hard_cut'
                    ken_burns_raw = entry.get('ken_burns') or {}
                    pan = ken_burns_raw.get('pan')
                    ken_burns = {
                        'enabled': bool(ken_burns_raw.get('enabled')) and pan in _PANS,
                        'pan': pan if pan in _PANS else None,
                    }
                    duration = entry.get('duration_seconds')
                    result[index] = {
                        'transition_in': transition,
                        'duration_seconds': duration if isinstance(duration, (int, float)) and duration > 0 else 5,
                        'ken_burns': ken_burns,
                        'text_overlay': (entry.get('text_overlay') or None),
                    }

                if not result:
                    raise ValueError(f'no valid shot entries in response: {shots!r}')

                for index in expected_indices - result.keys():
                    result[index] = {
                        'transition_in': 'hard_cut',
                        'duration_seconds': 5,
                        'ken_burns': {'enabled': False, 'pan': None},
                        'text_overlay': None,
                    }

                overall_notes = (parsed.get('overall_notes') or '').strip()
                return result, overall_notes
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise EditPlanLLMCallError(f'Edit plan generation failed after retry: {last_error}')
