#!/usr/bin/env python3
"""Queue or inspect a stored partner draft using the scoped Reachr key."""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_URL = 'https://n8n.wildeautomations.com/reachr-submit'
SIX_DRAFTS = [f'wildrose-ads-{index}' for index in range(1, 6)] + ['wildrose-single-ad-dark-1']


def request(action, external_id, key, url):
    body = json.dumps({'action': action, 'external_id': external_id}).encode('utf-8')
    prepared = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'User-Agent': 'ReachrPartnerPublish/1.0',
    })
    try:
        with urllib.request.urlopen(prepared, timeout=75) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error)
            reason = detail.get('error', 'Request failed')
        except (ValueError, OSError):
            reason = 'Request failed'
        raise RuntimeError(f'Reachr returned {error.code}: {reason}') from error
    except urllib.error.URLError as error:
        raise RuntimeError(f'Could not reach Reachr: {error.reason}') from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('external_ids', nargs='*', help='External ID(s) returned when submitting drafts')
    parser.add_argument('--all-six', action='store_true', help='Use the six Rose drafts submitted October 16')
    parser.add_argument('--status', action='store_true', help='Read job status and group outcomes')
    args = parser.parse_args()
    if args.all_six and args.external_ids:
        parser.error('Use either --all-six or explicit external IDs')
    ids = SIX_DRAFTS if args.all_six else args.external_ids
    if not ids:
        parser.error('Provide an external ID or --all-six')
    key = os.environ.get('REACHR_SUBMIT_KEY', '').strip()
    if not key:
        print('REACHR_SUBMIT_KEY is missing', file=sys.stderr)
        return 2
    action = 'status' if args.status else 'publish'
    for external_id in ids:
        try:
            result = request(action, external_id, key, os.environ.get('REACHR_SUBMIT_URL', DEFAULT_URL))
            print(json.dumps({'external_id': external_id, **result}))
        except RuntimeError as error:
            print(f'{external_id}: {error}', file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
