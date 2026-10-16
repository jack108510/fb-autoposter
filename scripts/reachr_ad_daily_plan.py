#!/usr/bin/env python3
"""Plan one 400-target Wildrose experiment day. Dry run unless --apply is given."""

import argparse
import importlib.util
import json
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

import reachr_ad_optimizer as optimizer


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('partner_submit', HERE / 'reachr-partner-submit-server.py')
submit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(submit)
FUNNEL_EVENTS = Path('/Users/jackserver/wildrose-ai-widget/leads/rose-funnel-events.jsonl')
ATLANTIC = ZoneInfo('America/Halifax')
PLAN_PREFIX = 'reachr_ad_plan:'


class Client:
    def __init__(self):
        self.server = type('Server', (), {'config': submit.read_env(submit.SUPABASE_ENV_PATH)})()

    def db(self, method, table, query=None, payload=None):
        path = table + ('?' + urlencode(query) if query else '')
        return submit.Handler.db(self, method, path, payload)


def pages(client, table, query, page_size=1000):
    rows = []
    offset = 0
    while True:
        batch = client.db('GET', table, {**query, 'limit': str(page_size), 'offset': str(offset)})
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        offset += page_size


def read_events():
    if not FUNNEL_EVENTS.exists():
        return []
    events = []
    for line in FUNNEL_EVENTS.read_text(encoding='utf-8').splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def next_at_for_day(schedule, day):
    clock = time.fromisoformat(schedule['local_time'])
    zone = ZoneInfo(schedule.get('timezone') or 'America/Halifax')
    return datetime.combine(day, clock, zone).astimezone(timezone.utc).isoformat()


def job_plans(assignments, drafts_by_id, day):
    """Interleave variants across the day in bounded eight-group jobs."""
    batches = []
    for external_id, rows in assignments.items():
        for index in range(0, len(rows), optimizer.MAX_GROUPS_PER_JOB):
            batches.append((index // optimizer.MAX_GROUPS_PER_JOB, external_id, rows[index:index + optimizer.MAX_GROUPS_PER_JOB]))
    batches.sort(key=lambda item: (item[0], optimizer.stable_order(day, item[1])))
    plans = []
    for position, (batch_index, external_id, rows) in enumerate(batches):
        draft = drafts_by_id[external_id]
        slot = datetime.combine(day, time(9, 0), ATLANTIC) + timedelta(minutes=25 * position)
        job_id = str(uuid5(NAMESPACE_URL, 'reachr-ad-day:' + str(day) + ':' + external_id + ':' + str(batch_index)))
        groups = [{
            'url': row['group_url'], 'name': row.get('group_name') or row['group_url'],
            'group_name': row.get('group_name') or row['group_url'],
            'identity_name': submit.PUBLISH_IDENTITY, 'identity_key': submit.PUBLISH_IDENTITY_KEY,
            'profile_name': submit.PUBLISH_IDENTITY, 'profile_key': submit.PUBLISH_IDENTITY_KEY,
        } for row in rows]
        plans.append({
            'id': job_id, 'user_id': submit.OWNER_ID,
            'message': submit.posting_message(draft), 'image_url': draft.get('image_url'),
            'groups': groups, 'delay': 90, 'ai_enabled': False, 'ai_prompt': None,
            'first_comment': None, 'status': 'pending',
            'scheduled_for': slot.astimezone(timezone.utc).isoformat(),
            'identity_name': submit.PUBLISH_IDENTITY, 'identity_key': submit.PUBLISH_IDENTITY_KEY,
            'result': {'campaign_id': 'rose-partner-daily-' + str(day) + '-' + external_id,
                       'batch_index': batch_index + 1,
                       'batch_count': (len(assignments[external_id]) + 7) // 8,
                       'total_target_count': len(assignments[external_id]),
                       'partner_submission_key': submit.submission_key(draft),
                       'partner_audience': submit.suggested_audience(draft),
                       'published_by': 'partner_daily_optimizer', 'results': []},
        })
    return plans


def create_plan(client, day, now):
    query_user = {'user_id': 'eq.' + submit.OWNER_ID}
    schedules = pages(client, 'reachr_campaign_schedules', {
        **query_user, 'select': 'id,name,message,groups,next_at,local_time,timezone,status,enabled',
        'source_campaign_id': 'like.rose-oct16-200*', 'status': 'in.(active,paused)',
    })
    previous = client.db('GET', 'amplr_data', {
        **query_user, 'select': 'value', 'key': 'eq.' + PLAN_PREFIX + str(day - timedelta(days=1)),
    })
    if previous and previous[0]['value'].get('applied_at'):
        previously_active = set(previous[0]['value'].get('campaign_schedule_ids') or [])
        # A schedule selected yesterday but now paused was stopped outside this planner.
        schedules = [row for row in schedules if row['status'] == 'active' or row['id'] not in previously_active]
    else:
        schedules = [row for row in schedules if row['status'] == 'active']
    inventory = pages(client, 'jsw_groups', {
        **query_user, 'select': 'group_url,group_name,identity_key,ban_risk,removal_count,last_posted_at',
    })
    drafts = [row['value'] for row in pages(client, 'amplr_data', {
        **query_user, 'select': 'value', 'key': 'like.partner_submission:*',
    })]
    drafts = [draft for draft in drafts if draft.get('external_id') and
              (draft.get('technical_checks') or {}).get('ok') and
              draft.get('status') in ('submitted', 'queued')]
    since = (now - timedelta(days=optimizer.WINDOW_DAYS)).isoformat()
    jobs = pages(client, 'jsw_post_jobs', {
        **query_user, 'select': 'id,message,groups,result,created_at,scheduled_for,status',
        'created_at': 'gte.' + since,
    })
    metrics = optimizer.performance(read_events(), jobs, now)
    campaign_ids = [optimizer.copy_id(row['message']) for row in schedules]
    partner_ids = [optimizer.copy_id(submit.posting_message(row)) for row in drafts]
    campaign_target, partner_target = optimizer.pool_targets(campaign_ids, partner_ids, metrics)
    campaign_weights = optimizer.creative_weights(campaign_ids, metrics)
    partner_weights = optimizer.creative_weights(partner_ids, metrics)
    day_start = datetime.combine(day, time.min, ATLANTIC).astimezone(timezone.utc)
    day_end = datetime.combine(day + timedelta(days=1), time.min, ATLANTIC).astimezone(timezone.utc)
    already_used = set()
    for job in jobs:
        due = submit.parse_time(job.get('scheduled_for'))
        if due and day_start <= due < day_end and job.get('status') not in ('cancelled', 'canceled'):
            already_used.update(group.get('url') for group in job.get('groups') or [])
    candidates = []
    for row in inventory:
        if row.get('identity_key') != submit.PUBLISH_IDENTITY_KEY or not row.get('group_url'):
            continue
        if row.get('ban_risk') in ('medium', 'high') or int(row.get('removal_count') or 0) > 0:
            continue
        if not submit.group_audience(row.get('group_name')):
            continue
        last_posted = submit.parse_time(row.get('last_posted_at'))
        if last_posted and last_posted.astimezone(ATLANTIC).date() >= day:
            continue
        candidates.append(row)
    for _ in range(optimizer.DAILY_TARGET + 1):
        chosen = optimizer.select_campaign_schedules(schedules, campaign_target, day, campaign_weights)
        chosen_urls = {group.get('url') for row in chosen for group in row.get('groups') or []}
        assignments = optimizer.allocate_partner_groups(
            candidates, drafts, partner_target, day, partner_weights,
            submit.group_audience, submit.suggested_audience, submit.group_relevance,
            chosen_urls | already_used)
        planned = sum(len(row.get('groups') or []) for row in chosen) + sum(len(rows) for rows in assignments.values())
        if planned >= optimizer.DAILY_TARGET or campaign_target >= optimizer.DAILY_TARGET:
            break
        campaign_target = min(optimizer.DAILY_TARGET, campaign_target + max(1, optimizer.DAILY_TARGET - planned))
        partner_target = optimizer.DAILY_TARGET - campaign_target
    planned_jobs = job_plans(assignments, {row['external_id']: row for row in drafts}, day)
    return {
        'date': str(day), 'campaign_target': campaign_target,
        'campaign_group_count': sum(len(row.get('groups') or []) for row in chosen),
        'campaign_schedule_ids': [row['id'] for row in chosen],
        'partner_target': partner_target,
        'partner_group_count': sum(len(rows) for rows in assignments.values()),
        'partner_by_ad': {key: len(rows) for key, rows in assignments.items()},
        'partner_performance': {
            draft['external_id']: {
                'engaged_visits_14d': metrics.get(optimizer.copy_id(submit.posting_message(draft)), {}).get('engaged', 0),
                'delivery_attempts_14d': metrics.get(optimizer.copy_id(submit.posting_message(draft)), {}).get('attempts', 0),
                'allocation_weight': partner_weights.get(optimizer.copy_id(submit.posting_message(draft)), 1.0),
                'state': 'retired' if partner_weights.get(optimizer.copy_id(submit.posting_message(draft)), 1.0) == 0
                         else 'testing' if sum(row.get('engaged', 0) for row in metrics.values()) < 20
                         else 'pushing' if partner_weights.get(optimizer.copy_id(submit.posting_message(draft)), 1.0) > 1.5
                         else 'testing',
            } for draft in drafts},
        'total_planned': sum(len(row.get('groups') or []) for row in chosen) +
                         sum(len(rows) for rows in assignments.values()),
        'jobs': planned_jobs,
        'metrics': {key: metrics.get(key, {'engaged': 0, 'attempts': 0}) for key in set(campaign_ids + partner_ids)},
    }, schedules


def apply_plan(client, plan, schedules):
    day = date.fromisoformat(plan['date'])
    if plan['total_planned'] != optimizer.DAILY_TARGET:
        raise RuntimeError('Daily plan does not fill the 400-target budget; no schedules were changed')
    chosen = set(plan['campaign_schedule_ids'])
    # Stop unchosen schedules first so the campaign and partner jobs share the cap.
    for row in schedules:
        if row['id'] not in chosen and row['status'] == 'active':
            changed = client.db('PATCH', 'reachr_campaign_schedules', {
                'user_id': 'eq.' + submit.OWNER_ID, 'id': 'eq.' + row['id'],
            }, {'status': 'paused', 'enabled': False})
            if len(changed) != 1:
                raise RuntimeError('Could not pause schedule ' + row['id'])
    for row in schedules:
        if row['id'] in chosen and row['status'] != 'active':
            changed = client.db('PATCH', 'reachr_campaign_schedules', {
                'user_id': 'eq.' + submit.OWNER_ID, 'id': 'eq.' + row['id'],
            }, {'status': 'active', 'enabled': True,
                'next_at': next_at_for_day(row, day)})
            if len(changed) != 1:
                raise RuntimeError('Could not activate schedule ' + row['id'])
    inserted = 0
    for job in plan['jobs']:
        exists = client.db('GET', 'jsw_post_jobs', {
            'select': 'id', 'user_id': 'eq.' + submit.OWNER_ID, 'id': 'eq.' + job['id'],
        })
        if exists:
            continue
        rows = client.db('POST', 'jsw_post_jobs', payload=job)
        if len(rows) != 1:
            raise RuntimeError('Could not queue partner job ' + job['id'])
        inserted += 1
    return inserted


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Write the plan and queue jobs')
    parser.add_argument('--date', type=date.fromisoformat, default=None)
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    local_now = now.astimezone(ATLANTIC)
    day = args.date or local_now.date()
    if args.apply and (day != local_now.date() or local_now.time() >= time(8, 0)):
        print(json.dumps({'date': str(day), 'status': 'outside_planning_window'}))
        return
    client = Client()
    key = PLAN_PREFIX + str(day)
    existing = client.db('GET', 'amplr_data', {
        'select': 'value', 'user_id': 'eq.' + submit.OWNER_ID, 'key': 'eq.' + key,
    })
    if existing:
        plan = existing[0]['value']
        schedules = pages(client, 'reachr_campaign_schedules', {
            'select': 'id,status,enabled,local_time,timezone', 'user_id': 'eq.' + submit.OWNER_ID,
            'source_campaign_id': 'like.rose-oct16-200*', 'status': 'in.(active,paused)',
        })
    else:
        plan, schedules = create_plan(client, day, now)
    summary = {key: value for key, value in plan.items() if key not in ('jobs', 'metrics', 'campaign_schedule_ids')}
    summary['partner_job_count'] = len(plan['jobs'])
    summary['engaged_visits_in_sample'] = sum(row['engaged'] for row in plan['metrics'].values())
    if args.apply:
        if plan.get('applied_at'):
            summary['status'] = 'already_applied'
            print(json.dumps(summary, indent=2, sort_keys=True))
            return
        if not existing:
            rows = client.db('POST', 'amplr_data', payload={
                'user_id': submit.OWNER_ID, 'key': key, 'value': plan,
            })
            if len(rows) != 1:
                raise RuntimeError('Could not store the daily plan')
        summary['jobs_inserted'] = apply_plan(client, plan, schedules)
        plan['applied_at'] = datetime.now(timezone.utc).isoformat()
        updated = client.db('PATCH', 'amplr_data', {
            'user_id': 'eq.' + submit.OWNER_ID, 'key': 'eq.' + key,
        }, {'value': plan, 'updated_at': plan['applied_at']})
        if len(updated) != 1:
            raise RuntimeError('Daily plan applied but status could not be saved')
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
