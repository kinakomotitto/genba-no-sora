"""Public research alert decisions are pure and never send during unit tests."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import research_failure_issue as issue

class TestIssueWatch(unittest.TestCase):
    def test_no_alert_before_three_consecutive_bad_checks(self):
        s={"state":"degraded","consecutive_degraded_checks":2,
           "reasons":["model_coverage_degraded"]}
        self.assertEqual(issue.recommended_action(s,[]),("none",None))
        s["consecutive_degraded_checks"]=3
        self.assertEqual(issue.recommended_action(s,[]),("open",None))
        body=issue.issue_body(s)
        self.assertIn("3回",body)
        self.assertIn("3モデルがそろわない",body)
        self.assertNotIn("GPS",body)

    def test_one_open_issue_no_repeat_and_close_only_on_full_recovery(self):
        active={"number":43,"title":issue.TITLE,"state":"OPEN"}
        bad={"state":"degraded","consecutive_degraded_checks":14,
             "reasons":["observation_missing_or_stale"]}
        self.assertEqual(issue.recommended_action(bad,[active]),("none",None))
        healthy={"state":"healthy","consecutive_degraded_checks":0}
        self.assertEqual(issue.recommended_action(healthy,[active]),("close",43))
        self.assertEqual(issue.recommended_action(healthy,[]),("none",None))
        old={"number":43,"title":issue.TITLE,"state":"CLOSED"}
        self.assertEqual(issue.recommended_action(bad,[old]),("open",None))

    def test_untrusted_or_missing_status_does_not_open_issue(self):
        self.assertEqual(issue.recommended_action(None,[]),("none",None))
        self.assertEqual(issue.recommended_action({},[]),("none",None))
        self.assertEqual(issue.recommended_action({
            "state":"degraded","consecutive_degraded_checks":True},[]),("none",None))

if __name__=="__main__":
    unittest.main()
