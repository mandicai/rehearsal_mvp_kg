"""Stock video/audio search for html/index.html's paper-extraction tool (see
server.py's /media/search_video and /media/search_audio routes) - triggered
by that page's per-section "Find Footage" action, using the video_query/
audio_query fields storyboard_llm.py's generate_storyboard already produces.

Two providers, both single unretried GETs against a plain REST search
endpoint with a free API key (no OAuth flow, no chunking/pagination beyond
one page) - there's nothing here that benefits from the retry-on-transient-
failure pattern the LLM clients use; a failed search just fails.

Env vars (see backend/.env.example):
    PEXELS_API_KEY      https://www.pexels.com/api/ (free)
    FREESOUND_API_KEY   https://freesound.org/apiv2/apply/ (free tier is
                         non-commercial use only)
"""
import os

import requests

_PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/videos/search'
_FREESOUND_SEARCH_URL = 'https://freesound.org/apiv2/search/text/'


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
                'duration': video.get('duration'),
                'creator': (video.get('user') or {}).get('name'),
                'source_url': video.get('url'),
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
