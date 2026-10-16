import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/reachr_ad_optimizer.py'
spec = importlib.util.spec_from_file_location('optimizer', SCRIPT)
optimizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimizer)


class OptimizerTests(unittest.TestCase):
    def test_engagement_requires_evidence_before_retiring_copy(self):
        metrics = {'copy-a': {'engaged': 0, 'attempts': 60}, 'copy-b': {'engaged': 0, 'attempts': 60}}
        self.assertEqual(optimizer.creative_weights(metrics, metrics), {'copy-a': 1.0, 'copy-b': 1.0})
        metrics['copy-b']['engaged'] = 25
        weights = optimizer.creative_weights(metrics, metrics)
        self.assertEqual(weights['copy-a'], 0.0)
        self.assertGreater(weights['copy-b'], 1.0)

    def test_campaign_budget_is_exact_without_editing_approved_groups(self):
        rows = [{'id': str(i), 'message': 'Campaign', 'groups': [{'url': str(i)}] * size}
                for i, size in enumerate((8, 8, 3, 2, 1))]
        chosen = optimizer.select_campaign_schedules(rows, 20, '2026-10-17', {})
        self.assertEqual(sum(len(row['groups']) for row in chosen), 20)
        self.assertEqual(len({row['id'] for row in chosen}), len(chosen))

    def test_pool_shifts_only_with_comparable_visits_and_attempts(self):
        metrics = {'campaign': {'engaged': 3, 'attempts': 100},
                   'partner': {'engaged': 30, 'attempts': 100}}
        self.assertEqual(optimizer.pool_targets(['campaign'], ['partner'], metrics), (150, 250))
        metrics['partner']['engaged'] = 0
        self.assertEqual(optimizer.pool_targets(['campaign'], ['partner'], metrics), (200, 200))

    def test_partner_allocation_balances_copy_and_excludes_campaign_groups(self):
        drafts = [{'external_id': 'a', 'message': 'Ad A', 'audience': 'local'},
                  {'external_id': 'b', 'message': 'Ad B', 'audience': 'local'}]
        groups = [{'group_url': str(i), 'group_name': 'Local'} for i in range(10)]
        assigned = optimizer.allocate_partner_groups(
            groups, drafts, 8, '2026-10-17', {}, lambda name: 'local',
            lambda draft: draft['audience'], lambda group, draft: 0, {'0', '1'})
        urls = [group['group_url'] for rows in assigned.values() for group in rows]
        self.assertEqual(len(urls), 8)
        self.assertEqual(len(set(urls)), 8)
        self.assertEqual([len(assigned[key]) for key in ('a', 'b')], [4, 4])


if __name__ == '__main__':
    unittest.main()
