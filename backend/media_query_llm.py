"""Generate stock-video and sound-effect search queries for one scene."""
import json
import os

import httpx

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


_SYSTEM_PROMPT = """You formulate two concise external-media search queries for one filmable narration highlight - a short clause the presenter has already chosen to illustrate with a shot.

VIDEO: the highlight IS the concrete visual beat - it defines what is depicted. Use the surrounding narration and the paper's topic/abstract to disambiguate the highlight's real subject/setting (who or what it refers to in THIS research), never to replace or broaden it. Be specific and on-topic: prefer the concrete real-world subject the research is about (its domain, apparatus, field site, or people) over a generic office/computer stand-in. Documentary mode influences style and atmosphere, never the subject. Return a literal, filmable 3-10 word stock-video query. Avoid academic jargon and camera instructions that a stock search engine cannot match. If the highlight is abstract (academic jargon, an invisible process, a dataset, theory, metric, or idea with no literal footage), return a concrete query that metaphorically or observationally represents it THROUGH the paper's actual domain (for example, for a self-driving paper "car sensor test track", not a generic "person at computer").

AUDIO priority:
1. Translate the highlight into a SOUND YOU CAN HEAR, not a description of the research topic.
2. Prefer one familiar sound source or action plus an optional setting: "footsteps in hallway", "paper rustling", "quiet laboratory ambience", "keyboard typing".
3. Use the surrounding narration only to choose that broad, audible source; treat academic names, theories, species, datasets, institutions, and technical terms as context to paraphrase or discard.
4. Prefer common Freesound-style tags and generic searchable wording over rare proper nouns or exact details. If no literal sound is implied, choose a plausible environmental bed such as "room tone", "office ambience", "outdoor ambience", or "subtle machinery hum".
5. Documentary mode may shape the atmosphere (naturalistic, intimate, tense), but never replace the sound source.
Return exactly 2-5 ordinary words (up to 6 only when needed), lower-case, as a sound-effect or ambience search query. No sentence, explanation, abstract concept, music genre, camera language, visual metaphor, or proper noun.

Respond only as JSON: {"video_query":"...","audio_query":"..."}."""


_FOOTAGE_PLAN_SYSTEM_PROMPT = """You are a documentary editor planning the FOOTAGE for one scene's narration, beat by beat, in the pacing style of a Vox-type explainer.

You receive the scene's spoken beats (each a short clause), the full narration, the documentary mode, and the paper's abstract. For EACH beat, decide how its footage should be cut and what it should show.

RHYTHM - choose one per beat:
- "hold": ONE sustained shot that stays on screen for the whole beat. Use for a single idea, a reflective or thesis line, an establishing/opening moment, or an emotional beat that should breathe.
- "montage": SEVERAL quick cuts across the beat. Use for enumerations, lists, comparisons, a sequence of steps, rapid factual density, or action - anything that names or shows more than one thing.

SHOT_COUNT: 1 for "hold". For "montage", 2-4, matching how many distinct things the beat actually references (do not pad). Vary rhythm across the scene so it does not feel uniform - a good scene alternates held moments with bursts of cuts.

VIDEO_QUERIES: return exactly shot_count queries, one per shot, each a literal filmable 3-10 word stock-video query. For a montage, each query shows a DIFFERENT concrete subject/angle/scale from the beat (never the same query twice). Be specific and on-topic: use the abstract to pin the real research domain (its apparatus, field site, people, or subject) rather than a generic office/computer stand-in. Avoid academic jargon and camera instructions a search engine cannot match. If a beat is abstract (an invisible process, theory, metric, dataset), give concrete observational/metaphorical queries THROUGH the paper's actual domain.

Preserve each beat's start/end exactly. Return only JSON in this shape:
{"beats":[{"start":0,"end":42,"rhythm":"montage","shot_count":3,"video_queries":["...","...","..."]}]}"""


def _normalise_footage_plan(raw_beats, source_beats):
    """Validate/clamp the model's per-beat plan against the beats we sent.

    Matches by (start,end); drops entries we did not ask for; forces
    shot_count to match the query list length (1-4); guarantees at least one
    non-empty query per beat, falling back to the beat's own text so a beat is
    never dropped for a malformed reply. Returns entries in source order.
    """
    by_range = {(int(b['start']), int(b['end'])): b for b in source_beats}
    planned = {}
    for item in raw_beats if isinstance(raw_beats, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            key = (int(item.get('start')), int(item.get('end')))
        except (TypeError, ValueError):
            continue
        if key not in by_range or key in planned:
            continue
        rhythm = 'montage' if str(item.get('rhythm') or '').strip().lower() == 'montage' else 'hold'
        queries = [str(q or '').strip() for q in (item.get('video_queries') or []) if str(q or '').strip()]
        # Distinct, capped at 4; a hold keeps only its first query.
        seen = set()
        distinct = []
        for q in queries:
            low = q.lower()
            if low not in seen:
                seen.add(low)
                distinct.append(q[:160])
        if rhythm == 'hold':
            distinct = distinct[:1]
        distinct = distinct[:4]
        if not distinct:
            distinct = [by_range[key]['text'][:160]]
        planned[key] = {
            'start': key[0],
            'end': key[1],
            'rhythm': 'montage' if (rhythm == 'montage' and len(distinct) > 1) else 'hold',
            'shot_count': len(distinct),
            'video_queries': distinct,
        }
    # Any beat the model skipped falls back to a single hold on its own text.
    result = []
    for b in source_beats:
        key = (int(b['start']), int(b['end']))
        result.append(planned.get(key) or {
            'start': key[0], 'end': key[1], 'rhythm': 'hold',
            'shot_count': 1, 'video_queries': [b['text'][:160]],
        })
    return result


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

    def generate_queries(self, highlight, narration='', documentary_mode='', abstract=''):
        if not self.is_configured():
            raise MediaQueryLLMCallError('Media-query LLM is not configured (missing API key or openai package)')
        highlight = (highlight or '').strip()
        if not highlight:
            raise MediaQueryLLMCallError('highlight is required')
        payload = {
            'highlight': highlight,
            'narration': (narration or '').strip(),
            'documentary_mode': (documentary_mode or '').strip(),
            # The paper's topic/abstract is what pins an abstract clause to the
            # research's real domain instead of a generic office/computer shot.
            'paper_abstract': (abstract or '').strip()[:2000],
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

    def plan_footage(self, clauses, narration='', documentary_mode='', abstract=''):
        """Per-beat documentary footage plan for one narration segment.

        Given the segment's chosen clause beats (each {text, start, end}), decide
        for EACH beat its cut rhythm and the concrete stock-video queries that
        illustrate it - so Visualize can create the right NUMBER of shots per
        beat (one sustained hold, or several quick cuts) before any of them are
        searched. Grounded in the paper abstract so abstract beats resolve to
        the research's real domain rather than generic stock (see _SYSTEM_PROMPT's
        own abstract rule, shared here).

        Returns a list of {start, end, rhythm, shot_count, video_queries[]} in
        input order, offsets preserved. Raises MediaQueryLLMCallError on failure;
        callers fall back to the local per-node query path.
        """
        if not self.is_configured():
            raise MediaQueryLLMCallError('Media-query LLM is not configured (missing API key or openai package)')
        beats = [
            {
                'text': str(c.get('text') or '').strip(),
                'start': int(c.get('start', 0)),
                'end': int(c.get('end', 0)),
            }
            for c in (clauses or [])
            if isinstance(c, dict) and str(c.get('text') or '').strip()
        ][:24]
        if not beats:
            raise MediaQueryLLMCallError('at least one clause is required')
        payload = {
            'beats': beats,
            'narration': (narration or '').strip(),
            'documentary_mode': (documentary_mode or '').strip(),
            'paper_abstract': (abstract or '').strip()[:2000],
        }
        try:
            response = self._get_client().chat.completions.create(
                model=self.model,
                messages=[
                    {'role': 'system', 'content': _FOOTAGE_PLAN_SYSTEM_PROMPT},
                    {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
                ],
                response_format={'type': 'json_object'},
                temperature=0.4,
            )
            parsed = json.loads(response.choices[0].message.content)
            raw = parsed.get('beats') if isinstance(parsed, dict) else None
            if not isinstance(raw, list):
                raise ValueError('response omitted beats')
            return _normalise_footage_plan(raw, beats)
        except Exception as exc:
            raise MediaQueryLLMCallError(f'Could not plan footage: {exc}') from exc
