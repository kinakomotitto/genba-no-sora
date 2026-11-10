"""Quality score audit tests: severe wind and heavy precipitation cannot disappear in MAE."""
import datetime as dt
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import forecast_skill_audit as skill
import correction_readiness as cr

UTC=dt.timezone.utc

def entries(ndays=60,missing=False):
    out=[]
    start=dt.datetime(2026,1,1,6,tzinfo=UTC)
    for day in range(ndays):
        when=start+dt.timedelta(days=day)
        for station in ("11001","11002"):
            rain=6.0 if day%6==0 else (0.8 if day%3==0 else 0.0)
            wind=9.0 if day%4==0 else 3.0
            for model in cr.MODELS:
                out.append({
                    "station_id":station,"model":model,
                    "valid_at":when.isoformat(),"fetched_at":(when-dt.timedelta(hours=6)).isoformat(),
                    "region":"北海道","lead_h":6,
                    "wind_forecast_ms":7.0 if day%4==0 else 3.5,
                    "wind_observed_ms":wind,
                    "rain_forecast_mm":0.0 if day%3==0 else rain,
                    "rain_observed_mm":rain,
                    "wind_direction_forecast_deg":359,
                    "wind_direction_observed_deg":1
                })
    if missing:
        out=[x for x in out if x["model"]!="icon_seamless"]
    return out

class TestSkillAudit(unittest.TestCase):
    def test_severe_event_misses_reported_not_hidden_by_overall_accuracy(self):
        report=skill.audit(entries())
        group=report["wind_and_precipitation_scores"]["by_lead"]["6"][0]
        self.assertEqual(group["independent_calendar_days"],60)
        self.assertEqual(group["matched_station_hours"],120)
        self.assertEqual(group["status"],"provisional_only")
        self.assertGreater(group["wind_mae_ms"],0)
        self.assertGreater(group["wind_rmse_ms"],0)
        self.assertEqual(group["wind_direction_mae_deg"],2.0)
        self.assertIsNotNone(group["wind_8ms_event_skill"])
        self.assertEqual(group["wind_8ms_event_skill"]["hits"],0)
        self.assertEqual(group["wind_8ms_event_skill"]["misses"],30)
        self.assertEqual(group["wind_8ms_event_skill"]["detection_rate"],0.0)
        self.assertIsNotNone(group["precipitation_wet_skill"])
        self.assertIsNone(group["precipitation_5mm_skill"])
        self.assertIsNone(report["ranked_winner"])
        self.assertFalse(report["automatic_weights_enabled"])

    def test_month_season_region_and_daynight_views_use_same_records(self):
        result=skill.audit(entries(65))
        scores=result["wind_and_precipitation_scores"]
        self.assertIn("冬",scores["by_season_6h"])
        self.assertIn("春",scores["by_season_6h"])
        self.assertIn("01",scores["by_month_6h"])
        self.assertIn("03",scores["by_month_6h"])
        self.assertIn("北海道",scores["by_region_6h"])
        self.assertIn("昼",scores["by_daynight_6h"])
        self.assertEqual(scores["by_month_6h"]["03"][0]["status"],"insufficient_independent_days")

    def test_missing_one_model_cannot_qualify_any_scoring_cohort(self):
        r=skill.audit(entries(60,missing=True))
        rows=r["wind_and_precipitation_scores"]["by_lead"]["6"]
        self.assertEqual(rows[0]["matched_station_hours"],0)
        self.assertIsNone(rows[0]["wind_mae_ms"])

    def test_no_data_is_not_no_rain_or_no_wind(self):
        r=skill.audit([])
        for entry in r["wind_and_precipitation_scores"]["by_lead"]["6"]:
            self.assertEqual(entry["matched_station_hours"],0)
            self.assertIsNone(entry["precipitation_mae_mm"])
            self.assertIsNone(entry["wind_8ms_event_skill"])

if __name__=="__main__":
    unittest.main()
