import datetime as dt
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import schedule_delay_audit as audit

UTC=dt.timezone.utc
class TestScheduleDelay(unittest.TestCase):
    def test_on_time(self):
        start=dt.datetime(2026,11,12,6,14,tzinfo=UTC)
        report=audit.diagnose(start)
        self.assertEqual(report["state"],"on_time")
        self.assertEqual(report["delay_minutes"],2)
    def test_late_and_day_boundary(self):
        start=dt.datetime(2026,11,12,1,25,tzinfo=UTC)
        report=audit.diagnose(start)
        self.assertEqual(report["state"],"late")
        self.assertEqual(report["expected_at_utc"],"2026-11-12T00:12:00+00:00")
        self.assertEqual(report["delay_minutes"],73)
    def test_distinguish_creation_delay_and_queue_wait(self):
        started=dt.datetime(2026,11,14,7,1,tzinfo=UTC)
        created=dt.datetime(2026,11,14,6,57,tzinfo=UTC)
        report=audit.diagnose(started,created=created)
        self.assertEqual(report["state"],"late")
        self.assertEqual(report["created_after_slot_minutes"],45)
        self.assertEqual(report["queue_wait_minutes"],4)
    def test_manual_is_not_a_scheduled_failure(self):
        self.assertEqual(audit.diagnose(dt.datetime.now(UTC),False)["state"],"not_scheduled")
