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

_SYSTEM_PROMPT = """You are a documentary cinematographer designing one or more possible shots for one scene. Each option must be one clear visual idea.

Decide in this order:
1. What should change in the viewer's understanding? Choose one narrative operation.
2. What should the viewer see? Choose a concrete, filmable subject and setting.
3. How should the camera express the idea? Choose the shot size, composition, staging, lighting, and movement.

Shot size controls informational distance: ELS/LS establish world and context; MLS/MS show action and relationships; MCU/CU emphasize a person or object; ECU isolates one critical detail. Movement must have a purpose: static observes; pan connects or reveals across space; tilt reveals vertical scale; push_in concentrates attention; pull_out adds context; tracking accompanies action; handheld adds immediacy or uncertainty.

Useful pairings: orient -> ELS/LS + static; contextualize -> LS/MS + static/pan; introduce -> MS/MCU + static; observe -> MLS/MS + static; accompany -> MLS/MS + tracking; connect -> LS/MS + pan; reveal -> LS/MS + pan/tilt/pull_out; direct_attention -> CU + push_in; inspect -> CU/ECU + static/push_in; humanize/react -> MCU/CU + static/handheld; expand -> LS + pull_out; narrow -> CU + push_in.

When narration is present, infer several plausible narrative operations from what the narration needs the viewer to understand, notice, feel, or connect. Give each operation a useful composition and movement that visually performs it.

When narration is absent, choose narrative operations randomly from the allowed vocabulary and assign random valid shot-size/movement pairings to demonstrate different possibilities.

For a multi-option request, every narrative operation must be different and every (shot_size, movement) pair must be different. Make the visual ideas meaningfully distinct, not cosmetic variations.

Keep CONTENT separate from DIRECTION:
- Uploaded-footage subject, when provided, controls who/what/where appears. Do not borrow its framing or style.
- Scene notes and selected techniques are authoritative for composition, staging, camera, and lighting. Make them visibly apparent.
- Documentary mode guide unspecified tone and style.
- Narration and abstract provide subject matter when uploaded footage does not.
- Do not invent specific facts, people, or places unsupported by the inputs. If the inputs are sparse, make a plausible generic academic-documentary shot.

For every option, write one `visual_description` that an image generator can use directly. Describe the visible subject, setting, action, staging, lighting, camera angle, and composition. It must clearly embody that option's narrative operation, shot size, movement, and selected techniques. Do not describe a second frame or a cut.

Return exactly the requested number of options in this JSON shape:
{"shots": [{"shot_size": "<ELS|LS|MLS|MS|MCU|CU|ECU>", "movement": "<static|pan|tilt|push_in|pull_out|tracking|handheld>", "narrative_operation": "<orient|contextualize|introduce|observe|accompany|connect|reveal|direct_attention|inspect|humanize|react|expand|narrow>", "purpose": "<one short sentence explaining what this shot does for the viewer>", "visual_description": "<one concrete, generation-ready description of this option>", "duration_seconds": <number, typically 4-10>}]}
Respond with only the JSON object."""


# Concrete framing directive per shot size - what the camera actually sees, so
# an image/video model composes the specified perspective rather than a generic
# mid-frame. Keyed by _SHOT_SIZES.
_SHOT_SIZE_FRAMING = {
    'ELS': 'an extreme long / establishing shot - the subject is tiny within a vast environment, the setting dominates',
    'LS': 'a long shot - the full figure is visible head-to-toe with its surroundings',
    'MLS': 'a medium-long shot - the subject from roughly the knees up, with some context around them',
    'MS': 'a medium shot - the subject from the waist up, balanced with immediate context',
    'MCU': 'a medium close-up - head and shoulders, expression and gesture clearly visible',
    'CU': 'a close-up - a face or object fills most of the frame',
    'ECU': 'an extreme close-up - a single small detail dominates the entire frame',
}

# Extra perspective hints for a few techniques that fundamentally change what the
# camera shows (matched against the scene's selected/dragged techniques). Kept
# loose (substring match) so wording variants still hit.
# Perspective phrased as the resulting COMPOSITION (what's in the frame), not as
# a camera operation - so the image model renders the view, not a literal camera.
_TECHNIQUE_FRAMING = {
    # Perspective / composition
    'Point-of-view shot': 'a first-person point of view - the frame shows what the subject sees from their own eyes; the subject themselves is not visible',
    'Follow shot': 'an eye-level framing that stays with the subject as they move through the space',
    'Object close-up': 'a tight, isolated close-up of a single object as evidence',
    'Wide-to-detail sequence': 'a wide framing establishing the whole setting before narrowing to detail',
    'Detail-to-context reveal': 'framed on a small detail with the wider context around it',
    'Interview/direct address': 'the subject framed facing the viewer directly, as in an interview',
    'Overhead / top-down': 'a top-down overhead view looking straight down on the scene',
    'Static tableau': 'a carefully composed, symmetrical, held tableau - everything arranged and perfectly still',
    'Rack focus': 'shallow depth of field with one plane razor-sharp and the rest melting into soft bokeh',
    'Reaction shot': "a tight framing of a person's face mid-reaction - attention and emotion, the thing they react to left off-screen",
    'Demonstration': "a person's hands actively demonstrating or operating something, the action centered and legible",
    'Reveal': 'a composition that half-conceals its subject, something just emerging into view from behind an obstruction or shadow',
    'Observational sequence': 'a candid, unstaged fly-on-the-wall moment caught in the middle of real activity',
    'Process sequence': 'one clear stage of a hands-on process or experiment captured in progress',
    'Slow motion': 'a single suspended instant of motion frozen mid-action, every droplet and fold crisp',
    'Reenactment': 'a dramatized, staged recreation - cinematic lighting and scene detail, actors caught in the moment',
    # Motion (as a still: exaggerated framing/blur)
    'Whip pan': 'violent horizontal motion-blur streaks smearing across the whole frame',
    'Time-lapse': 'a long-exposure look - motion blur and glowing light-trails implying time racing past',
    'Push-in': 'an aggressively tight, closing-in framing that crowds the subject',
    'Pull-back': 'a very wide framing that shrinks the subject inside its vast surroundings',
    'Pan': 'a wide, horizontally sweeping composition spanning across the space',
    'Tilt': 'a tall vertical composition emphasizing height and scale from bottom to top',
    'Long take': 'a deep, layered composition with action staged at multiple distances in one continuous frame',
    # Multi-image / comparison
    'Montage': 'a fragmented composite of several small overlapping images collaged within one frame',
    'Split-screen juxtaposition': 'the frame literally split into two side-by-side panels showing two different images at once',
    'Before-and-after comparison': 'a split before/after composition contrasting two states of the same subject',
    'Juxtaposition': 'two contrasting subjects composed within a single frame for direct comparison',
    'Contrast cut': 'two sharply opposed images butted together in one frame, jarring against each other',
    'Parallel editing': 'two related subjects or places composed together to imply they happen at once',
    # Graphic / data / screen
    'Data visualization': 'a bold chart, graph, or animated data graphic dominating the frame, minimal scene behind it',
    'Animated diagram': 'a clean schematic diagram with labelled parts and arrows filling the frame',
    'Map progression': 'an annotated map with routes, markers, and highlighted regions filling the frame',
    'On-screen text': 'large graphic on-screen text and titles integrated boldly into the composition',
    'Screen recording': 'a computer screen or software interface filling the frame, a flat screen-capture look',
    # Archival / evidence
    'Archival footage': 'a grainy, scratched, desaturated vintage film-still look - worn, aged, low-fidelity',
    'Archival document': 'an old document, photograph, notebook or news clipping shown flat, aged paper texture and creases',
    # Metaphor / motif
    'Visual metaphor': 'a striking symbolic image that stands in for the idea rather than showing it literally',
    'Visual motif': 'a single recurring symbolic object or shape foregrounded and isolated in the frame',
    # Lighting
    'Silhouette / backlight': 'the subject backlit into a pure silhouette against a bright background',
    'Three-point lighting': 'polished three-point lighting - a bright key, soft fill, and a rim/back light cleanly separating the subject',
    'High-key lighting': 'bright, even, low-contrast high-key lighting with almost no shadows - clean and clinical',
    'Low-key lighting': 'dramatic low-key chiaroscuro - deep shadows, hard contrast, a single shaft of light carving the subject out of darkness',
    'Natural light': 'soft available natural light with gentle window/daylight direction, unstaged and realistic',
    'Practical lighting': 'lit only by visible in-frame sources - lamps, monitors, windows - warm, moody and grounded',
}


def framing_directive(shot_size, techniques=None):
    """One concrete framing clause for the image/video prompt, combining the
    shot size (see _SHOT_SIZE_FRAMING) with any perspective-bearing technique
    (see _TECHNIQUE_FRAMING). Returns '' if nothing applies."""
    parts = []
    size_clause = _SHOT_SIZE_FRAMING.get((shot_size or '').strip().upper())
    if size_clause:
        parts.append(size_clause)
    for t in (techniques or []):
        if isinstance(t, str) and t in _TECHNIQUE_FRAMING:
            parts.append(_TECHNIQUE_FRAMING[t])
    return '; '.join(parts)


def wildness_directive(wildness, reference_subject=''):
    """Shared boldness instruction for shot planning and final image prompts."""
    try:
        wildness = max(0.0, min(1.0, float(wildness)))
    except (TypeError, ValueError):
        wildness = 0.0
    if wildness <= 0:
        return ''

    directive = (
        'BOLDNESS: interpret the shot boldly - avoid the obvious, literal framing. Push the '
        'composition, angle, scale, staging, and lighting to a striking extreme that unmistakably '
        'embodies the chosen technique and mode.')
    if wildness >= 0.6 and not (reference_subject or '').strip():
        directive += (
            ' You may reimagine the SUBJECT and staging themselves through the lens of the technique '
            '(a montage, a data visualization, an archival reenactment, a silhouette, a top-down '
            'diagram, etc. genuinely change WHAT is on screen, not only the crop) while staying true '
            "to the scene's topic. Favor the surprising, evocative choice over the safe one.")
    elif (reference_subject or '').strip():
        directive += (
            ' Keep the uploaded-footage subject unchanged even at maximum boldness; express boldness '
            'only through composition, camera, lighting, and staging of that same subject.')
    return directive


def _format_moodboard(moodboard):
    """Compact one-line-per-reference summary of the analyzed moodboard profiles,
    for the shot prompt's visual-style anchor. Returns '' if none usable."""
    if not isinstance(moodboard, list):
        return ''
    lines = []
    for ref in moodboard[:8]:
        if not isinstance(ref, dict):
            continue
        title = (ref.get('title') or '').strip()
        bits = []
        if (ref.get('visual_style') or '').strip():
            bits.append(ref['visual_style'].strip())
        meta = ' / '.join(p for p in ((ref.get('tone') or '').strip(), (ref.get('pacing') or '').strip()) if p)
        if meta:
            bits.append(meta)
        techs = [t.strip() for t in (ref.get('observed_techniques') or []) if isinstance(t, str) and t.strip()]
        if techs:
            bits.append('techniques: ' + ', '.join(techs))
        desc = ' — '.join(bits)
        if title and desc:
            lines.append(f'- "{title}": {desc}')
        elif title or desc:
            lines.append(f'- {title or desc}')
    return '\n'.join(lines)


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

    def generate_shot_plan(self, title, scene_notes='', narration='', act_title='', documentary_mode=None, techniques=None, moodboard=None, abstract='', role='', reference_subject='', wildness=0.0, count=1, return_all=False):
        """Infers one shot, or a distinct list when return_all=True.

        Two distinct kinds of input steer it:
        - WHAT the shot is ABOUT (subject/content): the paper abstract, the
          scene narration, the track role (Primary vs Cutaway), title/act, and
          - if the presenter uploaded their own footage - a description of that
          footage's subject (reference_subject), which takes precedence so the
          generated shot matches what they filmed.
        - HOW the shot looks (composition/camera/lighting): the documentary mode,
          the moodboard reference style, the chosen techniques, and the scene
          notes (treated as the director's staging guidance for this shot).
        NONE are required; with little to go on the model invents a plausible
        generic shot rather than refuse.

        Returns {'shot_size', 'movement', 'narrative_operation', 'purpose',
        'visual_description', 'duration_seconds'}. Tolerant of invalid enum
        values and legacy frame-shaped responses."""
        if not self.is_configured():
            raise ShotPlanLLMCallError('LLM client is not configured (missing API key or openai package)')

        try:
            count = max(1, min(8, int(count)))
        except (TypeError, ValueError):
            count = 1

        parts = []
        reference_subject = (reference_subject or '').strip()
        if reference_subject:
            # Lead with this before every style/content input. The image prompt
            # also repeats the constraint in server.py, so subject precedence
            # survives both the planning and rendering model calls.
            parts.append(
                'INPUT HIERARCHY — KEEP CONTENT AND DIRECTION SEPARATE. Uploaded footage controls only '
                'the shot CONTENT (the people, objects, and setting). It does NOT control composition, '
                'camera angle, movement, staging, lighting, palette, or pacing. For those directorial '
                'choices, obey the scene notes and selected techniques below, even if that means presenting '
                'the uploaded subject very differently from how it originally appeared. CONTENT REFERENCE:\n'
                f'{reference_subject}'
            )
        # --- HOW it looks: composition / camera movement / lighting drivers ---
        if (scene_notes or '').strip():
            parts.append(
                "Scene notes (AUTHORITATIVE direction for THIS shot's composition, camera, staging, and "
                f"lighting — visibly follow these instructions):\n{scene_notes.strip()}")
        tech = [t.strip() for t in (techniques or []) if isinstance(t, str) and t.strip()]
        if tech:
            parts.append(
                "Selected techniques (AUTHORITATIVE — make each applicable technique unmistakable in the "
                "shot's composition, camera movement, staging, or lighting): " + ', '.join(tech) + '.')
        if documentary_mode in _MODE_GUIDANCE:
            parts.append(f'Documentary mode (supporting look/style where direction is unspecified): {_MODE_GUIDANCE[documentary_mode]}')
        # moodboard_block = _format_moodboard(moodboard)
        # if moodboard_block:
        #     parts.append(
        #         'Moodboard reference style (supporting tone/palette/pacing only; never override scene notes or '
        #         'selected techniques):\n' + moodboard_block
        #     )

        # --- WHAT it's about: subject / content drivers ---
        role_norm = (role or '').strip().lower()
        if role_norm in ('primary', 'aroll', 'a-roll'):
            parts.append('Track role: PRIMARY - the main on-screen subject that carries the narration; show that subject directly.')
        elif role_norm in ('cutaway', 'broll', 'b-roll'):
            parts.append('Track role: CUTAWAY - a supporting shot of a related object, detail, process, or environment (NOT the main speaker); illustrate the idea obliquely.')
        if (narration or '').strip():
            parts.append(f"Scene narration (the voiceover - a strong anchor for this scene's content):\n{narration.strip()}")
        if (abstract or '').strip():
            parts.append(f"Paper abstract (what the research is about - grounds the scene's subject matter):\n{abstract.strip()}")
        # if (title or '').strip():
        #     parts.append(f'Scene title: {title.strip()}')
        # if (act_title or '').strip():
        #     parts.append(f'Arc part (act) this scene sits in: {act_title.strip()}')

        # Wildness (0..1): a boldness dial for the evaluation harness. Pushes the
        # model off the obvious/literal shot and, at the top end, lets it
        # reimagine the SUBJECT/staging through the lens of the technique (so a
        # montage vs an interview differ in WHAT is on screen, not just the crop)
        # rather than the default "keep the exact same subject" restraint. Also
        # raises the sampling temperature. wildness<=0 leaves behavior unchanged.
        try:
            wildness = max(0.0, min(1.0, float(wildness)))
        except (TypeError, ValueError):
            wildness = 0.0
        directive = wildness_directive(wildness, reference_subject)
        if directive:
            parts.append(directive)

        parts.append(
            f'OUTPUT REQUEST: Return exactly {count} shot option(s). '
            + ('Narration is present: derive distinct operations from it.' if (narration or '').strip()
               else 'Narration is absent: choose distinct operations and pairings randomly.'))

        user_content = '\n\n'.join(parts).strip() or (
            'No specific material was provided for this scene - invent a plausible, generic documentary '
            'shot for an academic-research film.'
        )
        # 0.7 baseline -> up to ~1.1 at full wildness (kept below the point where
        # gpt-4o-mini's JSON tends to degrade).
        temperature = round(0.7 + 0.4 * wildness, 3)

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
                    temperature=temperature,
                )
                parsed = json.loads(response.choices[0].message.content)
                shots_raw = parsed.get('shots')
                if not isinstance(shots_raw, list):
                    legacy = parsed.get('shot')
                    shots_raw = [legacy] if isinstance(legacy, dict) else []
                if len(shots_raw) != count:
                    raise ValueError(f'expected {count} shots, got {len(shots_raw)}: {parsed!r}')

                plans = []
                for shot in shots_raw:
                    if not isinstance(shot, dict):
                        raise ValueError(f'invalid shot entry: {shot!r}')
                    shot_size = (shot.get('shot_size') or '').strip().upper()
                    movement = (shot.get('movement') or '').strip().lower()
                    operation = (shot.get('narrative_operation') or '').strip().lower()
                    if shot_size not in _SHOT_SIZES or movement not in _MOVEMENTS or operation not in _NARRATIVE_OPERATIONS:
                        raise ValueError(f'invalid shot vocabulary: {shot!r}')
                    visual_description = (shot.get('visual_description') or '').strip()
                    if not visual_description:
                        raise ValueError(f'shot has no visual_description: {shot!r}')
                    duration = shot.get('duration_seconds')
                    plans.append({
                        'shot_size': shot_size,
                        'movement': movement,
                        'narrative_operation': operation,
                        'purpose': (shot.get('purpose') or '').strip() or 'Establish this scene.',
                        'visual_description': visual_description,
                        'duration_seconds': duration if isinstance(duration, (int, float)) and duration > 0 else _DEFAULT_DURATION,
                    })

                if count > 1:
                    operations = [p['narrative_operation'] for p in plans]
                    pairings = [(p['shot_size'], p['movement']) for p in plans]
                    if len(set(operations)) != count or len(set(pairings)) != count:
                        raise ValueError(f'shot options were not distinct: {plans!r}')
                return plans if return_all else plans[0]
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise ShotPlanLLMCallError(f'Shot plan generation failed after retry: {last_error}')
