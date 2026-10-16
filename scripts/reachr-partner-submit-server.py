#!/usr/bin/env python3
"""Submission-only Reachr intake for the existing named Cloudflare tunnel."""

import hashlib
import hmac
import json
import re
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
from uuid import NAMESPACE_URL, uuid4, uuid5
from zoneinfo import ZoneInfo


KEY_DIR = Path('/Users/jackserver/jsw/keys')
TOKEN_HASH_PATH = KEY_DIR / 'reachr-partner-submit.hash'
SUPABASE_ENV_PATH = KEY_DIR / 'reachr-supabase.env'
OWNER_ID = '45717c8c-08f9-469f-bf7d-2fa2ef5ad441'
MAX_BODY = 20_000
PREFIX = 'partner_submission:'
ALLOWED_FIELDS = {'title', 'message', 'destination_url', 'image_url', 'notes', 'external_id'}
DESTINATION_HOSTS = {'wildroseautomations.ca', 'www.wildroseautomations.ca'}
IMAGE_HOSTS = DESTINATION_HOSTS | {'i.imgur.com', 'jack108510.github.io'}
PUBLISH_IDENTITY = 'Wildrose Automations'
PUBLISH_IDENTITY_KEY = 'wildrose automations'
DEFAULT_ROSE_LINK = 'https://wildroseautomations.ca/ai-tool-mockup-final.html'
PUBLISH_LOCK = Lock()
TEST_GROUP_COUNT = 3


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
        'external_id': field(value.get('external_id'), 'external_id', 120, True),
    }
    for name in ('destination_url', 'image_url'):
        if submission[name]:
            parsed = urlparse(submission[name])
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError(f'{name} must be an HTTPS URL without credentials')
            hosts = DESTINATION_HOSTS if name == 'destination_url' else IMAGE_HOSTS
            if parsed.hostname.lower() not in hosts:
                raise ValueError(f'{name} must use an approved Rose campaign host')
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


def suggested_audience(submission):
    known = {
        'wildrose-ads-1': 'local', 'wildrose-ads-2': 'local',
        'wildrose-ads-3': 'agency', 'wildrose-ads-4': 'local',
        'wildrose-ads-5': 'promotion', 'wildrose-single-ad-dark-1': 'local',
    }
    if submission.get('external_id') in known:
        return known[submission['external_id']]
    words = ' '.join(str(submission.get(name) or '') for name in ('title', 'message', 'notes')).lower()
    if re.search(r'web design|web developer|agency|agencies|client.s website|sites you build', words):
        return 'agency'
    if re.search(r'pricing|\bplans?\b|\bca\$|\$0\.29|free month|month free', words):
        return 'promotion'
    if re.search(r'contractor|trades|clinic|local service', words):
        return 'service'
    return 'local'


def technical_checks(submission):
    checks = {'checked_at': datetime.now(timezone.utc).isoformat(), 'destination': 'not_provided',
              'image': 'not_provided', 'media': 'ok'}
    notes = str(submission.get('notes') or '').lower()
    if re.search(r'\bvideo post\b|full.quality.*video', notes):
        checks['media'] = 'video_not_supported_by_reachr_post_jobs'
    elif 'poll feature' in notes:
        checks['media'] = 'text_poll_only'
    for field_name, check_name in (('destination_url', 'destination'), ('image_url', 'image')):
        url = submission.get(field_name)
        if not url:
            continue
        try:
            request = Request(url, headers={'User-Agent': 'Mozilla/5.0 ReachrPartnerCheck/1.0'})
            with urlopen(request, timeout=12) as response:
                sample = response.read(64)
                content_type = response.headers.get('Content-Type', '').lower()
                status = response.status
            if check_name == 'image':
                checks[check_name] = 'ok' if status == 200 and content_type.startswith('image/') and sample else 'invalid_image'
            else:
                checks[check_name] = 'ok' if 200 <= status < 400 else 'unreachable'
        except (HTTPError, URLError, TimeoutError, ValueError):
            checks[check_name] = 'unreachable'
    checks['ok'] = (checks['destination'] in ('ok', 'not_provided')
                    and checks['image'] in ('ok', 'not_provided')
                    and checks['media'] != 'video_not_supported_by_reachr_post_jobs')
    return checks


def posting_message(submission):
    message = submission['message']
    if re.search(r'https?://', message):
        return message
    return message.rstrip() + '\n\nSee how Rose works: ' + (submission.get('destination_url') or DEFAULT_ROSE_LINK)


def publish_request(value):
    if not isinstance(value, dict) or set(value) != {'action', 'external_id'} or value.get('action') != 'publish':
        raise ValueError('Publishing requires action and external_id only')
    return field(value.get('external_id'), 'external_id', 120, True)


def outcome_counts(job):
    counts = {'posted': 0, 'pending_approval': 0, 'unconfirmed': 0, 'failed': 0}
    for result in (job.get('result') or {}).get('results') or []:
        status = result.get('status') or result.get('outcome') or ''
        if status == 'pending_approval':
            counts['pending_approval'] += 1
        elif status in ('submitted_unconfirmed', 'unconfirmed'):
            counts['unconfirmed'] += 1
        elif status == 'failed' or result.get('failed'):
            counts['failed'] += 1
        elif status in ('posted', 'submitted') or result.get('success') is True:
            counts['posted'] += 1
    return counts


def category_from_campaign_name(name):
    parts = str(name or '').split(' · ')
    return parts[1].strip().lower() if len(parts) > 1 else ''


def group_audience(name):
    name = str(name or '').lower()
    if re.search(r'agenc|smma|social media|digital marketing|gohighlevel|web design', name):
        return 'agency'
    if re.search(r'home service|services|home.based|home business', name):
        return 'service'
    if re.search(r'advertis|promot|marketplace|buy, sell|free business|offers|vendors?', name):
        return 'promotion'
    if re.search(r'business|entrepreneur|network|startup', name):
        return 'local'
    return ''


def group_relevance(row, submission=None):
    name = str(row.get('group_name') or '').lower()
    score = 0
    if re.search(r'canad|ontario|alberta|nova scotia|halifax|toronto|calgary|vancouver|saskatchewan|quebec|bc\b', name):
        score += 3
    if re.search(r'business|entrepreneur|agency|web design', name):
        score += 2
    if re.search(r'florida|usa|\buk\b|philippines', name):
        score -= 3
    creative = str((submission or {}).get('title') or '').lower()
    if re.search(r'web design|designer|developer', creative) and re.search(r'web design|designer|developer|wordpress', name):
        score += 5
    return score


def parse_time(value):
    if not value:
        return None
    normalized = value.replace('Z', '+00:00')
    normalized = re.sub(r'\.(\d{1,6})(?=[+-]\d\d:\d\d$)',
                        lambda match: '.' + match.group(1).ljust(6, '0'), normalized)
    return datetime.fromisoformat(normalized)


def publish_job_id(external_id):
    return str(uuid5(NAMESPACE_URL, 'reachr-partner-publish:' + external_id))


def select_campaign_groups(schedules, inventory, active_jobs, audience, now, count=TEST_GROUP_COUNT, submission=None):
    if audience not in {category_from_campaign_name(row.get('name')) for row in schedules}:
        return []
    campaign_urls = {
        target.get('url') for schedule in schedules for target in (schedule.get('groups') or [])
        if isinstance(target, dict)
    }
    busy_urls = {
        group.get('url') for job in active_jobs for group in (job.get('groups') or [])
        if isinstance(group, dict)
    }
    cutoff = now - timedelta(days=7)
    candidates = {}
    for row in inventory:
        url = row.get('group_url')
        if not url or url in campaign_urls or url in busy_urls:
            continue
        if row.get('identity_key') != PUBLISH_IDENTITY_KEY or group_audience(row.get('group_name')) != audience:
            continue
        if row.get('ban_risk') == 'high' or int(row.get('removal_count') or 0) > 0:
            continue
        last_posted = parse_time(row.get('last_posted_at'))
        if last_posted and last_posted > cutoff:
            continue
        candidates[url] = row
    selected = sorted(candidates.values(), key=lambda row: (-group_relevance(row, submission), row.get('last_posted_at') or '', row.get('group_name') or '', row['group_url']))[:count]
    return [{
        'url': row['group_url'], 'name': row.get('group_name') or row['group_url'],
        'group_name': row.get('group_name') or row['group_url'],
        'identity_name': PUBLISH_IDENTITY, 'identity_key': PUBLISH_IDENTITY_KEY,
        'profile_name': PUBLISH_IDENTITY, 'profile_key': PUBLISH_IDENTITY_KEY,
    } for row in selected]


def next_partner_slot(schedules, active_jobs, now):
    atlantic = ZoneInfo('America/Halifax')
    local_day = now.astimezone(atlantic).date()
    times = [now]
    for row in schedules + active_jobs:
        due = parse_time(row.get('next_at') or row.get('scheduled_for'))
        if due and due.astimezone(atlantic).date() == local_day and due >= now:
            times.append(due)
    return max(times) + timedelta(minutes=15)


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

    def publish(self, value):
        status, body = Handler.publish_result(self, value)
        return self.response(status, body)

    def publish_result(self, value):
        try:
            external_id = publish_request(value)
        except ValueError as error:
            return 400, {'error': str(error)}
        draft_key = submission_key({'external_id': external_id})
        job_id = publish_job_id(external_id)
        with PUBLISH_LOCK:
            try:
                existing = self.db('GET', 'jsw_post_jobs?' + urlencode({
                    'select': 'id,status,scheduled_for,groups', 'user_id': 'eq.' + OWNER_ID, 'id': 'eq.' + job_id,
                }))
                if existing:
                    row = existing[0]
                    return (200, {'job_id': job_id, 'status': row['status'],
                                               'scheduled_for': row.get('scheduled_for'),
                                               'group_count': len(row.get('groups') or []), 'duplicate': True})
                drafts = self.db('GET', 'amplr_data?' + urlencode({
                    'select': 'value', 'user_id': 'eq.' + OWNER_ID, 'key': 'eq.' + draft_key,
                }))
                if len(drafts) != 1:
                    return (404, {'error': 'Submitted draft not found'})
                draft = drafts[0]['value']
                if draft.get('external_id') != external_id or not draft.get('title') or not draft.get('message'):
                    return (409, {'error': 'Submitted draft is incomplete'})
                try:
                    validate_submission({name: draft.get(name) for name in ALLOWED_FIELDS})
                except ValueError as error:
                    return (422, {'error': str(error)})
                checks = technical_checks(draft)
                audience = suggested_audience(draft)
                draft = {**draft, 'technical_checks': checks, 'suggested_audience': audience}
                self.db('PATCH', 'amplr_data?' + urlencode({
                    'user_id': 'eq.' + OWNER_ID, 'key': 'eq.' + draft_key,
                }), {'value': draft, 'updated_at': datetime.now(timezone.utc).isoformat()})
                if not checks['ok']:
                    return (422, {'error': 'The submitted asset or media type did not pass the technical check',
                                               'technical_checks': checks})
                schedules = self.db('GET', 'reachr_campaign_schedules?' + urlencode({
                    'select': 'name,groups,next_at', 'user_id': 'eq.' + OWNER_ID,
                    'source_campaign_id': 'like.rose-oct16-200*', 'status': 'eq.active', 'limit': '200',
                }))
                inventory = self.db('GET', 'jsw_groups?' + urlencode({
                    'select': 'group_url,group_name,identity_key,ban_risk,removal_count,last_posted_at',
                    'user_id': 'eq.' + OWNER_ID, 'limit': '2000',
                }))
                active_jobs = self.db('GET', 'jsw_post_jobs?' + urlencode({
                    'select': 'groups,scheduled_for', 'user_id': 'eq.' + OWNER_ID,
                    'status': 'in.(pending,processing)', 'limit': '1000',
                }))
                now = datetime.now(timezone.utc)
                groups = select_campaign_groups(schedules, inventory, active_jobs, audience, now, submission=draft)
                if len(groups) < TEST_GROUP_COUNT:
                    return (409, {'error': f'Only {len(groups)} eligible {audience} groups are available; no post was queued'})
                scheduled_for = next_partner_slot(schedules, active_jobs, now).isoformat()
                job = {
                    'id': job_id, 'user_id': OWNER_ID, 'message': posting_message(draft),
                    'image_url': draft.get('image_url'), 'groups': groups, 'delay': 90,
                    'ai_enabled': False, 'ai_prompt': None, 'first_comment': None, 'status': 'pending',
                    'scheduled_for': scheduled_for, 'identity_name': PUBLISH_IDENTITY,
                    'identity_key': PUBLISH_IDENTITY_KEY,
                    'result': {
                        'campaign_id': 'rose-partner-' + external_id,
                        'batch_index': 1, 'batch_count': 1, 'total_target_count': len(groups),
                        'results': [], 'partner_submission_key': draft_key,
                        'partner_audience': audience, 'published_by': 'partner_key',
                    },
                }
                inserted = self.db('POST', 'jsw_post_jobs', job)
                if len(inserted) != 1:
                    raise RuntimeError('Job insert returned no row')
                draft.update({'status': 'queued', 'publish_job_id': job_id,
                              'scheduled_for': scheduled_for, 'target_groups': [g['name'] for g in groups]})
                try:
                    self.db('PATCH', 'amplr_data?' + urlencode({
                        'user_id': 'eq.' + OWNER_ID, 'key': 'eq.' + draft_key,
                    }), {'value': draft, 'updated_at': datetime.now(timezone.utc).isoformat()})
                except (HTTPError, URLError, ValueError):
                    print('Reachr partner job queued but draft metadata update failed:', job_id, flush=True)
                return (201, {'job_id': job_id, 'status': 'pending',
                                           'scheduled_for': scheduled_for, 'audience': audience,
                                           'group_count': len(groups), 'groups': [g['name'] for g in groups]})
            except (HTTPError, URLError, ValueError, KeyError, RuntimeError) as error:
                print('Reachr partner publish error:', type(error).__name__, flush=True)
                return (503, {'error': 'Could not queue the post'})

    def publish_status(self, value):
        try:
            if not isinstance(value, dict) or set(value) != {'action', 'external_id'} or value.get('action') != 'status':
                raise ValueError('Status requires action and external_id only')
            external_id = field(value.get('external_id'), 'external_id', 120, True)
            job_id = publish_job_id(external_id)
            rows = self.db('GET', 'jsw_post_jobs?' + urlencode({
                'select': 'id,status,scheduled_for,groups,result,error',
                'user_id': 'eq.' + OWNER_ID, 'id': 'eq.' + job_id,
            }))
            if not rows:
                return self.response(404, {'error': 'No Reachr post job for this submission'})
            job = rows[0]
            return self.response(200, {'job_id': job_id, 'status': job['status'],
                                       'scheduled_for': job.get('scheduled_for'),
                                       'group_count': len(job.get('groups') or []),
                                       'outcomes': outcome_counts(job), 'error': job.get('error')})
        except ValueError as error:
            return self.response(400, {'error': str(error)})
        except (HTTPError, URLError, KeyError):
            return self.response(503, {'error': 'Could not read posting status'})

    def finish_submission(self, submission, key, stored, duplicate=False):
        queue_status, queue = Handler.publish_result(self, {
            'action': 'publish', 'external_id': submission['external_id'],
        })
        result = {'id': key, 'external_id': submission['external_id'],
                  'created_at': stored['created_at'], 'duplicate': duplicate,
                  'status': 'queued' if queue_status in (200, 201) else 'submitted',
                  'queue': queue}
        return self.response(200 if duplicate else 201, result)

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
            value = json.loads(self.rfile.read(length))
            if isinstance(value, dict) and value.get('action') == 'publish':
                return self.publish(value)
            if isinstance(value, dict) and value.get('action') == 'status':
                return self.publish_status(value)
            submission = validate_submission(value)
        except (ValueError, UnicodeDecodeError) as error:
            return self.response(400, {'error': str(error)})

        key = submission_key(submission)
        value = {**submission, 'status': 'submitted', 'created_at': datetime.now(timezone.utc).isoformat(),
                 'suggested_audience': suggested_audience(submission),
                 'technical_checks': technical_checks(submission)}
        try:
            rows = self.db('POST', 'amplr_data', {'user_id': OWNER_ID, 'key': key, 'value': value})
            if len(rows) != 1:
                raise RuntimeError('Submission write returned no row')
            return Handler.finish_submission(self, submission, key, value)
        except HTTPError as error:
            if error.code == 409:
                try:
                    rows = self.db('GET', 'amplr_data?select=value&user_id=eq.' + OWNER_ID + '&key=eq.' + quote(key, safe=''))
                    if len(rows) == 1:
                        existing = rows[0]['value']
                        if same_submission(existing, submission):
                            return Handler.finish_submission(self, submission, key, existing, duplicate=True)
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
