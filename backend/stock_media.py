"""Stock video/audio search for html/index.html's paper-extraction tool (see
server.py's /media/search_video and /media/search_audio routes) - triggered
by that page's per-section "Find Footage" action, using the video_query/
audio_query fields storyboard_llm.py's generate_storyboard already produces.

Three video providers (Pexels, Internet Archive, Library of Congress) plus
one audio provider (Freesound), all single unretried GETs against a plain
REST search endpoint - there's nothing here that benefits from the
retry-on-transient-failure pattern the LLM clients use; a failed search
just fails. Every search_videos() implementation returns the same shape
([{'id', 'thumbnail_url', 'video_url', 'duration', 'creator',
'source_url'}, ...]) regardless of provider, so callers (see server.py)
don't need to special-case any of them.

Internet Archive and Library of Congress need no API key at all (verified
live - see the research this was built from) and are B-roll-appropriate in
a different way than Pexels: real archival/historical footage, not modern
stock clips - both need a second request per candidate result to resolve
an actual playable file URL (Archive.org: a /metadata/<id> call for its
file list; LOC: a per-item ?fo=json call for its IIIF-AV resource list),
unlike Pexels' single search response which already embeds direct file
URLs - so these two are slower per search and cap how many candidates get
that follow-up resolution (see _MAX_METADATA_LOOKUPS below).

Env vars (see backend/.env.example):
    PEXELS_API_KEY      https://www.pexels.com/api/ (free)
    FREESOUND_API_KEY   https://freesound.org/apiv2/apply/ (free tier is
                         non-commercial use only)
    (Internet Archive and Library of Congress need no env var/key at all.)
"""
import os
import re

import requests

_PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/videos/search'
_FREESOUND_SEARCH_URL = 'https://freesound.org/apiv2/search/text/'
_ARCHIVE_SEARCH_URL = 'https://archive.org/advancedsearch.php'
_ARCHIVE_METADATA_URL = 'https://archive.org/metadata/{identifier}'
_LOC_SEARCH_URL = 'https://www.loc.gov/film-and-videos/'

# Both Internet Archive and Library of Congress only return item-level
# metadata from their own search endpoints - actually confirming a usable
# video file needs one more request per candidate (see each client's own
# comment). Capped independently of per_page (which bounds RESULTS, not
# lookups) so a run of candidates with no usable file doesn't turn one
# search into dozens of sequential requests.
_MAX_METADATA_LOOKUPS = 10


def _duration_seconds(value):
    """Normalize provider duration metadata to a numeric seconds value."""
    if value is None or value == '':
        return None
    if isinstance(value, (int, float)):
        return float(value) if float(value) > 0 else None
    text = str(value).strip()
    if not text:
        return None
    if ':' in text:
        try:
            parts = [float(part) for part in text.split(':')]
            seconds = 0.0
            for part in parts:
                seconds = seconds * 60 + part
            return seconds if seconds > 0 else None
        except (TypeError, ValueError):
            return None
    match = re.search(r'-?\d+(?:\.\d+)?', text)
    if not match:
        return None
    try:
        seconds = float(match.group(0))
    except ValueError:
        return None
    return seconds if seconds > 0 else None


class StockMediaCallError(Exception):
    pass


class PexelsClient:
    def __init__(self):
        self.api_key = os.environ.get('PEXELS_API_KEY')

    def is_configured(self):
        return bool(self.api_key)

    def search_videos(self, query, per_page=5):
        """Returns [{'id', 'thumbnail_url', 'video_url', 'duration',
        'creator', 'source_url'}, ...]."""
        if not self.is_configured():
            raise StockMediaCallError('Pexels client is not configured (missing PEXELS_API_KEY)')

        try:
            response = requests.get(
                _PEXELS_SEARCH_URL,
                headers={'Authorization': self.api_key},
                params={'query': query, 'per_page': per_page},
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            raise StockMediaCallError(f'Pexels video search failed: {exc}')
        except ValueError as exc:  # malformed JSON
            raise StockMediaCallError(f'Pexels video search returned invalid JSON: {exc}')

        results = []
        for video in data.get('videos', []):
            video_files = [f for f in (video.get('video_files') or []) if f.get('link')]
            if not video_files:
                continue
            # Smallest available file - these are just for inline preview.
            smallest = min(video_files, key=lambda f: (f.get('width') or 0) * (f.get('height') or 0) or float('inf'))
            pictures = video.get('video_pictures') or []

            results.append({
                'id': video.get('id'),
                'thumbnail_url': pictures[0]['picture'] if pictures else None,
                'video_url': smallest['link'],
                'duration': _duration_seconds(video.get('duration')),
                'creator': (video.get('user') or {}).get('name'),
                'source_url': video.get('url'),
            })
        return results


class InternetArchiveClient:
    """No API key, no signup - verified live (see the plan this was built
    from). archive.org's own advancedsearch endpoint only returns item
    identifiers/titles, not file lists, so each candidate needs a follow-up
    /metadata/<identifier> call to find an actual .mp4 to link to (some
    items have none - image scans, audio-only, etc. - those are skipped)."""

    def is_configured(self):
        return True

    def search_videos(self, query, per_page=5):
        """Returns [{'id', 'thumbnail_url', 'video_url', 'duration',
        'creator', 'source_url'}, ...]."""
        try:
            response = requests.get(
                _ARCHIVE_SEARCH_URL,
                params={
                    # Scoped to the Prelinger collection specifically - this
                    # is what the research this was built from actually
                    # pointed at (ephemeral educational/industrial/newsreel
                    # films). Unscoped mediatype:(movies) matches ALL of
                    # archive.org's video uploads (verified live: city
                    # council meetings, video game walkthroughs, NASA press
                    # conferences), which isn't what "B-roll from an
                    # archival source" means here.
                    'q': f'collection:(prelinger) AND mediatype:(movies) AND ({query})',
                    'fl[]': ['identifier', 'title'],
                    'rows': max(per_page, _MAX_METADATA_LOOKUPS),
                    'output': 'json',
                },
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            raise StockMediaCallError(f'Internet Archive search failed: {exc}')
        except ValueError as exc:
            raise StockMediaCallError(f'Internet Archive search returned invalid JSON: {exc}')

        docs = (data.get('response') or {}).get('docs', [])
        results = []
        for doc in docs[:_MAX_METADATA_LOOKUPS]:
            if len(results) >= per_page:
                break
            identifier = doc.get('identifier')
            if not identifier:
                continue
            try:
                meta_response = requests.get(_ARCHIVE_METADATA_URL.format(identifier=identifier), timeout=8)
                meta_response.raise_for_status()
                meta = meta_response.json()
            except (requests.RequestException, ValueError):
                continue  # this one item's lookup failed - still try the rest

            mp4_files = [f for f in (meta.get('files') or [])
                         if (f.get('name') or '').lower().endswith('.mp4')]
            if not mp4_files:
                continue
            selected_file = mp4_files[0]
            duration = _duration_seconds(
                selected_file.get('duration')
                or selected_file.get('length')
                or (meta.get('metadata') or {}).get('runtime')
            )

            results.append({
                'id': identifier,
                'thumbnail_url': f'https://archive.org/services/img/{identifier}',
                'video_url': f'https://archive.org/download/{identifier}/{selected_file["name"]}',
                'duration': duration,
                'creator': None,
                'source_url': f'https://archive.org/details/{identifier}',
            })
        return results


class LibraryOfCongressClient:
    """No API key, no signup - verified live (see the plan this was built
    from). The /film-and-videos/ search endpoint only returns item-level
    metadata, not a playable file - each candidate needs a follow-up
    ?fo=json request on the item's own URL to read its IIIF-AV resource
    list, which is where an actual .mp4 lives. That resource's own
    format.filename field (NOT its @id - verified live that the @id URL
    alone just redirects to a manifest, not raw video) is what resolves to
    a directly playable file under tile.loc.gov/storage-services."""

    def is_configured(self):
        return True

    def search_videos(self, query, per_page=5):
        """Returns [{'id', 'thumbnail_url', 'video_url', 'duration',
        'creator', 'source_url'}, ...]."""
        try:
            response = requests.get(
                _LOC_SEARCH_URL,
                params={'q': query, 'fo': 'json', 'c': max(per_page, _MAX_METADATA_LOOKUPS)},
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            raise StockMediaCallError(f'Library of Congress search failed: {exc}')
        except ValueError as exc:
            raise StockMediaCallError(f'Library of Congress search returned invalid JSON: {exc}')

        docs = (data.get('content') or {}).get('results', [])
        results = []
        for doc in docs[:_MAX_METADATA_LOOKUPS]:
            if len(results) >= per_page:
                break
            item_url = doc.get('id')  # a full item page URL, e.g. https://www.loc.gov/item/.../
            if not item_url:
                continue
            try:
                item_response = requests.get(item_url, params={'fo': 'json'}, timeout=8)
                item_response.raise_for_status()
                item_data = item_response.json()
            except (requests.RequestException, ValueError):
                continue  # this one item's lookup failed - still try the rest

            video_url = None
            duration = None
            for resource in item_data.get('resources') or []:
                for file_group in resource.get('files') or []:
                    for file_info in file_group:
                        filename = (file_info.get('format') or {}).get('filename')
                        if file_info.get('mimetype') == 'video/mp4' and filename:
                            video_url = f'https://tile.loc.gov/storage-services{filename}'
                            duration = _duration_seconds(resource.get('duration'))
                            break
                    if video_url:
                        break
                if video_url:
                    break
            if not video_url:
                continue

            thumbnails = doc.get('image_url') or []
            results.append({
                'id': item_url,
                'thumbnail_url': thumbnails[0] if thumbnails else None,
                'video_url': video_url,
                'duration': duration,
                'creator': None,
                'source_url': item_url,
            })
        return results


class FreesoundClient:
    def __init__(self):
        self.api_key = os.environ.get('FREESOUND_API_KEY')

    def is_configured(self):
        return bool(self.api_key)

    def search_sounds(self, query, page_size=5):
        """Returns [{'id', 'name', 'preview_url', 'duration', 'creator',
        'license', 'source_url'}, ...]."""
        if not self.is_configured():
            raise StockMediaCallError('Freesound client is not configured (missing FREESOUND_API_KEY)')

        try:
            response = requests.get(
                _FREESOUND_SEARCH_URL,
                params={
                    'query': query,
                    'page_size': page_size,
                    'token': self.api_key,
                    'fields': 'id,name,previews,duration,username,license,url',
                },
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            raise StockMediaCallError(f'Freesound search failed: {exc}')
        except ValueError as exc:
            raise StockMediaCallError(f'Freesound search returned invalid JSON: {exc}')

        results = []
        for sound in data.get('results', []):
            previews = sound.get('previews') or {}
            preview_url = previews.get('preview-hq-mp3') or previews.get('preview-lq-mp3')
            if not preview_url:
                continue

            results.append({
                'id': sound.get('id'),
                'name': sound.get('name'),
                'preview_url': preview_url,
                'duration': sound.get('duration'),
                'creator': sound.get('username'),
                'license': sound.get('license'),
                'source_url': sound.get('url'),
            })
        return results
