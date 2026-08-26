#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts" / "reachrctl.py"
spec = importlib.util.spec_from_file_location("reachrctl", MODULE)
reachrctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reachrctl)


class ReachrCtlTests(unittest.TestCase):
    def test_classifies_supabase_522_as_degraded_not_healthy(self):
        status = reachrctl.classify_http_result("rest", ok=False, status=522, body="error code: 522")
        self.assertEqual(status["state"], "degraded")
        self.assertIn("522", status["detail"])
        self.assertFalse(status["ok"])

    def test_snapshot_is_sanitized_and_contains_minimum_run_state(self):
        raw = {
            "user": {"id": "u1", "email": "jack@example.com"},
            "posts": [
                {"id": "p1", "enabled": True, "text": "hello", "groups": [{"url": "https://facebook.com/groups/1", "name": "NYC Pet Owners", "identity_name": "Empty Slot"}], "identity_name": "Empty Slot"}
            ],
            "groups": [{"url": "https://facebook.com/groups/1", "name": "NYC Pet Owners", "identity_name": "Empty Slot"}],
            "postingIdentities": [{"name": "Empty Slot", "secret": "do-not-keep", "accessToken": "token"}],
            "settings": {"delay": 120, "apiKey": "secret"},
            "session": {"accessToken": "secret", "refreshToken": "secret"},
        }
        snap = reachrctl.build_snapshot(raw, source="test")
        text = json.dumps(snap)
        self.assertIn("campaigns", snap)
        self.assertIn("groups", snap)
        self.assertIn("posting_identities", snap)
        self.assertIn("created_at", snap)
        self.assertNotIn("accessToken", text)
        self.assertNotIn("refreshToken", text)
        self.assertNotIn("apiKey", text)
        self.assertEqual(snap["campaigns"][0]["identity_name"], "Empty Slot")

    def test_local_queue_job_uses_safe_extension_shape(self):
        campaign = {
            "id": "p1",
            "text": "A careful post",
            "identity_name": "Empty Slot",
            "groups": [{"url": "https://facebook.com/groups/1", "name": "NYC Pet Owners", "identity_name": "Empty Slot"}],
            "ai_enabled": False,
            "first_comment": "",
        }
        job = reachrctl.build_local_fallback_job(campaign, user_id="u1", due_now=True)
        self.assertTrue(job["local_fallback"])
        self.assertEqual(job["status"], "pending")
        self.assertEqual(job["user_id"], "u1")
        self.assertEqual(job["identity_name"], "Empty Slot")
        self.assertEqual(job["groups"][0]["identity_name"], "Empty Slot")
        self.assertFalse(job["ai_enabled"])
        self.assertIn("local_reachr_", job["id"])

    def test_empty_slot_filter_rejects_lost_pet_rescue_and_wrong_actor(self):
        good = {"name": "Chicago Pet Owners", "url": "https://facebook.com/groups/good", "identity_name": "Empty Slot"}
        lost = {"name": "Lost Pets Chicago", "url": "https://facebook.com/groups/lost", "identity_name": "Empty Slot"}
        rescue = {"name": "Dog Rescue and Adoption", "url": "https://facebook.com/groups/rescue", "identity_name": "Empty Slot"}
        wrong_actor = {"name": "Phoenix Pet Owners", "url": "https://facebook.com/groups/wrong", "identity_name": "Jack Sereda"}
        allowed, rejected = reachrctl.filter_groups_for_campaign([good, lost, rescue, wrong_actor], actor="Empty Slot", campaign="empty-slot-pet-owner-groups")
        self.assertEqual([g["url"] for g in allowed], [good["url"]])
        reasons = {r["group"]["url"]: r["reason"] for r in rejected}
        self.assertEqual(reasons[lost["url"]], "excluded_lost_pet_or_rescue")
        self.assertEqual(reasons[rescue["url"]], "excluded_lost_pet_or_rescue")
        self.assertEqual(reasons[wrong_actor["url"]], "wrong_actor")

    def test_snapshot_store_keeps_latest_pointer(self):
        with tempfile.TemporaryDirectory() as td:
            store = reachrctl.SnapshotStore(Path(td))
            path = store.save({"created_at": "2026-01-01T00:00:00Z", "campaigns": [], "groups": []})
            self.assertTrue(path.exists())
            self.assertEqual(store.latest().read_text(), path.read_text())


if __name__ == "__main__":
    unittest.main()
