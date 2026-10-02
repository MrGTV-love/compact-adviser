import concurrent.futures
from pathlib import Path
import tempfile
import unittest

from start_gated import claim_start


class StartClaimTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.stamp = Path(self.directory.name) / "last-start"
        self.stamp.write_text("1000\n")

    def claim(self, now, load=20, free=35):
        return claim_start(self.stamp, now, load, free, 70, 20, 120)

    def test_accepted_start_advances_shared_clock_and_blocks_close_followup(self):
        first = self.claim(1120)
        self.assertEqual(first["recorded_shared_start"], 1120)
        self.assertEqual(self.stamp.read_text(), "1120\n")
        self.assertFalse(self.claim(1148)["ready"])
        self.assertFalse(self.claim(1136)["ready"])
        self.assertEqual(self.stamp.read_text(), "1120\n")
        self.assertTrue(self.claim(1240)["ready"])
        self.assertEqual(self.stamp.read_text(), "1240\n")

    def test_resource_boundaries_do_not_consume_start(self):
        self.assertFalse(self.claim(1120, load=70)["ready"])
        self.assertFalse(self.claim(1120, free=19)["ready"])
        self.assertEqual(self.stamp.read_text(), "1000\n")
        self.assertTrue(self.claim(1120, load=69.99, free=20)["ready"])

    def test_unreadable_clock_is_not_an_eligible_fallback(self):
        self.stamp.unlink()
        with self.assertRaises(FileNotFoundError):
            self.claim(1120)
        self.stamp.write_text("not an epoch\n")
        with self.assertRaises(ValueError):
            self.claim(1120)
        self.assertEqual(self.stamp.read_text(), "not an epoch\n")

    def test_simultaneous_claims_share_one_actual_start(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(self.claim, [1120, 1120]))
        self.assertEqual(sum(result["ready"] for result in results), 1)
        self.assertEqual(self.stamp.read_text(), "1120\n")


if __name__ == "__main__":
    unittest.main()
