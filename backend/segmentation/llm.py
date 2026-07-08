"""LLM-based segment enrichment (entities + keyphrases + topic label +
summary, in one call), used by labeling.LLMLabeler when a key is configured.

One client works for either OpenAI or OpenRouter, since OpenRouter speaks the
OpenAI-compatible API - only the base URL and key differ:

    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL   default 'https://api.openai.com/v1';
                      set to 'https://openrouter.ai/api/v1' for OpenRouter
    LLM_MODEL         default 'gpt-4o-mini'; OpenRouter model slugs are
                      provider-prefixed, e.g. 'anthropic/claude-3.5-haiku'

No key is required to run the app - segmentation.labeling falls back to a
local heuristic labeler when LLMClient.is_configured() is False.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - LLM path stays unconfigured
    OpenAI = None

_SYSTEM_PROMPT = """You are enriching one segment of a longer document for downstream knowledge-graph construction. Given the segment text (and, if available, its source section/subsection heading), respond with a single JSON object with exactly these keys:

- "topic_label": a short (3-7 word) noun phrase describing what this segment is about, written like a section title (e.g. "Customer journey analytics workflows"), not a summary of the first sentence.
- "summary": one sentence (max ~30 words) summarizing the segment's content.
- "top_entities": a list of up to 8 objects {"text": <entity text>, "type": <one of PRODUCT, CONCEPT, TASK, PERSON, ORG, GPE, EVENT, WORK_OF_ART, LAW, OTHER>}, the most important entities/concepts/tasks mentioned.
- "keyphrases": a list of up to 6 short (1-4 word) keyphrases capturing the segment's key topics, distinct from top_entities where possible.
- "relations": a list of up to 8 objects {"subject": <entity text>, "predicate": <short verb phrase, e.g. "acquired", "pollinates", "relies on">, "object": <entity text>} stating factual relationships explicitly asserted in the text. Both subject and object must each match (or closely paraphrase) one of the entries in top_entities - do not invent relations the text doesn't support, and do not relate an entity to itself.

Respond with only the JSON object, no other text."""


class LLMCallError(Exception):
    pass


class LLMClient:
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

    def enrich_segment(self, text, section_title=None, subsection_title=None):
        if not self.is_configured():
            raise LLMCallError('LLM client is not configured (missing API key or openai package)')

        user_content = text
        heading = ' > '.join(h for h in (section_title, subsection_title) if h)
        if heading:
            user_content = f'Section: {heading}\n\n{text}'

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
                return {
                    'topic_label': str(parsed.get('topic_label', '')).strip(),
                    'summary': str(parsed.get('summary', '')).strip(),
                    'top_entities': parsed.get('top_entities', []) or [],
                    'keyphrases': parsed.get('keyphrases', []) or [],
                    'relations': parsed.get('relations', []) or [],
                }
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise LLMCallError(f'LLM enrichment failed after retry: {last_error}')
