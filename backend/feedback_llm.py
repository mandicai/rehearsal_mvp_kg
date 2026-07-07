"""LLM-based presentation feedback: role-plays as a chosen audience persona
reacting to a full presentation (slide images + per-slide transcript), sent
to the same OpenAI-compatible chat endpoint as segmentation/llm.py.

Reuses the same env vars:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         must be a vision-capable model (default gpt-4o-mini
                      accepts image inputs)

Unlike segmentation labeling, there is no local fallback for this feature -
it raises LLMCallError if unconfigured, since there's no non-LLM way to
simulate an audience's reaction.
"""
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_SYSTEM_PROMPT_TEMPLATE = """You are role-playing as a member of this audience: {audience}.

You are about to watch a presentation, shown to you as its slide images in order, each paired with a transcript of what the presenter said while that slide was on screen. After the last slide, give candid, first-person feedback on the presentation as that audience member would: what worked, what was confusing or pitched at the wrong level, what you wanted more or less of, and any questions you were left with. Stay in character throughout - match the vocabulary, priorities, and tone that audience would actually have. Reference specific slides or moments where useful. Do not break character or mention that you are an AI.{extra_instructions}"""


class LLMCallError(Exception):
    pass


class FeedbackLLMClient:
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

    def get_feedback(self, audience, extra_prompt, slides):
        if not self.is_configured():
            raise LLMCallError('LLM client is not configured (missing API key or openai package)')

        extra_instructions = (
            f'\n\nThe presenter specifically wants feedback on: {extra_prompt}' if extra_prompt else ''
        )
        system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(audience=audience, extra_instructions=extra_instructions)

        content = []
        for slide in slides:
            label = f"Slide {slide.get('slide_index')} ({slide.get('start_time')} - {slide.get('end_time')})"
            transcript = slide.get('transcript') or '(no speech on this slide)'
            content.append({'type': 'text', 'text': f'{label}\nTranscript: {transcript}'})
            image = slide.get('image')
            if image:
                content.append({'type': 'image_url', 'image_url': {'url': image}})

        content.append({
            'type': 'text',
            'text': 'That was the entire presentation. Please give your feedback now, in character.'
        })

        try:
            client = self._get_client()
            response = client.chat.completions.create(
                model=self.model,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': content},
                ],
                temperature=0.6,
            )
            return response.choices[0].message.content.strip()
        except Exception as exc:  # network errors, API errors
            raise LLMCallError(f'LLM feedback request failed: {exc}')
