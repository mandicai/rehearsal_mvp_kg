"""Assigns transcript text to the slide it was spoken over (see server.py's
/align route). Generalizes rehearsal_mvp's StepProcessing.vue align(): sort
slide-activation timestamps into [start, end) windows, then assign each
timed transcript word to the last window whose start <= word.start, using
Whisper's word-level timestamps (the fresh-recording path is the only
transcript source presenter-view.html offers).

A fallback path (no per-word timestamps at all, just the plain transcript
text) splits the text proportionally by token count weighted by each
window's share of total duration, same as the reference implementation -
kept as a safety net in case a transcription response ever lacks word
timestamps, not because any UI path currently omits them.
"""
import re

_SENTENCE_END_RE = re.compile(r'[.!?]$')


class AlignError(Exception):
    pass


def seconds_to_timestamp(seconds):
    """Matches slides.json's existing "HH:MM:SS.mmm" string format."""
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f'{hours:02d}:{minutes:02d}:{secs:06.3f}'


def normalize_words(words):
    """Whisper word objects ({word, start, end}) -> the shared {start, end, text} unit shape."""
    return [{'start': w['start'], 'end': w['end'], 'text': w['word']} for w in words]


def _build_windows(slide_activations, total_duration_seconds):
    acts = sorted(slide_activations, key=lambda a: a['start_seconds'])
    windows = []
    for i, act in enumerate(acts):
        start = act['start_seconds']
        end = acts[i + 1]['start_seconds'] if i + 1 < len(acts) else total_duration_seconds
        windows.append({'slide_index': act['slide_index'], 'start_seconds': start, 'end_seconds': end})
    return windows


def _window_for_time(windows, t):
    candidates = [w for w in windows if w['start_seconds'] <= t]
    return candidates[-1] if candidates else windows[0]


def _build_word_segments(items):
    """Groups word-level items into sentence-level segments (split on a
    trailing .!? on each word), matching slides.json's existing per-slide
    transcript_segments shape."""
    if not items:
        return '', []

    segments = []
    current = []
    for item in items:
        current.append(item)
        if _SENTENCE_END_RE.search(item['text'].strip()) or item is items[-1]:
            segments.append({
                'start_time': seconds_to_timestamp(current[0]['start']),
                'end_time': seconds_to_timestamp(current[-1]['end']),
                'text': ' '.join(i['text'].strip() for i in current),
            })
            current = []

    transcript = ' '.join(seg['text'] for seg in segments)
    return transcript, segments


def _build_fallback_chunk_segments(items):
    """Fallback-only: each proportional text chunk is already its own segment."""
    if not items:
        return '', []

    segments = [
        {
            'start_time': seconds_to_timestamp(item['start']),
            'end_time': seconds_to_timestamp(item['end']),
            'text': item['text'].strip(),
        }
        for item in items
    ]
    transcript = ' '.join(seg['text'] for seg in segments)
    return transcript, segments


def align_transcript(slide_activations, total_duration_seconds, words=None, full_text_fallback=None):
    """Returns a list of {slide_index, start_seconds, end_seconds, start_time,
    end_time, transcript, transcript_segments}, one per distinct slide_index
    referenced in slide_activations (merged across every activation window
    for slides the presenter revisited, using the min/max span of those
    windows as that slide's overall start/end)."""
    if not slide_activations:
        raise AlignError('slide_activations is required and must be non-empty')
    if not total_duration_seconds or total_duration_seconds <= 0:
        raise AlignError('total_duration_seconds must be a positive number')

    windows = _build_windows(slide_activations, total_duration_seconds)
    by_slide = {}

    def bucket(slide_index):
        return by_slide.setdefault(slide_index, {'spans': [], 'items': []})

    if words:
        for word in sorted(normalize_words(words), key=lambda u: u['start']):
            window = _window_for_time(windows, word['start'])
            bucket(window['slide_index'])['items'].append(word)
    elif full_text_fallback:
        tokens = full_text_fallback.split()
        total_window_duration = sum(w['end_seconds'] - w['start_seconds'] for w in windows) or 1.0
        cursor = 0
        for w in windows:
            share = (w['end_seconds'] - w['start_seconds']) / total_window_duration
            count = round(share * len(tokens))
            chunk = tokens[cursor:cursor + count]
            cursor += count
            if chunk:
                bucket(w['slide_index'])['items'].append({
                    'start': w['start_seconds'], 'end': w['end_seconds'], 'text': ' '.join(chunk),
                })
    # else: no transcript source at all - every slide below just gets an empty transcript

    for w in windows:
        bucket(w['slide_index'])['spans'].append((w['start_seconds'], w['end_seconds']))

    slides_out = []
    for slide_index, data in sorted(by_slide.items()):
        start_seconds = min(s for s, _ in data['spans'])
        end_seconds = max(e for _, e in data['spans'])

        if words:
            transcript, segments = _build_word_segments(data['items'])
        else:
            transcript, segments = _build_fallback_chunk_segments(data['items'])

        slides_out.append({
            'slide_index': slide_index,
            'start_seconds': start_seconds,
            'end_seconds': end_seconds,
            'start_time': seconds_to_timestamp(start_seconds),
            'end_time': seconds_to_timestamp(end_seconds),
            'transcript': transcript,
            'transcript_segments': segments,
        })

    return slides_out
