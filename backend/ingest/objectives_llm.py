"""LLM-suggested learning objectives + audience-perspective questions (see
server.py's /learning_objectives/suggest route), scoped to the whole
presentation, a section (range of slides), or a single slide -
collect-data.html's Learning Objectives module calls this once per scope,
grounded in that scope's transcript text and the stated audience.

Returns two parallel lists: instructor-authored objectives, and questions
the stated audience would want answered from their own perspective - both
are rendered as their own labeled row of suggested chips in the UI, but
either can be clicked to add into the same underlying objectives list for
that scope (there's no separate storage for "audience questions" once
added).

Same env vars as feedback_llm.py/segmentation/llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - there's no non-LLM way to draft objectives from a
transcript, so this raises ObjectivesLLMCallError if unconfigured.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_SYSTEM_PROMPT = """You are an instructional designer helping a presenter write learning objectives for their presentation. You will be given the intended audience, the scope of content to write objectives for (the entire presentation, a section of slides, or a single slide), and the transcript of what will be said in that scope.

Propose exactly 3 concise, measurable learning objectives for that scope, appropriate for the stated audience. Each objective should:
- Start with a concrete action verb (e.g. "Explain", "Identify", "Compare", "Describe", "Evaluate") rather than vague verbs like "understand" or "learn about".
- Be grounded only in content actually present in the given transcript - do not invent objectives about topics the transcript doesn't cover.
- Be a single, self-contained sentence or phrase, without a trailing period.

Also propose exactly 3 questions that this specific stated audience would want answered about this content. Before writing them, think concretely about who this audience actually is: their existing expertise, the vocabulary they'd use, what they're professionally or personally responsible for, and what about this content would matter most to them given that. The questions must be grounded in that specific background, not generic curiosity that almost any audience could have - if you swapped in a very different audience, these questions should no longer make sense for them. Avoid template phrasing like "How does this affect me?" or "Why does this matter?"; instead ask about the specific mechanisms, tradeoffs, numbers, or decisions that audience would actually care about. Write them in that audience's own voice. The questions can extend beyond the exact content of the presentation, as long as they are clearly related and specific to that audience.

Respond with a single JSON object with exactly two keys:
- "objectives": a JSON array of exactly 3 objective strings, as described above.
- "audience_questions": a JSON array of exactly 3 question strings, as described above.
Respond with only the JSON object, no other text."""


class ObjectivesLLMCallError(Exception):
    pass


class ObjectivesLLMClient:
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

    def suggest_objectives(self, audience, scope_label, slides):
        """slides: [{'slide_index': int, 'transcript': str}, ...]. Returns
        {'objectives': [...], 'audience_questions': [...]}, each capped at 3
        regardless of what the model returns."""
        if not self.is_configured():
            raise ObjectivesLLMCallError('LLM client is not configured (missing API key or openai package)')

        transcript_lines = '\n'.join(
            f"Slide {s.get('slide_index')}: {s.get('transcript') or '(no speech on this slide)'}"
            for s in slides
        )
        user_content = f'Audience: {audience}\nScope: {scope_label}\n\n{transcript_lines}'

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
                    temperature=0.4,
                )
                parsed = json.loads(response.choices[0].message.content)

                def _clean(values):
                    return [str(v).strip() for v in (values or []) if str(v).strip()][:3]

                return {
                    'objectives': _clean(parsed.get('objectives')),
                    'audience_questions': _clean(parsed.get('audience_questions')),
                }
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise ObjectivesLLMCallError(f'Learning objective suggestion failed after retry: {last_error}')
