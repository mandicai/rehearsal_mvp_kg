"""Server-side OpenAI Whisper transcription (see server.py's /transcribe route).

The browser still uploads audio only to this backend, so the OpenAI key never
reaches the client. Unlike the proxy-backed writing/media LLMs, transcription
uses the direct OpenAI key and endpoint so Whisper's verbose JSON timestamps
remain available.

Environment variables:
    OPENAI_API_KEY       direct OpenAI key used only for transcription
    OPENAI_TRANSCRIBE_MODEL  optional model override (defaults to whisper-1)
"""
import os
import io
from pathlib import Path

import httpx

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

class TranscriptionCallError(Exception):
    pass


class TranscriptionClient:
    def __init__(self, model='whisper-1'):
        self.api_key = os.environ.get('OPENAI_API_KEY')
        self.model = os.environ.get('OPENAI_TRANSCRIBE_MODEL') or model
        self.base_url = os.environ.get('OPENAI_TRANSCRIBE_BASE_URL') or None
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            # Same convention as every other LLM client in this codebase
            # (e.g. narrative_arc_llm.py) - was missing here entirely,
            # which meant a slow/unresponsive proxy hung for the SDK's own
            # default (up to 600s) instead of failing fast with a clear
            # error. max_retries=0 so the SDK's own retries don't compound
            # with a caller-level retry into a much longer wait than either
            # alone.
            kwargs = {
                'api_key': self.api_key,
                'timeout': httpx.Timeout(60.0, connect=5.0),
                'max_retries': 0,
            }
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def transcribe(self, audio_bytes, filename):
        """Return text plus Whisper word/segment timing metadata."""
        if not self.is_configured():
            raise TranscriptionCallError('Transcription client is not configured (missing API key or openai package)')

        audio_name = Path(filename or 'recording.webm').name
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = audio_name

        try:
            client = self._get_client()
            response = client.audio.transcriptions.create(
                file=audio_file,
                model=self.model,
                response_format='verbose_json',
                timestamp_granularities=['word', 'segment'],
            )
        except Exception as exc:  # network errors, API errors
            raise TranscriptionCallError(f'Transcription request failed: {exc}')

        def field(value, name, default=None):
            if isinstance(value, dict):
                return value.get(name, default)
            return getattr(value, name, default)

        raw_words = field(response, 'words', []) or []
        words = []
        for item in raw_words:
            word = field(item, 'word', field(item, 'text', ''))
            start = field(item, 'start')
            end = field(item, 'end')
            if word is None or start is None or end is None:
                continue
            words.append({'word': str(word), 'start': float(start), 'end': float(end)})

        raw_segments = field(response, 'segments', []) or []
        segments = []
        for item in raw_segments:
            text = field(item, 'text', '')
            start = field(item, 'start')
            end = field(item, 'end')
            if start is None or end is None:
                continue
            segments.append({'text': str(text or ''), 'start': float(start), 'end': float(end)})

        duration = field(response, 'duration')
        return {
            'text': str(field(response, 'text', '') or '').strip(),
            'words': words,
            'segments': segments,
            'duration': float(duration) if duration is not None else None,
        }
