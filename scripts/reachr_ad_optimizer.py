"""Pure allocation rules for the Wildrose daily group-copy experiment."""

import hashlib
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone


DAILY_TARGET = 400
INITIAL_CAMPAIGN_TARGET = 200
MAX_GROUPS_PER_JOB = 8
WINDOW_DAYS = 14


def copy_id(message):
    """Match creativeTrackingId in the Reachr extension for fixed copy."""
    value = 0
    for char in message:
        value = ((value << 5) - value + ord(char)) & 0xffffffff
    if value >= 0x80000000:
        value -= 0x100000000
    number = abs(value)
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    encoded = ''
    while number:
        number, digit = divmod(number, 36)
        encoded = digits[digit] + encoded
    return 'copy-' + (encoded or '0')


def stable_order(day, value):
    return int(hashlib.sha256((str(day) + ':' + str(value)).encode()).hexdigest()[:16], 16)


def parse_timestamp(value):
    normalized = value.replace('Z', '+00:00')
    normalized = re.sub(r'\.(\d{1,6})(?=[+-]\d\d:\d\d$)',
                        lambda match: '.' + match.group(1).ljust(6, '0'), normalized)
    return datetime.fromisoformat(normalized)


def performance(events, jobs, now):
    """Count attributed engaged sessions and attempted group delivery per copy."""
    cutoff = now - timedelta(days=WINDOW_DAYS)
    engaged = defaultdict(set)
    attempts = defaultdict(int)
    for row in events:
        if row.get('event') != 'engaged_visit' or row.get('source') != 'facebook':
            continue
        try:
            when = parse_timestamp(row['createdAt'])
        except (KeyError, TypeError, ValueError):
            continue
        creative = row.get('content')
        session = row.get('sessionId')
        if when >= cutoff and creative and session and not creative.startswith('qa_'):
            engaged[creative].add(session)
    for job in jobs:
        try:
            when = parse_timestamp(job['created_at'])
        except (KeyError, TypeError, ValueError):
            continue
        if when < cutoff or not job.get('message'):
            continue
        result = job.get('result') or {}
        attempts[copy_id(job['message'])] += sum(
            item.get('status') in ('posted', 'submitted_unconfirmed', 'pending_approval')
            for item in result.get('results') or []
        )
    return {key: {'engaged': len(engaged[key]), 'attempts': attempts[key]}
            for key in engaged.keys() | attempts.keys()}


def creative_weights(copy_ids, metrics):
    """Keep a balanced test until visits exist; retire only clear failures."""
    ids = set(copy_ids)
    total_visits = sum(metrics.get(key, {}).get('engaged', 0) for key in ids)
    total_attempts = sum(metrics.get(key, {}).get('attempts', 0) for key in ids)
    if total_visits < 20 or total_attempts < 100:
        return {key: 1.0 for key in ids}
    cohort_rate = total_visits / max(1, total_attempts)
    weights = {}
    for key in ids:
        row = metrics.get(key, {})
        seen, visits = row.get('attempts', 0), row.get('engaged', 0)
        peer_visits = total_visits - visits
        if seen >= 50 and visits == 0 and peer_visits >= 20 and cohort_rate >= 0.1:
            weights[key] = 0.0
        elif seen < 24:
            weights[key] = 1.0
        else:
            posterior_rate = (visits + 2) / (seen + 20)
            weights[key] = max(0.25, min(4.0, posterior_rate / max(cohort_rate, 0.01)))
    return weights


def pool_targets(campaign_copy_ids, partner_copy_ids, metrics):
    """Shift at most 100 slots once both pools have comparable evidence."""
    if not campaign_copy_ids:
        return 0, DAILY_TARGET
    if not partner_copy_ids:
        return DAILY_TARGET, 0
    def pool(ids):
        return (sum(metrics.get(key, {}).get('engaged', 0) for key in ids),
                sum(metrics.get(key, {}).get('attempts', 0) for key in ids))
    campaign_visits, campaign_attempts = pool(set(campaign_copy_ids))
    partner_visits, partner_attempts = pool(set(partner_copy_ids))
    if min(campaign_attempts, partner_attempts) < 100 or campaign_visits + partner_visits < 30:
        return INITIAL_CAMPAIGN_TARGET, DAILY_TARGET - INITIAL_CAMPAIGN_TARGET
    campaign_rate = campaign_visits / campaign_attempts
    partner_rate = partner_visits / partner_attempts
    if campaign_rate > partner_rate * 1.5:
        return 250, 150
    if partner_rate > campaign_rate * 1.5:
        return 150, 250
    return INITIAL_CAMPAIGN_TARGET, DAILY_TARGET - INITIAL_CAMPAIGN_TARGET


def select_campaign_schedules(schedules, target, day, weights):
    """Choose whole, already approved schedules with an exact group budget."""
    # Dynamic programming avoids changing approved groups inside a schedule.
    states = {0: (0.0, ())}
    for row in sorted(schedules, key=lambda item: str(item['id'])):
        size = len(row.get('groups') or [])
        if not size or size > target:
            continue
        weight = weights.get(copy_id(row['message']), 1.0)
        if weight <= 0:
            continue
        jitter = stable_order(day, row['id']) / (2 ** 64)
        value = size * weight + jitter
        for count, (score, chosen) in sorted(list(states.items()), reverse=True):
            new_count = count + size
            if new_count > target:
                continue
            candidate = (score + value, chosen + (row['id'],))
            if new_count not in states or candidate[0] > states[new_count][0]:
                states[new_count] = candidate
    best_count = max(states)
    chosen_ids = set(states[best_count][1])
    return [row for row in schedules if row['id'] in chosen_ids]


def allocate_partner_groups(groups, drafts, target, day, weights, audience_for_group,
                            audience_for_draft, relevance, excluded_urls=()):
    """Spread same-audience groups across ads; avoid duplicate group targets."""
    excluded = set(excluded_urls)
    available = [row for row in groups if row.get('group_url') not in excluded]
    available.sort(key=lambda row: stable_order(day, row.get('group_url')))
    assignments = {draft['external_id']: [] for draft in drafts}
    by_audience = defaultdict(list)
    for draft in drafts:
        weight = weights.get(copy_id(draft['message']), 1.0)
        if weight > 0:
            by_audience[audience_for_draft(draft)].append((draft, weight))
    for row in available:
        if sum(len(items) for items in assignments.values()) >= target:
            break
        candidates = by_audience.get(audience_for_group(row.get('group_name')), [])
        if not candidates:
            continue
        draft, _ = min(candidates, key=lambda item: (
            len(assignments[item[0]['external_id']]) / item[1],
            -relevance(row, item[0]), stable_order(day, item[0]['external_id'])))
        assignments[draft['external_id']].append(row)
        excluded.add(row['group_url'])
    return assignments
