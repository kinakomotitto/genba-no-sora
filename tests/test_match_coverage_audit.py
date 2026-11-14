import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import match_coverage_audit as audit

class TestMatchCoverage(unittest.TestCase):
    def test_separate_archived_and_pending_without_double_counting(self):
        report=audit.summarize({
            "match_archive_progress":{
                "pending_finalization_rows":6,
                "eligible_unarchived_days":0,
                "daily":[
                    {"state":"archived","cohorts_by_lead":{"6":2,"12":1,"24":0}},
                    {"state":"pending_two_day_lag","cohorts_by_lead":{"6":1,"12":1,"24":2}}]},
            "correction_readiness":{"records_archived":9}})
        self.assertEqual(report["archive_rows_reported"],9)
        self.assertEqual(report["pending_finalization_rows"],6)
        self.assertEqual(report["complete_cohorts_by_lead_current_window"],{"6":3,"12":2,"24":2})
        self.assertEqual(report["pending_cohorts_by_lead"],{"6":1,"12":1,"24":2})
        self.assertFalse(report["automatic_correction_enabled"])
