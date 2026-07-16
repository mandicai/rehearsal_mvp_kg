"""LLM-driven simulated-audience assessment (see server.py's /assessment/*
routes). presenter-view.html's Simulate Audience module calls these once per
learning objective to: write an open-ended comprehension question grounded in
that objective's own scope, have a persona representing the stated audience
answer it using only the transcript exposed up to that point (no lookahead),
grade the answer(s) against a rubric, and - only for objectives that end up
both weak and foundational - suggest a concrete fix. The resulting
correct/incorrect signal feeds a Bayesian-Knowledge-Tracing-style update done
client-side in js/simulate-audience.js; this module has no knowledge of BKT.

Same env vars as feedback_llm.py/objectives_llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
    LLM_MODEL         default 'gpt-4o-mini'

No local fallback - raises AssessmentLLMCallError if unconfigured.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_GENERATE_QUESTION_SYSTEM_PROMPT = """You are an instructional designer writing a comprehension check for a presentation. You will be given a specific learning objective, the scope it applies to (a single slide, a section of slides, or the entire presentation), and the transcript of what will be said in that scope.

First, decide: does the given transcript actually address this specific learning objective's topic? A transcript about a different topic entirely does NOT cover the objective, even if it is the only content you were given - do not let the transcript's topic distract you into writing a question about the transcript's subject instead of the stated objective's subject.

Then write exactly one open-ended, short-answer question that tests whether someone actually grasped this specific learning objective - the question must always be about the objective's own stated topic, never substituted with a different topic from the transcript. The question should require a real explanation, not a yes/no or one-word answer.

If the transcript does cover the objective's topic, ground the question, rubric, and reference answer in what the transcript specifically says. If it does NOT, write the question, rubric, and reference answer based on genuine subject-matter knowledge about the objective instead, exactly as you would if no transcript had been given at all - never write a rubric whose correct answer is simply that the presentation didn't cover this topic; always test real understanding of the stated objective's actual subject.

Also write a grading rubric (what a correct answer must include) and a reference answer.

Respond with a single JSON object with exactly four keys: "covers_objective" (boolean - your judgment from the first step), "question", "rubric", "reference_answer" (the last three each a plain string, "question" always about the stated objective's topic regardless of "covers_objective"). Respond with only the JSON object, no other text."""

_SIMULATE_ANSWER_SYSTEM_PROMPT_TEMPLATE = """You are role-playing as a member of this audience: {audience}.

You are watching a presentation live, one slide at a time, in order. Below is everything you have heard so far, in order - you do NOT know anything about what comes after this point, and must never reference or anticipate later content. Someone is now testing your understanding with a single question. Answer it in 1-4 sentences, honestly, the way this specific audience member would based only on what they've heard so far - if it wasn't covered clearly, or you're unsure, say so or give your best plausible guess rather than fabricating confidence. Stay in character and do not mention that you are an AI."""

_GRADE_ANSWERS_SYSTEM_PROMPT = """You are grading comprehension-check answers against a rubric and reference answer. You will be given the question, the rubric, the reference answer, and a numbered list of candidate answers from different respondents.

For each candidate answer, decide whether it correctly demonstrates the understanding the rubric calls for (minor phrasing differences are fine; missing or wrong substance is not) and give a one-sentence explanation of why.

Respond with a single JSON object with exactly one key, "grades": a JSON array with exactly one entry per candidate answer, in the same order, each an object with keys "correct" (boolean) and "explanation" (a short string). Respond with only the JSON object, no other text."""

_SUGGEST_FIX_SYSTEM_PROMPT = """You are an instructional designer helping a presenter improve their presentation. A learning objective at a given scope was tested on a simulated audience, and the audience largely failed to demonstrate understanding of it. This objective is also a prerequisite for other, downstream learning objectives.

You will be given the objective, its scope and transcript, the audience's actual wrong answers and why they were marked wrong, and the downstream objectives this one supports. Propose exactly one concrete, actionable revision to the presentation content for this scope (e.g. rephrase an explanation, add a concrete example, insert a recap, slow down, reorder material) that would plausibly fix the specific misunderstanding shown by the wrong answers - not generic advice.

Respond with a single JSON object with exactly one key, "suggestion" (a plain string, 2-4 sentences). Respond with only the JSON object, no other text."""


class AssessmentLLMCallError(Exception):
    pass


class AssessmentLLMClient:
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

    @staticmethod
    def _slide_content_blocks(slides):
        """Builds a multimodal content-blocks list (one text block per slide,
        plus an image_url block right after it when the slide carries an
        `image` data URI) - the transcript text is always present, the image
        is optional per slide, so callers control image inclusion simply by
        setting/omitting `image` on the slide dicts they pass in."""
        blocks = []
        for s in slides:
            transcript = s.get('transcript') or '(no speech on this slide)'
            blocks.append({'type': 'text', 'text': f"Slide {s.get('slide_index')}: {transcript}"})
            image = s.get('image')
            if image:
                blocks.append({'type': 'image_url', 'image_url': {'url': image}})
        return blocks

    def generate_question(self, objective_text, scope_label, slides):
        """slides: [{'slide_index', 'transcript', 'image'}, ...] for the
        objective's own scope only ('image' is an optional data URI).
        Returns {'question', 'rubric', 'reference_answer'}."""
        if not self.is_configured():
            raise AssessmentLLMCallError('LLM client is not configured (missing API key or openai package)')

        # The objective is restated again after the transcript (not just once
        # up front) - a recency-emphasis nudge, since a model given a long
        # transcript block can otherwise drift into writing a question about
        # the transcript's own topic instead of the stated objective,
        # especially when the two don't match (confirmed happening live,
        # intermittently, without this reminder).
        user_content = [
            {'type': 'text', 'text': f'Learning objective: {objective_text}\nScope: {scope_label}\n'},
            *self._slide_content_blocks(slides),
            {'type': 'text', 'text': (
                f'\nReminder: the learning objective you are writing a question about is: '
                f'"{objective_text}". The question must be about this exact topic.'
            )},
        ]

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _GENERATE_QUESTION_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.4,
                )
                parsed = json.loads(response.choices[0].message.content)
                question = str(parsed.get('question') or '').strip()
                rubric = str(parsed.get('rubric') or '').strip()
                reference_answer = str(parsed.get('reference_answer') or '').strip()
                if not question or not rubric:
                    raise ValueError('LLM response missing question/rubric')
                return {'question': question, 'rubric': rubric, 'reference_answer': reference_answer}
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise AssessmentLLMCallError(f'Question generation failed after retry: {last_error}')

    def simulate_answer(self, audience, question, cumulative_slides):
        """cumulative_slides: [{'slide_index', 'transcript', 'image'}, ...] -
        every slide up to and including the objective's opportunity point, in
        order. `image` is expected to be set on at most the last slide (the
        one currently "on screen") - the audience remembers everything said,
        but isn't still looking at an earlier slide's visual. Never receives
        the rubric/reference answer. Returns the persona's answer as a plain
        string."""
        if not self.is_configured():
            raise AssessmentLLMCallError('LLM client is not configured (missing API key or openai package)')

        system_prompt = _SIMULATE_ANSWER_SYSTEM_PROMPT_TEMPLATE.format(audience=audience)
        user_content = [
            {'type': 'text', 'text': 'What you have heard (and, for the most recent slide, seen) so far:'},
            *self._slide_content_blocks(cumulative_slides),
            {'type': 'text', 'text': f'\nQuestion: {question}'},
        ]

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_content},
                    ],
                    temperature=0.9,  # spreads the ~3 independent samples meaningfully
                )
                answer = response.choices[0].message.content.strip()
                if answer:
                    return answer
                raise ValueError('LLM returned an empty answer')
            except Exception as exc:
                last_error = exc
        raise AssessmentLLMCallError(f'Simulated answer failed after retry: {last_error}')

    def grade_answers(self, question, rubric, reference_answer, answers):
        """answers: list of answer strings. Returns a list of
        {'correct': bool, 'explanation': str}, same length/order as
        `answers` - all graded in one call so grading strictness is
        consistent across every sample of the same question."""
        if not self.is_configured():
            raise AssessmentLLMCallError('LLM client is not configured (missing API key or openai package)')

        numbered_answers = '\n'.join(f'Answer {i + 1}: {a}' for i, a in enumerate(answers))
        user_content = (
            f'Question: {question}\nRubric: {rubric}\nReference answer: {reference_answer}\n\n{numbered_answers}'
        )

        last_error = None
        for _ in range(2):  # one retry on transient failure or a misaligned grade count
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _GRADE_ANSWERS_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                grades = parsed.get('grades')
                if not isinstance(grades, list) or len(grades) != len(answers):
                    raise ValueError(f'Expected {len(answers)} grades, got {grades!r}')
                return [
                    {'correct': bool(g.get('correct')), 'explanation': str(g.get('explanation') or '').strip()}
                    for g in grades
                ]
            except Exception as exc:  # network errors, malformed JSON, misaligned grade count
                last_error = exc
        raise AssessmentLLMCallError(f'Grading failed after retry: {last_error}')

    def suggest_fix(self, objective_text, scope_label, slides, graded_samples, blocked_objective_texts):
        """graded_samples: [{'answer', 'correct', 'explanation'}, ...] from
        grade_answers, for the wrong-answer context. blocked_objective_texts:
        texts of objectives this one is a prerequisite for. Returns
        {'suggestion': str}. Only called for objectives already flagged weak
        and foundational, so call volume is bounded."""
        if not self.is_configured():
            raise AssessmentLLMCallError('LLM client is not configured (missing API key or openai package)')

        wrong_answers = '\n'.join(
            f"- \"{s.get('answer')}\" - marked incorrect: {s.get('explanation')}"
            for s in graded_samples if not s.get('correct')
        ) or '(the audience answered inconsistently rather than uniformly incorrectly)'
        blocked_text = ', '.join(blocked_objective_texts) or '(no specific downstream objectives recorded)'
        user_content = [
            {'type': 'text', 'text': f'Learning objective: {objective_text}\nScope: {scope_label}\n'},
            *self._slide_content_blocks(slides),
            {'type': 'text', 'text': (
                f'\nWrong answers from the simulated audience:\n{wrong_answers}\n\n'
                f'This objective is a prerequisite for: {blocked_text}'
            )},
        ]

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _SUGGEST_FIX_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.4,
                )
                parsed = json.loads(response.choices[0].message.content)
                suggestion = str(parsed.get('suggestion') or '').strip()
                if not suggestion:
                    raise ValueError('LLM response missing suggestion')
                return {'suggestion': suggestion}
            except Exception as exc:
                last_error = exc
        raise AssessmentLLMCallError(f'Fix suggestion failed after retry: {last_error}')
