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
import json
import os
import time

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_SYSTEM_PROMPT_TEMPLATE = """You are role-playing as a member of this audience: {audience}.

You are about to watch a presentation, shown to you as its slide images in order, each paired with a transcript of what the presenter said while that slide was on screen. After the last slide, give candid, first-person feedback on the presentation as that audience member would: what worked, what was confusing or pitched at the wrong level, what you wanted more or less of, and any questions you were left with. Stay in character throughout - match the vocabulary, priorities, and tone that audience would actually have. Reference specific slides or moments where useful. Do not break character or mention that you are an AI.{extra_instructions}"""

# Used for the "progressive" mode (see get_progressive_reaction) - this
# persona watches the deck live, one slide at a time, with no knowledge of
# what's still to come, rather than reviewing the whole deck in hindsight
# like _SYSTEM_PROMPT_TEMPLATE above does. Also used for the two synthetic
# checkpoint turn types a caller may interleave into the same conversation -
# a section recap (once a titled section's slides are done) and a final
# overall wrap-up (once the deck is done) - the *turn's own instructional
# text (built by the caller) says which of the three this is; the response
# shape is identical for all three so the backend never special-cases them.
_PROGRESSIVE_SYSTEM_PROMPT_TEMPLATE = """You are role-playing as a member of this audience: {audience}.

You are watching this presentation LIVE, one slide at a time, in the exact order the presenter shows them. You do NOT know what slides or content come next, and you must never reference or anticipate anything beyond what you've seen so far - react only to what's in front of you right now, the way a real audience member watching live would.{goal_instructions}

Each time you're given something new to react to (a slide, a section-recap checkpoint, or the presentation's end), respond with a JSON object with exactly two string fields:
- "flow_feedback": how well this point connects to and builds on what came immediately before - pacing, transitions, whether it flows naturally or feels abrupt or repetitive.
- "understanding_feedback": how this point is building (or failing to build) your understanding of whatever takeaway is relevant right now, given your stated goal - note specific confusion, gaps, or moments that clicked.

Keep each field short (1-3 sentences) - this is in-the-moment commentary, not a final review. Stay in character throughout - match the vocabulary, priorities, and tone that audience would actually have. Do not break character or mention that you are an AI, and respond with ONLY the JSON object, no other text.{extra_instructions}"""


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

    def get_progressive_reaction(self, audience, extra_prompt, messages, slide, goal=None):
        """One step of "progressive" mode: react to a single new turn,
        continuing a real multi-turn conversation (`messages`) so the
        persona's own prior in-the-moment reactions stay in its context -
        this is what makes it a genuinely different condition from
        get_feedback above, not just the same call chopped into pieces.
        `messages` is [] on the first turn (the system prompt is built
        fresh, folding in `goal` if given); callers pass back the returned
        `messages` on every subsequent call.

        `slide` is usually a real slide dict ({slide_index, start_time,
        end_time, transcript, image}), but callers may also pass a synthetic
        checkpoint turn (no `slide_index`/`image`, `transcript` holding the
        checkpoint's own instructional text, e.g. "you've just finished the
        section 'X' - reflect on...") to get a section-recap or final
        overall-feedback turn through this same method - see the module
        docstring on _PROGRESSIVE_SYSTEM_PROMPT_TEMPLATE.

        Returns (parsed_response_dict, updated_messages) where
        parsed_response_dict has "flow_feedback"/"understanding_feedback"
        string keys."""
        if not self.is_configured():
            raise LLMCallError('LLM client is not configured (missing API key or openai package)')

        if messages:
            full_messages = list(messages)
        else:
            extra_instructions = (
                f'\n\nThe presenter specifically wants feedback on: {extra_prompt}' if extra_prompt else ''
            )
            goal_instructions = (
                f"\n\nYour specific goal in attending this talk is: {goal}. Keep this goal in mind "
                'throughout - notice when the presentation helps or hinders you reaching it.'
                if goal else ''
            )
            system_prompt = _PROGRESSIVE_SYSTEM_PROMPT_TEMPLATE.format(
                audience=audience, goal_instructions=goal_instructions, extra_instructions=extra_instructions,
            )
            full_messages = [{'role': 'system', 'content': system_prompt}]

        if slide.get('slide_index') is not None:
            label = f"Slide {slide.get('slide_index')} ({slide.get('start_time')} - {slide.get('end_time')})"
        else:
            label = 'Checkpoint'
        transcript = slide.get('transcript') or '(no speech on this slide)'
        content = [{'type': 'text', 'text': f'{label}\nTranscript: {transcript}'}]
        image = slide.get('image')
        if image:
            content.append({'type': 'image_url', 'image_url': {'url': image}})
        content.append({
            'type': 'text',
            'text': 'Give your reaction now, in character, as a JSON object with exactly '
                    '"flow_feedback" and "understanding_feedback" string fields.',
        })

        full_messages.append({'role': 'user', 'content': content})

        # Progressive mode makes one call per turn in a tight sequential
        # loop, with each call's payload growing (every prior slide's image
        # stays in the conversation) - far more prone to transient rate
        # limits than get_feedback's single call, so a short retry with
        # backoff here (unlike get_feedback) meaningfully improves whether a
        # multi-slide run actually completes. The same retry also covers a
        # malformed (non-JSON, or missing-field) response.
        last_error = None
        for attempt in range(3):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=full_messages,
                    temperature=0.6,
                    response_format={'type': 'json_object'},
                )
                raw = response.choices[0].message.content.strip()
                parsed = json.loads(raw)
                if 'flow_feedback' not in parsed or 'understanding_feedback' not in parsed:
                    raise ValueError(f'response missing expected fields: {raw}')
                full_messages.append({'role': 'assistant', 'content': raw})
                return parsed, full_messages
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(3 * (attempt + 1))  # 3s, then 6s
        raise LLMCallError(f'Progressive feedback request failed after retries: {last_error}')
