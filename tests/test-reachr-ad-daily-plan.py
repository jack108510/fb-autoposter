import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('daily_plan', SCRIPTS / 'reachr_ad_daily_plan.py')
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)


class DailyPlanTests(unittest.TestCase):
    def test_incomplete_plan_cannot_pause_campaign(self):
        class Fake:
            def db(self, *args, **kwargs):
                raise AssertionError('No mutation allowed')

        with self.assertRaisesRegex(RuntimeError, 'does not fill'):
            daily.apply_plan(Fake(), {'date': '2026-10-17', 'total_planned': 399}, [])

    def test_apply_pauses_before_reactivating_and_reuses_existing_jobs(self):
        calls = []

        class Fake:
            def db(self, method, table, query=None, payload=None):
                calls.append((method, table, query, payload))
                if method == 'PATCH':
                    return [payload]
                if method == 'GET':
                    return [{'id': 'existing'}]
                raise AssertionError('Existing job should not be inserted twice')

        schedules = [
            {'id': 'remove', 'status': 'active', 'local_time': '09:00:00', 'timezone': 'America/Halifax'},
            {'id': 'restore', 'status': 'paused', 'local_time': '10:00:00', 'timezone': 'America/Halifax'},
        ]
        plan = {'date': '2026-10-17', 'total_planned': 400,
                'campaign_schedule_ids': ['restore'], 'jobs': [{'id': 'existing'}]}
        self.assertEqual(daily.apply_plan(Fake(), plan, schedules), 0)
        self.assertEqual([call[2]['id'] for call in calls[:2]], ['eq.remove', 'eq.restore'])
        self.assertEqual(calls[0][3], {'status': 'paused', 'enabled': False})
        self.assertEqual(calls[1][3]['status'], 'active')


if __name__ == '__main__':
    unittest.main()
