import hashlib
import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/reachr-partner-submit-server.py'
spec = importlib.util.spec_from_file_location('reachr_partner_submit', SCRIPT)
submit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(submit)


class PartnerSubmitTests(unittest.TestCase):
    def test_accepts_only_draft_fields(self):
        item = submit.validate_submission({
            'title': 'Weekend offer', 'message': 'Local draft',
            'destination_url': 'https://wildroseautomations.ca/book', 'external_id': 'offer-1',
        })
        self.assertEqual(item['message'], 'Local draft')
        with self.assertRaisesRegex(ValueError, 'external_id is required'):
            submit.validate_submission({'title': 'Offer', 'message': 'Draft'})
        for forbidden in ('groups', 'status', 'schedule', 'identity_name'):
            with self.assertRaisesRegex(ValueError, 'Unsupported fields'):
                submit.validate_submission({'title': 'Offer', 'message': 'Draft', 'external_id': 'offer-2', forbidden: 'value'})
        with self.assertRaisesRegex(ValueError, 'HTTPS URL'):
            submit.validate_submission({'title': 'Offer', 'message': 'Draft', 'external_id': 'offer-3', 'image_url': 'javascript:alert(1)'})

    def test_submission_enters_daily_test_and_reports_asset_failure(self):
        draft = {'title': 'Offer', 'message': 'Draft', 'external_id': 'test-auto',
                 'created_at': '2026-10-16T12:00:00+00:00'}

        class FakeHandler:
            def response(self, status, body):
                return status, body

        fake = FakeHandler()
        with patch.object(submit, 'technical_checks', return_value={'ok': True}):
            status, result = submit.Handler.finish_submission(fake, draft, 'draft-1', draft)
        self.assertEqual((status, result['status']), (201, 'accepted_for_daily_test'))
        self.assertIn(submit.DEFAULT_ROSE_LINK, result['posting_message'])
        with patch.object(submit, 'technical_checks', return_value={'ok': False, 'media': 'unsupported_video'}):
            status, result = submit.Handler.finish_submission(fake, draft, 'draft-1', draft, duplicate=True)
        self.assertEqual((status, result['status']), (200, 'needs_asset'))

    def test_key_auth_and_idempotency(self):
        key = 'rsub_test_key'
        digest = hashlib.sha256(key.encode()).hexdigest()
        self.assertTrue(submit.authorized('Bearer ' + key, digest))
        self.assertFalse(submit.authorized('Bearer wrong', digest))
        self.assertFalse(submit.authorized(None, digest))
        draft = submit.validate_submission({'title': 'Offer', 'message': 'Draft', 'external_id': 'same-id'})
        self.assertEqual(submit.submission_key(draft), submit.submission_key(draft))
        self.assertTrue(submit.same_submission(draft, draft))
        self.assertFalse(submit.same_submission({**draft, 'message': 'Changed'}, draft))

    def test_publish_uses_stored_id_and_campaign_audience(self):
        self.assertEqual(submit.publish_request({'action': 'publish', 'external_id': 'wildrose-ads-3'}), 'wildrose-ads-3')
        with self.assertRaises(ValueError):
            submit.publish_request({'action': 'publish', 'external_id': 'wildrose-ads-3', 'group_urls': ['https://example.com']})
        self.assertEqual(submit.publish_job_id('wildrose-ads-3'), submit.publish_job_id('wildrose-ads-3'))
        self.assertEqual(submit.suggested_audience({'external_id': 'wildrose-ads-3'}), 'agency')
        self.assertEqual(submit.suggested_audience({'external_id': 'wildrose-ads-5'}), 'promotion')
        self.assertEqual(submit.suggested_audience({'external_id': 'wildrose-ads-1'}), 'local')

    def test_group_mapping_excludes_campaign_and_recent_targets(self):
        now = datetime(2026, 10, 16, 15, tzinfo=timezone.utc)
        schedules = [{'name': 'Rose · agency · batch 01', 'groups': [{'url': 'https://fb/active'}],
                      'next_at': (now + timedelta(hours=2)).isoformat()}]
        inventory = [
            {'group_url': 'https://fb/active', 'group_name': 'Canada Web Design', 'identity_key': 'wildrose automations'},
            {'group_url': 'https://fb/eligible', 'group_name': 'Canada Web Design Business', 'identity_key': 'wildrose automations'},
            {'group_url': 'https://fb/recent', 'group_name': 'Web Design Agency', 'identity_key': 'wildrose automations',
             'last_posted_at': (now - timedelta(days=1)).isoformat()},
            {'group_url': 'https://fb/wrong', 'group_name': 'Web Design Agency', 'identity_key': 'vet inc'},
            {'group_url': 'https://fb/busy', 'group_name': 'Web Design Agency', 'identity_key': 'wildrose automations'},
        ]
        jobs = [{'groups': [{'url': 'https://fb/busy'}]}]
        result = submit.select_campaign_groups(schedules, inventory, jobs, 'agency', now)
        self.assertEqual([group['url'] for group in result], ['https://fb/eligible'])
        self.assertEqual(submit.next_partner_slot(schedules, [], now), now + timedelta(hours=2, minutes=15))

    def test_group_outcome_counts(self):
        job = {'result': {'results': [{'status': 'posted'}, {'status': 'pending_approval', 'success': True},
                                      {'status': 'failed'}, {'status': 'submitted_unconfirmed'}]}}
        self.assertEqual(submit.outcome_counts(job), {
            'posted': 1, 'pending_approval': 1, 'unconfirmed': 1, 'failed': 1,
        })

    def test_supabase_timestamps_with_short_fraction(self):
        self.assertEqual(submit.parse_time('2026-10-08T18:42:35.6+00:00').microsecond, 600000)
        self.assertEqual(submit.parse_time('2026-10-08T18:42:35.09455+00:00').microsecond, 94550)

    def test_video_cover_cannot_be_published_as_video(self):
        checks = submit.technical_checks({'notes': 'VIDEO post. Ask for the full-quality video before posting.'})
        self.assertEqual(checks['media'], 'video_not_supported_by_reachr_post_jobs')
        self.assertFalse(checks['ok'])
        poll = submit.technical_checks({'notes': 'Use the poll feature if available.'})
        self.assertEqual(poll['media'], 'text_poll_only')
        self.assertTrue(poll['ok'])

    def test_linkless_copy_gets_a_measurable_rose_link(self):
        message = submit.posting_message({'message': 'What would help your team most?', 'destination_url': None})
        self.assertIn(submit.DEFAULT_ROSE_LINK, message)
        self.assertEqual(submit.posting_message({'message': 'Visit https://wildroseautomations.ca/rose',
                                                 'destination_url': None}),
                         'Visit https://wildroseautomations.ca/rose')

    def test_publish_queues_only_stored_copy_to_mapped_groups(self):
        draft = {'title': 'For web designers', 'message': 'Exact approved draft copy',
                 'image_url': 'https://i.imgur.com/ad.png', 'destination_url': 'https://wildroseautomations.ca',
                 'external_id': 'test-designers', 'status': 'submitted'}
        schedule = {'name': 'Rose · agency · batch 01', 'groups': [{'url': 'https://fb/active'}],
                    'next_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        inventory = [{'group_url': f'https://fb/eligible-{i}', 'group_name': f'Canada Web Designer Group {i}',
                      'identity_key': 'wildrose automations', 'ban_risk': 'low', 'removal_count': 0}
                     for i in range(3)]

        class FakeHandler:
            def __init__(self):
                self.inserted = None

            def response(self, status, body):
                return status, body

            def db(self, method, path, payload=None):
                if method == 'PATCH':
                    return [payload]
                if method == 'POST':
                    self.inserted = payload
                    return [payload]
                if path.startswith('jsw_post_jobs?') and 'id=eq.' in path:
                    return []
                if path.startswith('amplr_data?'):
                    return [{'value': draft}]
                if path.startswith('reachr_campaign_schedules?'):
                    return [schedule]
                if path.startswith('jsw_groups?'):
                    return inventory
                if path.startswith('jsw_post_jobs?'):
                    return []
                raise AssertionError(path)

        fake = FakeHandler()
        with patch.object(submit, 'technical_checks', return_value={'ok': True, 'image': 'ok', 'destination': 'ok'}):
            status, body = submit.Handler.publish(fake, {'action': 'publish', 'external_id': 'test-designers'})
        self.assertEqual(status, 201)
        self.assertEqual(fake.inserted['message'],
                         'Exact approved draft copy\n\nSee how Rose works: https://wildroseautomations.ca')
        self.assertEqual(fake.inserted['identity_name'], 'Wildrose Automations')
        self.assertEqual(len(fake.inserted['groups']), 3)
        self.assertEqual(body['group_count'], 3)


if __name__ == '__main__':
    unittest.main()
