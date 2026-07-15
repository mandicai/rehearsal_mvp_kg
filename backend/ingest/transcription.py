"""Server-side audio transcription (see server.py's /transcribe route).
Proxied through the backend, unlike rehearsal_mvp's direct-from-browser
call, so the API key never reaches the client - same philosophy as
feedback_llm.py's FeedbackLLMClient.

This does NOT use OpenAI's dedicated /audio/transcriptions (Whisper)
endpoint - the configured proxy has no Whisper access for this key (a real
whisper-1 call returns 403 "user not allowed to access model", and the
"general" name mentioned in that error message is itself not a valid model
there either). Confirmed empirically that the proxy's gemini-2.5-flash DOES
accept real recorded audio (including the webm/opus format the browser's
MediaRecorder produces here) via a multimodal chat-completions call with an
input_audio content block, so that's what this sends instead.

Trade-off: unlike Whisper's verbose_json/timestamp_granularities, a chat
completion has no native per-word timestamps, so `words` is always empty
here - callers should send the fallback `text` field to /align instead of
`words`, which triggers align.py's proportional token-split path (coarser
than word-accurate alignment, but the only option this proxy supports).

Same env vars as feedback_llm.py/segmentation/llm.py:
    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL
"""
import base64
import os
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_TRANSCRIBE_PROMPT = (
    "Transcribe this audio exactly, word for word. Respond with only the "
    "raw transcript text - no preamble, no commentary, no formatting."
)


class TranscriptionCallError(Exception):
    pass


class TranscriptionClient:
    def __init__(self, model='gemini-2.5-flash'):
        self.api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('OPENAI_BASE_URL') or None
        self.model = model
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

    def transcribe(self, audio_bytes, filename):
        """Returns {text, words: [], duration: None} - words/duration are
        always empty; see module docstring for why."""
        if not self.is_configured():
            raise TranscriptionCallError('Transcription client is not configured (missing API key or openai package)')

        audio_format = Path(filename).suffix.lstrip('.').lower() or 'webm'
        audio_b64 = base64.b64encode(audio_bytes).decode('ascii')

        try:
            client = self._get_client()
            response = client.chat.completions.create(
                model=self.model,
                messages=[{
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': _TRANSCRIBE_PROMPT},
                        {'type': 'input_audio', 'input_audio': {'data': audio_b64, 'format': audio_format}},
                    ],
                }],
            )
            text = response.choices[0].message.content.strip()
        except Exception as exc:  # network errors, API errors
            raise TranscriptionCallError(f'Transcription request failed: {exc}')

        return {'text': text, 'words': [], 'duration': None}
