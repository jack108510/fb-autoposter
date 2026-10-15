import hashlib
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/reachr-partner-submit-server.py'
spec = importlib.util.spec_from_file_location('reachr_partner_submit', SCRIPT)
submit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(submit)


class PartnerSubmitTests(unittest.TestCase):
    def test_accepts_only_draft_fields(self):
        item = submit.validate_submission({
            'title': 'Weekend offer', 'message': 'Local draft',
            'destination_url': 'https://example.com/book', 'external_id': 'offer-1',
        })
        self.assertEqual(item['message'], 'Local draft')
        for forbidden in ('groups', 'status', 'schedule', 'identity_name'):
            with self.assertRaisesRegex(ValueError, 'Unsupported fields'):
                submit.validate_submission({'title': 'Offer', 'message': 'Draft', forbidden: 'value'})
        with self.assertRaisesRegex(ValueError, 'HTTPS URL'):
            submit.validate_submission({'title': 'Offer', 'message': 'Draft', 'image_url': 'javascript:alert(1)'})

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


if __name__ == '__main__':
    unittest.main()
