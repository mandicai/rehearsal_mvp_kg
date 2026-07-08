"""Stage 1: split input text into overlapping, word-budgeted chunks small
enough to stay well under a later LLM call's context window, each carrying a
rolling extractive summary of everything before it as a cheap, local signal
of global context (real chunks aren't shown the whole document, so this is
the only thread connecting a chunk back to what came earlier).

Deliberately local/deterministic, no LLM call here - chunk boundaries and the
running summary need to exist before any LLM-based stage (entities.py,
stage 2) can run over them, and a mechanical splitting concern doesn't need
real language understanding the way entity extraction does.
"""
import re
from collections import Counter
from dataclasses import dataclass

from .config import CartaConfig

_WORD_RE = re.compile(r"[A-Za-z0-9']+")


@dataclass
class Chunk:
    chunk_index: int
    text: str
    char_start: int
    char_end: int
    context_summary: str  # rolling summary of every chunk before this one; '' for the first chunk


def _split_sentences(text, nlp):
    """Sentence spans with char offsets into `text` (the whole document)."""
    doc = nlp(text)
    sentences = []
    for sent in doc.sents:
        stripped = sent.text.strip()
        if not stripped:
            continue
        # keep offsets to the stripped text, not the raw (possibly whitespace-padded) span
        offset = sent.text.index(stripped)
        sentences.append((stripped, sent.start_char + offset, sent.start_char + offset + len(stripped)))
    return sentences


def _tokenize(text):
    return [w.lower() for w in _WORD_RE.findall(text)]


def _select_representative_sentences(sentences, top_n):
    """Pick the sentences whose words best match the chunk's overall word-
    frequency distribution - a simple, fully local proxy for "most
    representative of this chunk", not a learned summarizer."""
    if len(sentences) <= top_n:
        return list(sentences)

    freq = Counter()
    for s in sentences:
        freq.update(_tokenize(s))

    def score(sentence):
        words = _tokenize(sentence)
        return sum(freq[w] for w in words) / (len(words) or 1)

    top_texts = {s for s in sorted(sentences, key=score, reverse=True)[:top_n]}
    return [s for s in sentences if s in top_texts]  # preserve original order


def chunk_text(text: str, nlp, config: CartaConfig) -> list:
    sentences = _split_sentences(text, nlp)
    if not sentences:
        return []

    n = len(sentences)
    chunks = []
    rolling_summary_sentences = []  # oldest first
    rolling_summary_word_count = 0
    chunk_index = 0
    i = 0

    while i < n:
        current = []
        word_count = 0
        j = i
        while j < n and (not current or word_count < config.chunk_target_words):
            sent_text = sentences[j][0]
            current.append(sentences[j])
            word_count += len(sent_text.split())
            j += 1

        char_start = current[0][1]
        char_end = current[-1][2]

        chunks.append(Chunk(
            chunk_index=chunk_index,
            text=text[char_start:char_end],
            char_start=char_start,
            char_end=char_end,
            context_summary=' '.join(rolling_summary_sentences).strip(),
        ))
        chunk_index += 1

        if j >= n:
            break

        # fold this chunk's representative sentences into the rolling summary,
        # trimming the oldest ones first if it grows past the word budget
        picked = _select_representative_sentences([s[0] for s in current], config.context_sentences_per_chunk)
        rolling_summary_sentences.extend(picked)
        rolling_summary_word_count += sum(len(p.split()) for p in picked)
        while rolling_summary_word_count > config.max_context_summary_words and len(rolling_summary_sentences) > 1:
            removed = rolling_summary_sentences.pop(0)
            rolling_summary_word_count -= len(removed.split())

        # slide the window back by ~chunk_overlap_words worth of trailing sentences,
        # but always advance by at least one sentence so the loop terminates
        overlap_word_count = 0
        k = j - 1
        while k > i and overlap_word_count < config.chunk_overlap_words:
            overlap_word_count += len(sentences[k][0].split())
            k -= 1
        i = max(k + 1, i + 1)

    return chunks
