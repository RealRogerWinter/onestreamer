#!/usr/bin/env python3
"""
Kick API Helper - Uses curl_cffi to bypass Kick's bot protection
Called from Node.js KickRandomService
"""

import sys
import json
from curl_cffi import requests


# Kick's /stream/livestreams response returns broadcaster language as a
# lowercase English NAME (e.g. "english", "spanish", "turkish"), NOT an
# ISO-639-1 code. The WhitelistService gate compares against ISO codes
# (matching Twitch's /helix/streams payload), so we normalize at the helper
# boundary. Mapping covers the languages Kick's broadcaster picker offers;
# extend as new ones appear in production. Verified against live response
# 2026-05-27: top-30 streams used english, spanish, turkish, arabic, polish,
# portuguese, russian. Empirically only ~37% of /livestreams/en results were
# actually english — the URL filter is a hint, not a hard constraint, so the
# post-filter via WhitelistService is the load-bearing check.
LANGUAGE_NAME_TO_ISO = {
    'english': 'en',
    'spanish': 'es',
    'portuguese': 'pt',
    'french': 'fr',
    'german': 'de',
    'italian': 'it',
    'russian': 'ru',
    'japanese': 'ja',
    'korean': 'ko',
    'chinese': 'zh',
    'mandarin': 'zh',
    'arabic': 'ar',
    'turkish': 'tr',
    'dutch': 'nl',
    'polish': 'pl',
    'swedish': 'sv',
    'norwegian': 'no',
    'danish': 'da',
    'finnish': 'fi',
    'czech': 'cs',
    'slovak': 'sk',
    'hungarian': 'hu',
    'romanian': 'ro',
    'bulgarian': 'bg',
    'croatian': 'hr',
    'serbian': 'sr',
    'ukrainian': 'uk',
    'greek': 'el',
    'thai': 'th',
    'vietnamese': 'vi',
    'indonesian': 'id',
    'hindi': 'hi',
    'bengali': 'bn',
    'urdu': 'ur',
    'persian': 'fa',
    'farsi': 'fa',
    'hebrew': 'he',
    'tagalog': 'tl',
    'filipino': 'tl',
    'malay': 'ms',
    'catalan': 'ca',
    'afrikaans': 'af',
    'swahili': 'sw',
}


def _normalize_language(value):
    """Coerce a Kick language string to ISO-639-1 (lowercase 2-letter).

    Accepts: a 2-letter ISO code (passed through, lowercased), a full
    lowercase English language name from LANGUAGE_NAME_TO_ISO, or anything
    else (returns None — caller treats as "unknown" rather than guessing).
    Future-proof against Kick switching to ISO codes mid-flight.
    """
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if not v:
        return None
    if len(v) == 2 and v.isalpha():
        return v
    return LANGUAGE_NAME_TO_ISO.get(v)


def _extract_language(stream, requested_language):
    """Best-effort language extraction for a Kick stream object.

    Probes the carriers we've seen in the wild — top-level ``language`` /
    ``broadcaster_language``, plus nested under ``channel`` / ``livestream``
    / ``user`` — and normalizes each candidate to ISO-639-1.

    Two distinct "no signal" cases:
      1. A field IS present but doesn't normalize (e.g. an unmapped language
         name): return None so the whitelist gate treats it as truly unknown.
      2. NO field is present anywhere: fall back to the URL-path language
         we already filtered on server-side. This handles future shape
         changes where Kick might drop the field; the URL still constrains
         the result set even if loosely.
    """
    saw_any = False
    if isinstance(stream, dict):
        for key in ('language', 'broadcaster_language'):
            v = stream.get(key)
            if isinstance(v, str) and v.strip():
                saw_any = True
                normalized = _normalize_language(v)
                if normalized:
                    return normalized
        for nest_key in ('channel', 'livestream', 'user'):
            nested = stream.get(nest_key)
            if isinstance(nested, dict):
                for key in ('language', 'broadcaster_language'):
                    v = nested.get(key)
                    if isinstance(v, str) and v.strip():
                        saw_any = True
                        normalized = _normalize_language(v)
                        if normalized:
                            return normalized
    if saw_any:
        return None
    return _normalize_language(requested_language)


def get_live_streams(page=1, limit=50, language='en'):
    """Get live streams from Kick.

    Without ``sort=desc`` this endpoint returns every entry with
    ``viewer_count: 0`` (server-side counts are only populated when a
    sort order is requested). With ``sort=desc`` the response is ordered
    by viewer count descending, so page N covers a contiguous band
    (e.g. page 1: 6k–46k viewers, page 20: ~330–400).

    Each returned stream is normalized to carry a top-level ``language``
    field (lowercase ISO-639-1, or ``None`` when no signal was available).
    The URL-path filter is the primary language signal; the explicit
    field handles edge cases where Kick mislabels its own URL filter.
    """
    try:
        response = requests.get(
            f'https://kick.com/stream/livestreams/{language}?page={page}&limit={limit}&sort=desc',
            impersonate='chrome',
            timeout=15
        )

        if response.status_code == 200:
            data = response.json()
            streams = None
            current_page = 1
            if isinstance(data, dict) and 'data' in data:
                streams = data['data']
                current_page = data.get('current_page', 1)
            elif isinstance(data, list):
                streams = data

            if streams is not None:
                for s in streams:
                    if isinstance(s, dict):
                        s['language'] = _extract_language(s, language)
                return {'success': True, 'streams': streams, 'currentPage': current_page}

        return {'success': False, 'error': f'API returned status {response.status_code}'}

    except json.JSONDecodeError as e:
        return {'success': False, 'error': f'JSON decode error: {str(e)}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def get_channel_info(username):
    """Get channel info for a specific user (includes authenticated playback URL)"""
    try:
        response = requests.get(
            f'https://kick.com/api/v2/channels/{username}',
            impersonate='chrome',
            timeout=15
        )

        if response.status_code == 200:
            data = response.json()
            return {'success': True, 'channel': data}

        return {'success': False, 'error': f'API returned status {response.status_code}'}

    except json.JSONDecodeError as e:
        return {'success': False, 'error': f'JSON decode error: {str(e)}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def get_playback_url(username):
    """Get authenticated playback URL for a channel (with JWT token)"""
    try:
        response = requests.get(
            f'https://kick.com/api/v2/channels/{username}',
            impersonate='chrome',
            timeout=15
        )

        if response.status_code == 200:
            data = response.json()
            playback_url = data.get('playback_url')
            is_live = data.get('livestream') is not None

            if not is_live:
                return {'success': False, 'error': 'Channel is not currently live'}

            if playback_url:
                # Get livestream info
                livestream = data.get('livestream', {})
                return {
                    'success': True,
                    'playback_url': playback_url,
                    'is_live': is_live,
                    'viewer_count': livestream.get('viewer_count', 0),
                    'session_title': livestream.get('session_title', ''),
                    'slug': data.get('slug'),
                    'username': data.get('user', {}).get('username', username)
                }
            else:
                return {'success': False, 'error': 'No playback URL available'}

        return {'success': False, 'error': f'API returned status {response.status_code}'}

    except json.JSONDecodeError as e:
        return {'success': False, 'error': f'JSON decode error: {str(e)}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def get_subcategory_info(slug):
    """Get subcategory info"""
    try:
        response = requests.get(
            f'https://kick.com/api/v1/subcategories/{slug}',
            impersonate='chrome',
            timeout=15
        )

        if response.status_code == 200:
            return {'success': True, 'category': response.json()}

        return {'success': False, 'error': f'API returned status {response.status_code}'}

    except Exception as e:
        return {'success': False, 'error': str(e)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'No command specified'}))
        sys.exit(1)

    command = sys.argv[1]

    if command == 'live-streams':
        page = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        language = sys.argv[4] if len(sys.argv) > 4 else 'en'
        result = get_live_streams(page, limit, language)

    elif command == 'channel':
        if len(sys.argv) < 3:
            result = {'success': False, 'error': 'Username required'}
        else:
            result = get_channel_info(sys.argv[2])

    elif command == 'playback-url':
        if len(sys.argv) < 3:
            result = {'success': False, 'error': 'Username required'}
        else:
            result = get_playback_url(sys.argv[2])

    elif command == 'subcategory':
        if len(sys.argv) < 3:
            result = {'success': False, 'error': 'Slug required'}
        else:
            result = get_subcategory_info(sys.argv[2])

    else:
        result = {'success': False, 'error': f'Unknown command: {command}'}

    print(json.dumps(result))

if __name__ == '__main__':
    main()
