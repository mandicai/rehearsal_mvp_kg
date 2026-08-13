"""LLM-inferred B-roll cutaways for an expository scene's voice-of-god
narration (see server.py's /paper/generate_cutaways route and
js/paper-extract.js's "Generate shot" flow for an expository scene).

Given the scene's narration (plus title/notes/abstract for grounding), this
pulls out the important phrases/entities the narration names and turns each
into a cutaway: a short caption, a concrete filmable background description
(handed to the image model for a still), and a directional camera MOTION
(one of directional_motion_sketches.html's camera-frame moves) that the UI
animates over the still. The motions are deliberately varied so a scene shows
a diversity of camera moves rather than the same one repeated.

Same env vars as shot_plan_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - raises CutawayLLMCallError if unconfigured.
"""
import json
import os
import random

import httpx

from documentary_modes import DOCUMENTARY_MODE_KEYS

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

# Camera-frame directional moves from directional_motion_sketches.html that map
# onto a real background still (the orange camera rectangle moves/zooms over
# the image). The pure subject-relationship types there (converge/diverge/
# cross) are omitted - they animate abstract nodes, not a camera over one
# static image. Keep in sync with the .motion-<type> CSS in styles-index.css.
_MOTION_TYPES = (
    'reveal', 'return', 'approach', 'retreat', 'ascend', 'descend',
    'orbit', 'countermotion', 'enterexit',
)

# Bounds how many cutaways (= image-gen calls) one scene triggers.
MAX_CUTAWAYS = 6

# Per-mode bias (kept for symmetry with the other *_llm.py; cutaways are an
# expository feature, but a documentary_mode is still threaded through).
_MODE_GUIDANCE = {
    'expository': 'Illustrative, literal cutaways that back up what the narrator is asserting.',
    'observational': 'Quieter, more incidental cutaways drawn from the scene itself.',
    'participatory': 'Cutaways of the things a speaker references as they talk.',
    'poetic': 'More associative, atmospheric cutaways than literal ones.',
}
assert set(_MODE_GUIDANCE) == set(DOCUMENTARY_MODE_KEYS), 'cutaway_llm._MODE_GUIDANCE keys must match documentary_modes.DOCUMENTARY_MODE_KEYS'

_SYSTEM_PROMPT = """You are a documentary editor choosing B-roll cutaways to play under a voice-of-god narration. You will be given the narration (and possibly a scene title, scene notes, and the paper's abstract for grounding).

Pull out the handful of most important, concrete phrases or entities the narration actually names - the things a viewer would benefit from SEEING while they're mentioned (people, places, objects, processes, data, institutions, events). For each, produce one cutaway:
- "caption": the short phrase/entity itself (a few words, taken from or closely paraphrasing the narration).
- "background_visual": a concrete, filmable description of a real-world scene that shows that thing (what a camera would actually capture) - never academic jargon or the entity name verbatim; translate it into something shootable.
- "motion_type": the camera move that plays over it, one of: reveal (pan from one thing to a related one), return (pan back), approach (push in to inspect/emphasize), retreat (pull out to contextualize), ascend (tilt up - escalation/growth/scale), descend (tilt down - drill into detail/grounding), orbit (move around to examine), countermotion (camera and subject move opposite - tension), enterexit (something enters, holds, then leaves - an event/transition).

Choose motions for VARIETY across the cutaways - deliberately mix different moves rather than repeating one; two cutaways should rarely share the same motion unless it genuinely fits.

Return between 1 and %d cutaways depending on how many genuinely important, showable things the narration names - fewer is fine. Respond with a JSON object of the exact shape {"cutaways": [{"caption": "...", "background_visual": "...", "motion_type": "..."}, ...]}. Respond with only the JSON object, no other text.""" % MAX_CUTAWAYS


class CutawayLLMCallError(Exception):
    pass


class CutawayLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            # Same tight-connect/generous-read timeout + max_retries=0 as the
            # other text clients (the retry loop below handles one retry).
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(30.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def generate_cutaways(self, narration, title='', scene_notes='', abstract='', documentary_mode=None, techniques=None):
        """Returns a list (1..MAX_CUTAWAYS) of {'caption', 'background_visual',
        'motion_type'} inferred from the narration. Tolerant of a partially-bad
        response the same way the other *_llm.py clients are: entries missing a
        caption or background_visual are dropped; an invalid/missing motion_type
        is replaced with a random pick; and motions are spread for diversity."""
        if not self.is_configured():
            raise CutawayLLMCallError('LLM client is not configured (missing API key or openai package)')

        parts = []
        if (narration or '').strip():
            parts.append(f'Narration:\n{narration.strip()}')
        if (title or '').strip():
            parts.append(f'Scene title: {title.strip()}')
        if (scene_notes or '').strip():
            parts.append(f'Scene notes:\n{scene_notes.strip()}')
        if (abstract or '').strip():
            parts.append(f"Paper abstract:\n{abstract.strip()}")
        if not parts:
            parts.append('No narration was provided - invent a few plausible, generic documentary cutaways.')
        if documentary_mode in _MODE_GUIDANCE:
            parts.append(f'Documentary mode: {_MODE_GUIDANCE[documentary_mode]}')
        tech = [t.strip() for t in (techniques or []) if isinstance(t, str) and t.strip()]
        if tech:
            parts.append('Favor these filming/editing techniques where they naturally fit: ' + ', '.join(tech) + '.')
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
                    temperature=0.8,
                )
                parsed = json.loads(response.choices[0].message.content)
                raw = parsed.get('cutaways')
                if not isinstance(raw, list) or not raw:
                    raise ValueError(f'response missing cutaways list: {parsed!r}')

                cutaways = []
                for entry in raw:
                    if not isinstance(entry, dict):
                        continue
                    caption = (entry.get('caption') or '').strip()
                    background = (entry.get('background_visual') or '').strip()
                    if not caption or not background:
                        continue
                    motion = (entry.get('motion_type') or '').strip().lower()
                    cutaways.append({
                        'caption': caption,
                        'background_visual': background,
                        'motion_type': motion if motion in _MOTION_TYPES else None,
                    })
                    if len(cutaways) >= MAX_CUTAWAYS:
                        break

                if not cutaways:
                    raise ValueError(f'no valid cutaway entries in response: {raw!r}')

                return _diversify_motions(cutaways)
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise CutawayLLMCallError(f'Cutaway generation failed after retry: {last_error}')


def _diversify_motions(cutaways):
    """Fills in any missing motion_type and spreads motions for variety: walks
    a shuffled copy of the vocabulary so consecutive cutaways rarely repeat a
    move, only reusing one once every type has been used."""
    order = list(_MOTION_TYPES)
    random.shuffle(order)
    pool = list(order)
    used = set()
    for cut in cutaways:
        motion = cut['motion_type']
        if motion is None:
            if not pool:
                pool = list(order)
            motion = pool.pop(0)
        else:
            # Keep the LLM's pick, but avoid an immediate repeat when we can.
            if motion in used and pool:
                # prefer an unused one for variety
                alt = next((m for m in pool if m not in used), None)
                if alt:
                    motion = alt
            if motion in pool:
                pool.remove(motion)
        used.add(motion)
        cut['motion_type'] = motion
    return cutaways
