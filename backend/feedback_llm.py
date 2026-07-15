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
import time

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_SYSTEM_PROMPT_TEMPLATE = """You are role-playing as a member of this audience: {audience}.

You are about to watch a presentation, shown to you as its slide images in order, each paired with a transcript of what the presenter said while that slide was on screen. After the last slide, give candid, first-person feedback on the presentation as that audience member would: what worked, what was confusing or pitched at the wrong level, what you wanted more or less of, and any questions you were left with. Stay in character throughout - match the vocabulary, priorities, and tone that audience would actually have. Reference specific slides or moments where useful. Do not break character or mention that you are an AI.{extra_instructions}"""

# Used for the "progressive" mode (see get_progressive_reaction) - answers
# "how does feedback differ live, slide-by-slide, vs. retrospectively from
# the full transcript?" by making this persona react to each slide as it
# arrives, with no knowledge of what's still to come, rather than reviewing
# the whole deck in hindsight like _SYSTEM_PROMPT_TEMPLATE above does.
_PROGRESSIVE_SYSTEM_PROMPT_TEMPLATE = """You are role-playing as a member of this audience: {audience}.

You are watching this presentation LIVE, one slide at a time, in the exact order the presenter shows them. You do NOT know what slides or content come next, and you must never reference or anticipate anything beyond what you've seen so far - react only to what's in front of you right now, the way a real audience member watching live would. Each time a new slide is shown to you (as an image, paired with the transcript of what the presenter said while it was on screen), give a brief, in-the-moment reaction: your immediate thoughts or feelings right now, any confusion or questions at this point, and how it builds on or changes your impression from the slides before it. Keep each reaction short (2-4 sentences) - this is live running commentary, not a final review. Stay in character throughout - match the vocabulary, priorities, and tone that audience would actually have. Do not break character or mention that you are an AI.{extra_instructions}"""


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

    def get_progressive_reaction(self, audience, extra_prompt, messages, slide):
        """One step of "progressive" mode: react to a single new slide,
        continuing a real multi-turn conversation (`messages`) so the
        persona's own prior in-the-moment reactions stay in its context -
        this is what makes it a genuinely different condition from
        get_feedback above, not just the same call chopped into pieces.
        `messages` is [] on the first slide (the system prompt is built
        fresh); callers pass back the returned `messages` on every
        subsequent call. Returns (reaction_text, updated_messages)."""
        if not self.is_configured():
            raise LLMCallError('LLM client is not configured (missing API key or openai package)')

        if messages:
            full_messages = list(messages)
        else:
            extra_instructions = (
                f'\n\nThe presenter specifically wants feedback on: {extra_prompt}' if extra_prompt else ''
            )
            system_prompt = _PROGRESSIVE_SYSTEM_PROMPT_TEMPLATE.format(audience=audience, extra_instructions=extra_instructions)
            full_messages = [{'role': 'system', 'content': system_prompt}]

        label = f"Slide {slide.get('slide_index')} ({slide.get('start_time')} - {slide.get('end_time')})"
        transcript = slide.get('transcript') or '(no speech on this slide)'
        content = [{'type': 'text', 'text': f'{label}\nTranscript: {transcript}'}]
        image = slide.get('image')
        if image:
            content.append({'type': 'image_url', 'image_url': {'url': image}})
        content.append({'type': 'text', 'text': 'Give your in-the-moment reaction to this slide now, in character.'})

        full_messages.append({'role': 'user', 'content': content})

        # Progressive mode makes one call per slide in a tight sequential
        # loop, with each call's payload growing (every prior slide's image
        # stays in the conversation) - far more prone to transient rate
        # limits than get_feedback's single call, so a short retry with
        # backoff here (unlike get_feedback) meaningfully improves whether a
        # multi-slide run actually completes.
        last_error = None
        for attempt in range(3):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=full_messages,
                    temperature=0.6,
                )
                reaction = response.choices[0].message.content.strip()
                full_messages.append({'role': 'assistant', 'content': reaction})
                return reaction, full_messages
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(3 * (attempt + 1))  # 3s, then 6s
        raise LLMCallError(f'Progressive feedback request failed after retries: {last_error}')
