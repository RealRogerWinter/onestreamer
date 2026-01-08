#!/usr/bin/env python3
"""
Kick API Helper - Uses curl_cffi to bypass Kick's bot protection
Called from Node.js KickRandomService
"""

import sys
import json
from curl_cffi import requests

def get_live_streams(page=1, limit=50, language='en'):
    """Get live streams from Kick"""
    try:
        # Use the working livestreams endpoint
        response = requests.get(
            f'https://kick.com/stream/livestreams/{language}?page={page}&limit={limit}',
            impersonate='chrome',
            timeout=15
        )

        if response.status_code == 200:
            data = response.json()
            if isinstance(data, dict) and 'data' in data:
                return {'success': True, 'streams': data['data'], 'currentPage': data.get('current_page', 1)}
            elif isinstance(data, list):
                return {'success': True, 'streams': data}

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
