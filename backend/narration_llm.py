"""Short documentary-narration suggestions for an arranged paper section.

The suggestion is a writing aid only: the presenter still records the actual
voice track in the browser.  The prompt is grounded in the section text and
the narrative-act guidance so a suggestion helps the scene do its job in the
larger arc instead of merely summarising the paper.
"""
import json
import os

import httpx

try:
    from openai import OpenAI
except ImportError:  # openai is optional when the local app runs without an LLM
    OpenAI = None


_SYSTEM_PROMPT = """You are a documentary writer helping a filmmaker draft the voice-over for one scene.
Write natural spoken narration, grounded only in the supplied paper section. Use the narrative act as the
scene's dramatic job: do not repeat the act label mechanically. Make it concrete, clear, and easy to read
aloud, in the flowing style of a Vox-type explainer — lead the viewer through the idea rather than
summarising it.

Write a FULL passage organized into 3-5 short beats, each beat 2-4 sentences that belong together as one
filmable moment (a claim and its consequence, a setup and its payoff, one step of a process). Separate
beats with a blank line. Aim for enough narration that the scene has room to breathe and show several
distinct images — do not compress the whole scene into one or two sentences.

Explain the research in plain language while preserving uncertainty where the paper is uncertain. Do not
invent facts, names, numbers, quotations, or conclusions that are not in the supplied material. Do not
include camera directions, stage directions, headings, quotation marks, or meta-commentary. Return only
JSON in this exact shape (beats separated by a literal blank line inside the string):
{"narration": "First beat, 2-4 sentences.\\n\\nSecond beat, 2-4 sentences.\\n\\nThird beat..."}

The supplied section text may begin with a block labeled "Current narration and edited phrases".
Treat that block as the presenter's active revision request: incorporate the edited phrases and the
current draft/transcript rather than reverting to an earlier wording found later in the paper context.
Use the paper context to fact-check and ground the result, but do not ignore an explicitly edited phrase.
"""


class NarrationLLMCallError(Exception):
    pass


class NarrationLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('PROXY_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('PROXY_BASE_URL') or os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(30.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def suggest(self, section_title='', section_text='', act_title='', act_description='', abstract='', mode='', max_sentences=None):
        if not self.is_configured():
            raise NarrationLLMCallError('Narration LLM is not configured (missing API key or openai package)')

        parts = []
        if section_title.strip():
            parts.append(f'Scene title: {section_title.strip()}')
        if act_title.strip() or act_description.strip():
            act = act_title.strip() or 'Unnamed act'
            if act_description.strip():
                act += f' — {act_description.strip()}'
            parts.append(f'Narrative act and its job: {act}')
        if mode.strip():
            parts.append(f'Documentary mode (tone guidance only): {mode.strip()}')
        if section_text.strip():
            parts.append(f'Attached paper section:\n{section_text.strip()}')
        if abstract.strip():
            parts.append(f'Paper abstract (broader context):\n{abstract.strip()}')
        user_content = '\n\n'.join(parts) or 'No paper text was supplied; write a cautious, generic transition for this act.'

        system_prompt = _SYSTEM_PROMPT
        if max_sentences:
            # Arc previews are intentionally compact; the regular narration-node
            # flow keeps the default 2-4 sentence guidance above.
            system_prompt = system_prompt.replace(
                '2-4 sentences of spoken narration',
                f'1-{int(max_sentences)} sentences of spoken narration',
            )

        last_error = None
        for _ in range(2):
            try:
                response = self._get_client().chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.45,
                )
                parsed = json.loads(response.choices[0].message.content)
                narration = parsed.get('narration') if isinstance(parsed, dict) else None
                if not isinstance(narration, str) or not narration.strip():
                    raise ValueError(f'response did not contain narration: {parsed!r}')
                return narration.strip()
            except Exception as exc:
                last_error = exc
        raise NarrationLLMCallError(f'Narration suggestion failed after retry: {last_error}')
