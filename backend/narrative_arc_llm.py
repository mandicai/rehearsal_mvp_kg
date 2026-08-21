"""LLM-ranked documentary narrative arc suggestions (see server.py's
/paper/suggest_arcs route), for storyboard.html's arc-suggestion step.

The presenter records themselves narrating their intent and/or picks a few
suggested-focus statements; suggest_arcs_from_intent ranks a recommended arc
(with reasoning tied to what they actually said) plus a few alternatives.
Once they accept one, its named parts become the narrative-act groups shown
right away (js/paper-extract.js's runAcceptArc) - there's no further LLM
step to place paper sections into them; the presenter does that manually
from there (dragging a section's chip into a row, or adding one directly).

Same env vars as feedback_llm.py/ingest/objectives_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to turn a spoken narration/focus
statements into a narrative arc, so this raises NarrativeArcLLMCallError if
unconfigured.
"""
import json
import os

import httpx

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

from documentary_modes import DOCUMENTARY_MODE_KEYS
from documentary_techniques import DOCUMENTARY_TECHNIQUE_KEYS

# Kept in sync by convention with js/paper-extract.js's ARC_TEMPLATES - no
# shared-config-loading mechanism exists in this small repo, and building
# one for 5 short lists would be overkill. If you touch one, touch both.
# Each part's `description` is shown to the presenter (see renderMovieEditor)
# as a one-line reminder of what that part of the arc should illustrate.
ARC_TEMPLATES = [
    {
        'name': 'Solving a problem or puzzle',
        'sections': [
            {'name': 'Puzzle or problem', 'description': 'Introduce the central puzzle or open question this research sets out to solve.'},
            {'name': 'Background of problem', 'description': "Give the context and why this problem is hard or hasn't been solved yet."},
            {'name': 'Struggle to solve problem', 'description': 'Walk through the approach being tried, and the obstacles along the way.'},
            {'name': 'Turning point', 'description': 'The key insight or moment where the approach starts to click.'},
            {'name': 'Solution', 'description': 'The resolution - what was found, and why it solves the puzzle.'},
        ],
    },
    {
        'name': 'Challenging an assumption',
        'sections': [
            {'name': 'Conventional belief', 'description': 'State the widely-held assumption this research questions.'},
            {'name': 'Background of belief', 'description': 'Explain where that belief comes from and why it seemed reasonable.'},
            {'name': 'Unexpected finding', 'description': 'The surprising result that contradicts the conventional belief.'},
            {'name': 'Fallout of finding', 'description': 'What breaks or changes once the old belief no longer holds.'},
            {'name': 'Revised understanding', 'description': 'The new, more accurate picture that replaces the old assumption.'},
        ],
    },
    {
        'name': "Following a person or team's journey",
        'sections': [
            {'name': 'Character introduced', 'description': 'Introduce the researcher(s) and what drew them to this work.'},
            {'name': 'Character confronted with problem', 'description': 'The problem or challenge they set out to tackle.'},
            {'name': 'Character tackles problem and faces setbacks', 'description': 'Their attempts, false starts, and setbacks along the way.'},
            {'name': 'Character faces turning point', 'description': 'The moment their approach shifts or a breakthrough emerges.'},
            {'name': 'Character learns lessons and deals with outcomes', 'description': 'What they found, and what they took away from the process.'},
        ],
    },
    {
        'name': 'Tracing a transformation',
        'sections': [
            {'name': 'Earlier state', 'description': 'Describe how things were before this change - the starting point.'},
            {'name': 'Forces driving change', 'description': 'What pressures, needs, or discoveries pushed things to change.'},
            {'name': 'Notable points of change', 'description': 'Key moments or milestones marking the transformation as it happened.'},
            {'name': 'Present state', 'description': 'Where things stand now, as a result of this research.'},
            {'name': 'Possible futures', 'description': 'Where this transformation could lead next.'},
        ],
    },
    {
        'name': 'Exposing a hidden system',
        'sections': [
            {'name': 'Surface experiences', 'description': 'What people notice day-to-day, without seeing the mechanism behind it.'},
            {'name': 'Clues for what is hidden', 'description': 'The hints or anomalies that suggested something deeper was going on.'},
            {'name': 'Underlying mechanism', 'description': 'The hidden system or process this research uncovers.'},
            {'name': 'Who is affected by the mechanism', 'description': 'Who or what is shaped by this mechanism, and how.'},
            {'name': 'Implications and what to do next', 'description': 'What this discovery means, and what should happen as a result.'},
        ],
    },
]

def _format_template(template):
    parts = '; '.join(f'{s["name"]} ({s["description"]})' for s in template['sections'])
    return f'- "{template["name"]}": {parts}'

_TEMPLATE_LINES = '\n'.join(_format_template(t) for t in ARC_TEMPLATES)


# Used by suggest_arcs_from_intent below - reuses the ARC_TEMPLATES catalog
# and its invent-if-none-fit instruction, but returns several ranked
# candidates instead of committing to one, and asks for reasoning tied to
# what the filmmaker actually said - the frontend shows that reasoning next
# to the top pick, and the rest as alternative chips the presenter can pick
# instead (see js/paper-extract.js's Record Your Intent flow).
_SYSTEM_PROMPT_SUGGEST_ARCS = f"""You are helping a filmmaker plan a video essay based on an academic paper. The filmmaker has described what they want the documentary to convey with one or more short statements. You'll be given these statements and the paper's own abstract and sections if available. Your job is to recommend which narrative arc(s) best fit what they've described.

Five common arc templates (name: parts (with descriptions)):
{_TEMPLATE_LINES}

Recommend the single best-fitting arc first, followed by 2-4 other reasonable alternative arcs, ranked roughly by fit. The five templates serve as examples to inspire, but you can suggest new ones. If inventing a new one, include a short 3-8 word arc name, plus 3-7 short named parts in viewing order, each with a one-sentence description. Only the top recommendation needs a written reason: 1-3 sentences that concretely reference the moodboard references and/or the paper's abstract, explaining why this arc fits - don't invent details not present in what you were given.

If you are also given the paper's actual sections (each with an index), then for EVERY arc you return - the recommendation AND all alternatives - distribute those sections across the arc's parts: assign each section index to one or multiple parts (where its content best belongs). Put the assigned indices in each part's "section_indices". If no sections are given, use an empty "section_indices" for each part.

Respond with a single JSON object of the exact shape {{"recommended": {{"arc_name": "...", "sections": [{{"name": "...", "description": "...", "section_indices": [<int>, ...]}}, ...], "reasoning": "..."}}, "alternatives": [{{"arc_name": "...", "sections": [{{"name": "...", "description": "...", "section_indices": [<int>, ...]}}, ...]}}, ...], "suggested_mode": "<mode key>", "suggested_techniques": ["<technique>", ...], "style_rationale": "..."}}, each sections list in narrative order, with 2-4 entries in alternatives. Respond with only the JSON object, no other text."""

# Used by distill_from_moodboard below - same arc-ranking + section-mapping job
# as _SYSTEM_PROMPT_SUGGEST_ARCS, but the filmmaker's intent arrives as a
# moodboard of reference documentaries (analyzed for style) rather than a
# spoken narration, and the model additionally distills a documentary mode +
# techniques (from closed vocabularies) with a rationale grounded in the
# references. The technique/mode vocabularies are injected the same way
# _TEMPLATE_LINES is, so the model can only pick real chip keys.
_SYSTEM_PROMPT_DISTILL = f"""You are helping a filmmaker plan a video essay based on an academic paper. Instead of describing their intent in words, the filmmaker has assembled a MOODBOARD of reference documentaries (each analyzed for its visual style, techniques, tone and pacing), and you're given the paper's own abstract and sections if available. Your job is to distill that moodboard into a concrete creative direction for THIS paper: the best-fitting narrative arc(s), a documentary mode, and a few techniques.

Five common arc templates (name: parts (with descriptions)):
{_TEMPLATE_LINES}

Recommend the single best-fitting arc first, followed by 2-4 other reasonable alternative arcs, ranked roughly by fit. The five templates serve as examples to inspire, but you can suggest new ones. If inventing a new one, include a short 3-8 word arc name, plus 3-7 short named parts in viewing order, each with a one-sentence description. Only the top recommendation needs a written reason: 1-3 sentences that concretely reference the moodboard references and/or the paper's abstract, explaining why this arc fits - don't invent details not present in what you were given.

If you are also given the paper's actual sections (each with an index), then for EVERY arc you return - the recommendation AND all alternatives - distribute those sections across the arc's parts: assign each section index to one or multiple parts (where its content best belongs). Put the assigned indices in each part's "section_indices". If no sections are given, use an empty "section_indices" for each part.

Additionally, distill from the moodboard:
- "suggested_mode": the single documentary mode the references most point toward, exactly one of: {list(DOCUMENTARY_MODE_KEYS)}.
- "suggested_techniques": 0-10 techniques the references favor, inspired by this list (verbatim strings): {list(DOCUMENTARY_TECHNIQUE_KEYS)}. "Primary" and "Cutaway" are scene track roles, never techniques; do not return them here.
- "style_rationale": 1-3 sentences grounding the mode + technique choices in specific references.

Respond with a single JSON object of the exact shape {{"recommended": {{"arc_name": "...", "sections": [{{"name": "...", "description": "...", "section_indices": [<int>, ...]}}, ...], "reasoning": "..."}}, "alternatives": [{{"arc_name": "...", "sections": [{{"name": "...", "description": "...", "section_indices": [<int>, ...]}}, ...]}}, ...], "suggested_mode": "<mode key>", "suggested_techniques": ["<technique>", ...], "style_rationale": "..."}}, each sections list in narrative order, with 2-4 entries in alternatives. Respond with only the JSON object, no other text."""


def _assign_section_indices(sections_out, sections_raw, valid_indices):
    """Distribute valid_indices across an arc's parts from the model's per-part
    section_indices - each index used once, in order; any valid index the model
    left out (or duplicated/mislabeled) is appended to the last part so every
    section is covered exactly once. Shared by suggest_arcs_from_intent and
    distill_from_moodboard."""
    if not valid_indices:
        for sec in sections_out:
            sec['section_indices'] = []
        return
    remaining = list(valid_indices)
    for sec, raw in zip(sections_out, sections_raw):
        picked = []
        for idx in (raw.get('section_indices') or []):
            if isinstance(idx, int) and idx in remaining:
                remaining.remove(idx)
                picked.append(idx)
        sec['section_indices'] = picked
    if remaining:  # anything unassigned -> last part, so nothing is dropped
        sections_out[-1]['section_indices'].extend(remaining)


def _parse_arc(raw, valid_indices):
    """Validate one arc dict (arc_name + a 2-8 entry named sections list) and
    return (arc_name, sections_out) with section_indices distributed. Raises
    ValueError on malformed input. Shared by both arc-suggestion methods."""
    if not isinstance(raw, dict):
        raise ValueError(f'bad arc entry: {raw!r}')
    arc_name = (raw.get('arc_name') or '').strip()
    if not arc_name:
        raise ValueError(f'arc entry missing arc_name: {raw!r}')
    sections_raw = raw.get('sections')
    if (not isinstance(sections_raw, list) or not (2 <= len(sections_raw) <= 8)
            or not all(isinstance(s, dict) and isinstance(s.get('name'), str) and s.get('name').strip() for s in sections_raw)):
        raise ValueError(f'bad sections list: {sections_raw!r}')
    sections_out = [{'name': s['name'].strip(), 'description': (s.get('description') or '').strip()} for s in sections_raw]
    _assign_section_indices(sections_out, sections_raw, valid_indices)
    return arc_name, sections_out


def _parse_recommended_and_alternatives(parsed, valid_indices):
    """Pull the recommended arc (with non-empty reasoning) + 1..N valid
    alternatives out of a parsed response, tolerant of a single malformed
    alternative. Raises ValueError if the recommendation or all alternatives
    are unusable. Shared by both arc-suggestion methods."""
    recommended_raw = parsed.get('recommended')
    if not isinstance(recommended_raw, dict):
        raise ValueError(f'response missing recommended: {parsed!r}')
    reasoning = (recommended_raw.get('reasoning') or '').strip()
    if not reasoning:
        raise ValueError(f'recommended.reasoning was empty: {parsed!r}')
    recommended_arc_name, recommended_sections = _parse_arc(recommended_raw, valid_indices)
    recommended = {'arc_name': recommended_arc_name, 'sections': recommended_sections, 'reasoning': reasoning}

    alternatives_raw = parsed.get('alternatives')
    if not isinstance(alternatives_raw, list) or not alternatives_raw:
        raise ValueError(f'response missing alternatives: {parsed!r}')
    # Tolerant on purpose - drop one malformed alternative rather than burning
    # a retry over an otherwise-good response.
    alternatives = []
    for alt in alternatives_raw:
        try:
            alt_arc_name, alt_sections = _parse_arc(alt, valid_indices)
            alternatives.append({'arc_name': alt_arc_name, 'sections': alt_sections})
        except ValueError:
            continue
    if not alternatives:
        raise ValueError(f'no valid alternatives in response: {alternatives_raw!r}')
    return recommended, alternatives


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

    def suggest_arcs_from_intent(self, focus_statements=None, abstract=None, sections=None):
        """focus_statements: list of short strings describing the kind of
        documentary the filmmaker wants (picked from suggested chips and/or
        their own typed-in description) - the primary human signal for the arc.
        At least one focus statement must be given - the caller (server.py's
        /paper/suggest_arcs route) enforces this before calling. (The spoken
        narration transcript that used to also feed this was removed along with
        the recorder UI.)
        abstract: optional text of the extracted paper's own abstract
        section, if the paper had one and it was found (see server.py's
        route, which does that lookup) - additional grounding alongside
        whatever the filmmaker said, not a substitute for it.
        sections: optional list of the paper's real sections as
        [{'index': int, 'title': str}, ...]. When given, every index is
        distributed across each arc's parts (see each part's returned
        'section_indices'), so the frontend can preview how each arc would
        organize this specific paper and auto-place the sections into the
        chosen arc's chapters (js/paper-extract.js's runAcceptArc) - no
        separate placement call needed.
        Ranks the single best-fitting arc (with reasoning tied to what the
        filmmaker actually said) plus a few alternatives, letting the
        presenter accept the top pick or choose a different one - once
        accepted, its named parts become the narrative-act groups the
        frontend shows right away (js/paper-extract.js's runAcceptArc).
        Returns (recommended: {'arc_name': str, 'sections': [{'name': str, 'description': str, 'section_indices': [int, ...]}, ...], 'reasoning': str},
        alternatives: [{'arc_name': str, 'sections': [...]}, ...]) - arc_name
        is a short label for the whole arc (distinct from each part's own
        name); each part's section_indices are the paper-section indices
        mapped into it (empty when no sections were given), covering every
        given index exactly once across the arc."""
        if not self.is_configured():
            raise NarrativeArcLLMCallError('LLM client is not configured (missing API key or openai package)')

        # The paper's real sections to distribute across each arc's parts (see
        # the section_indices handling in parse_arc). Kept as an ordered list of
        # valid indices for the tolerant "cover every index exactly once" fixup.
        paper_sections = [s for s in (sections or []) if isinstance(s, dict) and isinstance(s.get('index'), int)]
        valid_indices = [s['index'] for s in paper_sections]

        parts = []
        if focus_statements:
            bulleted = '\n'.join(f'- {s}' for s in focus_statements)
            parts.append(f'Chosen focus statement(s):\n{bulleted}')
        if abstract:
            parts.append(f"The paper's own abstract:\n\n{abstract}")
        if paper_sections:
            listing = '\n'.join(f"[{s['index']}] {(s.get('title') or '').strip() or 'Untitled'}" for s in paper_sections)
            parts.append(
                'The paper\'s sections (assign every index to exactly one part of each arc, via '
                f'"section_indices"):\n{listing}'
            )
        user_content = '\n\n'.join(parts)

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _SYSTEM_PROMPT_SUGGEST_ARCS},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.3,
                )
                parsed = json.loads(response.choices[0].message.content)
                return _parse_recommended_and_alternatives(parsed, valid_indices)
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise NarrativeArcLLMCallError(f'Arc suggestion failed after retry: {last_error}')

    def distill_from_moodboard(self, reference_profiles, abstract=None, sections=None):
        """The moodboard counterpart to suggest_arcs_from_intent (see
        server.py's /moodboard/distill route). The filmmaker's intent arrives
        as a list of analyzed reference-documentary profiles instead of a
        spoken narration, and in addition to ranking arcs (with the same
        section->part mapping) this distills a documentary mode and techniques.

        reference_profiles: list of dicts, each describing one reference -
        {'title', 'source_kind', 'visual_style', 'observed_techniques': [..],
        'tone', 'pacing', 'transcript'/'transcript_summary', 'note'} (all
        optional; a degraded reference may carry only a title). At least one
        must be given - the caller enforces this.
        abstract / sections: same as suggest_arcs_from_intent.

        Returns a 5-tuple (recommended, alternatives, suggested_mode,
        suggested_techniques, style_rationale): recommended/alternatives have
        the exact same shape suggest_arcs_from_intent returns; suggested_mode
        is a DOCUMENTARY_MODE_KEYS member or None; suggested_techniques is a
        (possibly empty) list of DOCUMENTARY_TECHNIQUE_KEYS members;
        style_rationale is a short string (possibly empty). The mode/technique
        fields are clamped to their closed vocabularies rather than trusted,
        so an invented value is dropped, not surfaced."""
        if not self.is_configured():
            raise NarrativeArcLLMCallError('LLM client is not configured (missing API key or openai package)')

        paper_sections = [s for s in (sections or []) if isinstance(s, dict) and isinstance(s.get('index'), int)]
        valid_indices = [s['index'] for s in paper_sections]

        parts = []
        ref_blocks = []
        for i, ref in enumerate(reference_profiles or [], start=1):
            if not isinstance(ref, dict):
                continue
            title = (ref.get('title') or '').strip() or 'Untitled reference'
            kind = (ref.get('source_kind') or '').strip()
            lines = [f'Reference {i} - "{title}"' + (f' ({kind})' if kind else '') + ':']
            if (ref.get('visual_style') or '').strip():
                lines.append(f"  Visual style: {ref['visual_style'].strip()}")
            techniques = [t for t in (ref.get('observed_techniques') or []) if isinstance(t, str) and t.strip()]
            if techniques:
                lines.append(f"  Observed techniques: {', '.join(techniques)}")
            meta = ' | '.join(
                p for p in (
                    f"Tone: {ref['tone'].strip()}" if (ref.get('tone') or '').strip() else '',
                    f"Pacing: {ref['pacing'].strip()}" if (ref.get('pacing') or '').strip() else '',
                ) if p
            )
            if meta:
                lines.append(f'  {meta}')
            excerpt = (ref.get('transcript_summary') or ref.get('transcript') or '').strip()
            if excerpt:
                lines.append(f"  Narration: {excerpt[:600]}")
            if (ref.get('note') or '').strip():
                lines.append(f"  Presenter note: {ref['note'].strip()}")
            ref_blocks.append('\n'.join(lines))
        if ref_blocks:
            parts.append('Moodboard of reference documentaries:\n\n' + '\n\n'.join(ref_blocks))

        if abstract:
            parts.append(f"The paper's own abstract:\n\n{abstract}")
        if paper_sections:
            def _fmt_section(s):
                line = f"[{s['index']}] {(s.get('title') or '').strip() or 'Untitled'}"
                snippet = (s.get('snippet') or '').strip()
                return f'{line} - {snippet}' if snippet else line
            listing = '\n'.join(_fmt_section(s) for s in paper_sections)
            parts.append(
                'The paper\'s sections (each shown as "[index] Title - snippet of its opening text"; '
                'assign every index to exactly one part of each arc, via "section_indices"):\n'
                f'{listing}'
            )
        user_content = '\n\n'.join(parts)

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _SYSTEM_PROMPT_DISTILL},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.3,
                )
                parsed = json.loads(response.choices[0].message.content)
                recommended, alternatives = _parse_recommended_and_alternatives(parsed, valid_indices)

                # Clamp mode/techniques to their closed vocabularies rather than
                # trust the model - an invented value is a lost hint, not a
                # failure (same tolerance philosophy as the alternatives above).
                mode = parsed.get('suggested_mode')
                if mode not in DOCUMENTARY_MODE_KEYS:
                    mode = None
                techniques = [
                    t for t in (parsed.get('suggested_techniques') or [])
                    if isinstance(t, str) and t in DOCUMENTARY_TECHNIQUE_KEYS
                ]
                techniques = list(dict.fromkeys(techniques))  # de-dupe, keep order
                style_rationale = (parsed.get('style_rationale') or '').strip()

                return recommended, alternatives, mode, techniques, style_rationale
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise NarrativeArcLLMCallError(f'Moodboard distillation failed after retry: {last_error}')
