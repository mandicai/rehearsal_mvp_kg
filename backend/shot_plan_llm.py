"""LLM-inferred shot design for a single documentary scene (see server.py's
/paper/generate_shot route and js/paper-extract.js's "Generate shot" flow).

Given a scene's title, its scene notes (the paper text it's grounded in), and
the presenter's recorded narration about what information the scene should
present and where/how the viewer should be positioned, this infers ONE shot
using documentary cinematography grammar: a shot size, a camera movement, the
narrative operation it performs, and - the meaningful unit - the CHANGE from a
start frame to an end frame. The two frames are concrete visual descriptions
that get handed to the image model (sketch_llm) to draw the start/end frames,
and later hard-cut together in the rendered MP4 (movie_render.render_shot).

Same env vars as storyboard_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to design a shot, so this raises
ShotPlanLLMCallError if unconfigured.
"""
import json
import os

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

# Georgetown's shot-size continuum (world -> detail), the camera movements it
# names (plus push_in/pull_out, the dolly/zoom pair the artboard uses), and
# the narrative operations a shot can perform. Invalid model values fall back
# to the neutral middle of each (see parsing below).
_SHOT_SIZES = ('ELS', 'LS', 'MLS', 'MS', 'MCU', 'CU', 'ECU')
_MOVEMENTS = ('static', 'pan', 'tilt', 'push_in', 'pull_out', 'tracking', 'handheld')
_NARRATIVE_OPERATIONS = (
    'orient', 'contextualize', 'introduce', 'observe', 'accompany', 'connect',
    'reveal', 'direct_attention', 'inspect', 'humanize', 'react', 'expand', 'narrow',
)
_DEFAULT_SHOT_SIZE = 'MS'
_DEFAULT_MOVEMENT = 'static'
_DEFAULT_OPERATION = 'observe'
_DEFAULT_DURATION = 5

# Per-mode bias on how a shot is chosen (see documentary_modes.py) - keys must
# match DOCUMENTARY_MODE_KEYS, checked at import.
_MODE_GUIDANCE = {
    'expository': (
        'Favor clear, stable, informative framing that supports a confident voice-over - static or gentle '
        'push_in on the subject being explained, purposeful reveals (pan/tilt) that connect a claim to its '
        'evidence. Shot sizes lean MS/MCU for explanation, tightening to CU/ECU on the specific evidence.'
    ),
    'observational': (
        'Favor patient, naturalistic framing that lets action play out - longer static or tracking shots, '
        'wider sizes (LS/MLS/MS) that keep behavior in its context, minimal dramatic push-ins. Movement '
        'should feel motivated by the subject, not the narrator.'
    ),
    'participatory': (
        'Favor framing that foregrounds a person speaking/engaging - MS/MCU interview framings, handheld or '
        'tracking to convey the filmmaker being present with them, cutaways that connect what they say to '
        'what they reference.'
    ),
    'poetic': (
        'Favor evocative, associative framing over literal explanation - unusual scales, slow reveals '
        '(pan/tilt/pull_out), atmospheric wides and abstract details (ELS or ECU), movement that creates '
        'mood rather than delivering information.'
    ),
}
assert set(_MODE_GUIDANCE) == set(DOCUMENTARY_MODE_KEYS), 'shot_plan_llm._MODE_GUIDANCE keys must match documentary_modes.DOCUMENTARY_MODE_KEYS'

_SYSTEM_PROMPT = """You are a documentary cinematographer designing ONE shot for a scene, using shot composition, camera movement, and shot sequencing as a visual grammar rather than a catalog of options.

Reason in this order:
1. First decide what should happen to the VIEWER'S MENTAL MODEL during this scene (the narrative operation). Then choose the composition and movement that perform it.
2. Composition controls informational distance on a continuum from world to detail: ELS (world/environment: "where are we, how big is this?") -> LS (person + environment) -> MLS (body/action + some context) -> MS (person + immediate context: explanation/conversation) -> MCU (face + gesture: attention to what someone says/feels) -> CU (face/object: "this is important") -> ECU (one detail: "look specifically at this"). Going tighter reduces competing information and increases emphasis; going wider adds relationships and context.
3. Movement is a stance toward the event: "static" = observe/stability/authority; "pan" = scan/connect/reveal across space (bring off-screen info into awareness); "tilt" = reveal scale/hierarchy vertically; "push_in" = narrow attention toward a subject/detail; "pull_out" = expand a detail into its larger context; "tracking" = accompany/travel with a subject (process, journey, access); "handheld" = immediacy/presence/uncertainty.
4. The MEANINGFUL UNIT is the CHANGE from the START FRAME to the END FRAME. Express the shot as those two framings. For a pan it might be one subject -> a related subject ("tree -> forest"); for push_in, a person -> a detail they're handling; for pull_out, a detail -> the landscape it belongs to; for a static shot the two frames are nearly the same (a held composition) - still describe both.

Narrative-operation -> visual-operation guidance: orient -> ELS/LS static; contextualize -> LS/MS (deep composition); introduce -> MS/MCU; observe -> MLS/MS; accompany -> tracking; connect -> pan; reveal -> pan/tilt/pull_out; direct_attention -> CU push_in; inspect -> CU/ECU; humanize -> MCU/CU; react -> CU/MCU; expand -> pull_out (CU->LS); narrow -> push_in (LS->CU).

Ground everything in whatever context is given - it may include any of: the presenter's narration (the voiceover for the scene - the strongest signal for what it's about), the scene title, the arc part the scene sits in, scene notes (paper text), and the paper's abstract. Use whatever is present; do not invent specific facts, places, or people that none of the given material implies. If little or nothing is given, invent a plausible, generic documentary shot for an academic-research film rather than refusing. The start_frame and end_frame must be concrete, filmable visual descriptions (what is actually in the frame - subjects, setting, framing), not abstract concepts or camera jargon.

Respond with a JSON object of the exact shape:
{"shot": {"shot_size": "<one of ELS,LS,MLS,MS,MCU,CU,ECU>", "movement": "<one of static,pan,tilt,push_in,pull_out,tracking,handheld>", "narrative_operation": "<one of orient,contextualize,introduce,observe,accompany,connect,reveal,direct_attention,inspect,humanize,react,expand,narrow>", "purpose": "<one short sentence: what this shot does for the viewer>", "start_frame": "<concrete visual description of the opening framing>", "end_frame": "<concrete visual description of the closing framing>", "duration_seconds": <number, typically 4-10>}}
Respond with only the JSON object, no other text."""


class ShotPlanLLMCallError(Exception):
    pass


class ShotPlanLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            # Same tight-connect/generous-read timeout + max_retries=0
            # reasoning as storyboard_llm._get_client (the retry loop below
            # handles one transient retry itself).
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(30.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def generate_shot_plan(self, title, scene_notes='', narration='', act_title='', abstract='', documentary_mode=None, techniques=None):
        """Infers one shot from whatever context is available - NONE of these
        are required:
        - narration: the presenter's live voiceover for the scene (what they'd
          say over it) - the primary driver when present.
        - scene_notes: the paper text the scene is grounded in (section.text).
        - title: the scene's own title.
        - act_title: the arc part (act) the scene sits in.
        - abstract: the paper's abstract (the whole doc's framing).
        documentary_mode: optional key into DOCUMENTARY_MODE_KEYS, biasing the
        framing. With little or nothing to go on, the model is asked to invent
        a plausible generic documentary shot rather than refuse.

        Returns {'shot_size', 'movement', 'narrative_operation', 'purpose',
        'start_frame', 'end_frame', 'duration_seconds'}. Tolerant of a
        partially-bad response the same way generate_storyboard is: invalid
        enum values fall back to neutral defaults, and a missing frame
        description falls back to the other frame."""
        if not self.is_configured():
            raise ShotPlanLLMCallError('LLM client is not configured (missing API key or openai package)')

        parts = []
        if (narration or '').strip():
            parts.append(f"Narration (the voiceover the presenter would say over this scene):\n{narration.strip()}")
        if (title or '').strip():
            parts.append(f'Scene title: {title.strip()}')
        if (act_title or '').strip():
            parts.append(f'This scene sits in the arc part titled: {act_title.strip()}')
        if (scene_notes or '').strip():
            parts.append(f'Scene notes (the paper text this scene is grounded in):\n{scene_notes.strip()}')
        if (abstract or '').strip():
            parts.append(f"The paper's abstract (overall framing of the work):\n{abstract.strip()}")
        if not parts:
            parts.append(
                'No specific material was provided for this scene - invent a plausible, generic documentary '
                'shot for an academic-research film.'
            )
        if documentary_mode in _MODE_GUIDANCE:
            parts.append(f'Documentary mode: {_MODE_GUIDANCE[documentary_mode]}')
        tech = [t.strip() for t in (techniques or []) if isinstance(t, str) and t.strip()]
        if tech:
            parts.append('Favor these filming/editing techniques where they naturally fit the material: ' + ', '.join(tech) + '.')
        user_content = '\n\n'.join(parts)

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
                shot = parsed.get('shot')
                if not isinstance(shot, dict):
                    raise ValueError(f'response missing shot object: {parsed!r}')

                shot_size = (shot.get('shot_size') or '').strip().upper()
                movement = (shot.get('movement') or '').strip().lower()
                operation = (shot.get('narrative_operation') or '').strip().lower()
                duration = shot.get('duration_seconds')
                start_frame = (shot.get('start_frame') or '').strip()
                end_frame = (shot.get('end_frame') or '').strip()
                # A shot with neither frame is unusable - treat as a failure so
                # the retry gets a chance; one missing frame is patched below.
                if not start_frame and not end_frame:
                    raise ValueError(f'shot has no frame descriptions: {shot!r}')

                return {
                    'shot_size': shot_size if shot_size in _SHOT_SIZES else _DEFAULT_SHOT_SIZE,
                    'movement': movement if movement in _MOVEMENTS else _DEFAULT_MOVEMENT,
                    'narrative_operation': operation if operation in _NARRATIVE_OPERATIONS else _DEFAULT_OPERATION,
                    'purpose': (shot.get('purpose') or '').strip() or (f'Present "{title.strip()}".' if (title or '').strip() else 'Establish this scene.'),
                    'start_frame': start_frame or end_frame,
                    'end_frame': end_frame or start_frame,
                    'duration_seconds': duration if isinstance(duration, (int, float)) and duration > 0 else _DEFAULT_DURATION,
                }
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise ShotPlanLLMCallError(f'Shot plan generation failed after retry: {last_error}')
