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
import re
import subprocess
import tempfile
from pathlib import Path

import httpx

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

FFMPEG_BIN = os.environ.get('FFMPEG_BIN', 'ffmpeg')
# Kept in sync with js/paper-extract.js's ACT_BOARD_PAUSE_MIN_SECONDS - a
# presenter's own recorded pause of at least this long is treated as a
# deliberate beat marker for splitting narration into clauses.
_SILENCE_MIN_SECONDS = 1.0
_SILENCE_NOISE_FLOOR = '-30dB'
_SILENCE_DETECT_TIMEOUT = 30


class TranscriptionCallError(Exception):
    pass


def detect_silences(audio_bytes, filename=''):
    """Detects silence intervals directly from the recorded audio's waveform
    via ffmpeg's silencedetect filter - independent of Whisper's word-level
    timestamps, which are an approximate internal alignment, not true
    forced-alignment, and were confirmed (live, on a real recording with a
    genuine 1-2s pause) to sometimes report a flat 0.0s gap between every
    word despite the pause being clearly audible in the recording itself.
    Returns a list of {'start', 'end', 'duration'} (seconds), or [] if ffmpeg
    is unavailable or the audio has no silence at least _SILENCE_MIN_SECONDS
    long."""
    suffix = Path(filename or '').suffix or '.webm'
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
            tmp.write(audio_bytes)
            tmp.flush()
            cmd = [
                FFMPEG_BIN, '-i', tmp.name,
                '-af', f'silencedetect=noise={_SILENCE_NOISE_FLOOR}:d={_SILENCE_MIN_SECONDS}',
                '-f', 'null', '-',
            ]
            result = subprocess.run(
                cmd, capture_output=True, timeout=_SILENCE_DETECT_TIMEOUT, text=True)
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return []
    starts = [float(m) for m in re.findall(r'silence_start:\s*(-?\d+(?:\.\d+)?)', result.stderr)]
    ends = [float(m) for m in re.findall(r'silence_end:\s*(-?\d+(?:\.\d+)?)', result.stderr)]
    return [
        {'start': start, 'end': end, 'duration': round(end - start, 3)}
        for start, end in zip(starts, ends) if end > start
    ]


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
        raw_segments = field(response, 'segments', []) or []
        # A few Whisper-compatible gateways nest word timestamps inside each
        # segment instead of returning the top-level `words` array. Flatten
        # that shape too so the client can reconstruct spaces when an
        # aggregate `text` value has been concatenated.
        if not raw_words:
            raw_words = [word for segment in raw_segments
                         for word in (field(segment, 'words', []) or [])]
        words = []
        for item in raw_words:
            word = field(item, 'word', field(item, 'text', ''))
            start = field(item, 'start')
            end = field(item, 'end')
            if word is None or start is None or end is None:
                continue
            words.append({'word': str(word), 'start': float(start), 'end': float(end)})

        segments = []
        for item in raw_segments:
            text = field(item, 'text', '')
            start = field(item, 'start')
            end = field(item, 'end')
            if start is None or end is None:
                continue
            segments.append({'text': str(text or ''), 'start': float(start), 'end': float(end)})

        text = str(field(response, 'text', '') or '').strip()
        # Some compatible transcription gateways omit the aggregate text but
        # still return timestamped words/segments. Build a readable transcript
        # from those records instead of returning an empty string (or relying
        # on a client-side guess).
        if not text and words:
            text = ' '.join(item['word'].strip() for item in words if item['word'].strip())
        if not text and segments:
            text = ' '.join(item['text'].strip() for item in segments if item['text'].strip())
        # Whisper's verbose response normally includes spaces in ``text``.
        # If a provider/proxy returns concatenated text but valid word timing
        # records, rebuild only that malformed case from the timestamped
        # words. This keeps ordinary whitespace and line breaks untouched.
        if len(words) > 1 and len(re.findall(r'\s', text)) < len(words) - 1:
            text = ' '.join(item['word'] for item in words)

        duration = field(response, 'duration')
        return {
            'text': text,
            'words': words,
            'segments': segments,
            'silences': detect_silences(audio_bytes, filename),
            'duration': float(duration) if duration is not None else None,
        }
