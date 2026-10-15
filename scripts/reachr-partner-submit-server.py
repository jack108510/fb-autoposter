#!/usr/bin/env python3
"""Submission-only Reachr intake for the existing named Cloudflare tunnel."""

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
from uuid import uuid4


KEY_DIR = Path('/Users/jackserver/jsw/keys')
TOKEN_HASH_PATH = KEY_DIR / 'reachr-partner-submit.hash'
SUPABASE_ENV_PATH = KEY_DIR / 'reachr-supabase.env'
OWNER_ID = '45717c8c-08f9-469f-bf7d-2fa2ef5ad441'
MAX_BODY = 20_000
PREFIX = 'partner_submission:'
ALLOWED_FIELDS = {'title', 'message', 'destination_url', 'image_url', 'notes', 'external_id'}


def read_env(path):
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            name, value = line.split('=', 1)
            values[name] = value.strip().strip('"\'')
    return values


def field(value, name, limit, required=False):
    if value is None or value == '':
        if required:
            raise ValueError(f'{name} is required')
        return None
    if not isinstance(value, str):
        raise ValueError(f'{name} must be a string')
    value = value.strip()
    if required and not value:
        raise ValueError(f'{name} is required')
    if len(value) > limit:
        raise ValueError(f'{name} exceeds {limit} characters')
    return value or None


def validate_submission(value):
    if not isinstance(value, dict):
        raise ValueError('JSON object required')
    unknown = set(value) - ALLOWED_FIELDS
    if unknown:
        raise ValueError('Unsupported fields: ' + ', '.join(sorted(unknown)))
    submission = {
        'title': field(value.get('title'), 'title', 120, True),
        'message': field(value.get('message'), 'message', 10_000, True),
        'destination_url': field(value.get('destination_url'), 'destination_url', 2048),
        'image_url': field(value.get('image_url'), 'image_url', 2048),
        'notes': field(value.get('notes'), 'notes', 2000),
        'external_id': field(value.get('external_id'), 'external_id', 120),
    }
    for name in ('destination_url', 'image_url'):
        if submission[name]:
            parsed = urlparse(submission[name])
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError(f'{name} must be an HTTPS URL without credentials')
    return submission


def authorized(header, expected_hash):
    if not header or not header.startswith('Bearer '):
        return False
    token = header[7:]
    if not token or len(token) > 256:
        return False
    return hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), expected_hash)


def submission_key(submission):
    external_id = submission['external_id']
    if external_id:
        return PREFIX + 'id:' + hashlib.sha256(external_id.encode()).hexdigest()
    return PREFIX + str(uuid4())


def same_submission(existing, incoming):
    return all(existing.get(name) == incoming[name] for name in ALLOWED_FIELDS)


class Handler(BaseHTTPRequestHandler):
    server_version = 'ReachrSubmit/1'

    def log_message(self, format_string, *args):
        # Never log request headers, body, or draft copy.
        print('%s %s' % (self.address_string(), format_string % args), flush=True)

    def response(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def db(self, method, path, payload=None):
        config = self.server.config
        body = json.dumps(payload).encode('utf-8') if payload is not None else None
        request = Request(
            config['SUPABASE_URL'].rstrip('/') + '/rest/v1/' + path,
            data=body,
            method=method,
            headers={
                'apikey': config['SUPABASE_SECRET_KEY'],
                'Authorization': 'Bearer ' + config['SUPABASE_SECRET_KEY'],
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
            },
        )
        with urlopen(request, timeout=12) as response:
            return json.load(response)

    def do_POST(self):
        if self.path != '/reachr-submit':
            return self.response(404, {'error': 'Not found'})
        if not authorized(self.headers.get('Authorization'), self.server.token_hash):
            return self.response(401, {'error': 'Unauthorized'})
        if not self.headers.get('Content-Type', '').lower().startswith('application/json'):
            return self.response(415, {'error': 'Content-Type must be application/json'})
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            return self.response(413, {'error': 'Request size must be at most 20000 bytes'})
        try:
            submission = validate_submission(json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeDecodeError) as error:
            return self.response(400, {'error': str(error)})

        key = submission_key(submission)
        value = {**submission, 'status': 'submitted', 'created_at': datetime.now(timezone.utc).isoformat()}
        try:
            rows = self.db('POST', 'amplr_data', {'user_id': OWNER_ID, 'key': key, 'value': value})
            if len(rows) != 1:
                raise RuntimeError('Submission write returned no row')
            return self.response(201, {'id': key, 'status': 'submitted', 'created_at': value['created_at']})
        except HTTPError as error:
            if error.code == 409 and submission['external_id']:
                try:
                    rows = self.db('GET', 'amplr_data?select=value&user_id=eq.' + OWNER_ID + '&key=eq.' + quote(key, safe=''))
                    if len(rows) == 1:
                        existing = rows[0]['value']
                        if same_submission(existing, submission):
                            return self.response(200, {'id': key, 'status': existing['status'], 'created_at': existing['created_at'], 'duplicate': True})
                        return self.response(409, {'error': 'external_id already used for different content'})
                except (HTTPError, URLError, KeyError, ValueError):
                    pass
            print('Reachr submission database HTTP error:', error.code, flush=True)
            return self.response(503, {'error': 'Could not save submission'})
        except (URLError, ValueError, RuntimeError) as error:
            print('Reachr submission database error:', type(error).__name__, flush=True)
            return self.response(503, {'error': 'Could not save submission'})


def main():
    config = read_env(SUPABASE_ENV_PATH)
    if not config.get('SUPABASE_URL') or not config.get('SUPABASE_SECRET_KEY'):
        raise RuntimeError('Reachr Supabase configuration is missing')
    token_hash = TOKEN_HASH_PATH.read_text(encoding='ascii').strip()
    if len(token_hash) != 64 or any(c not in '0123456789abcdef' for c in token_hash):
        raise RuntimeError('Submission key hash is invalid')
    server = ThreadingHTTPServer(('127.0.0.1', 4193), Handler)
    server.config = config
    server.token_hash = token_hash
    print('Reachr submission intake listening on 127.0.0.1:4193', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
