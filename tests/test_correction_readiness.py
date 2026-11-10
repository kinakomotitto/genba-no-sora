"""Synthetic no-network quality gates. No user's location or weather data."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import correction_readiness as cr

UTC=dt.timezone.utc
START=dt.datetime(2025,1,1,6,tzinfo=UTC)

def pair_rows(day_count,stations=5,models=cr.MODELS):
    rows=[]
    for day_no in range(day_count):
        valid=START+dt.timedelta(days=day_no)
        rain=1.2 if day_no%4==0 else 0
        wind=10.5 if day_no%5==0 else 4
        for s in range(stations):
            for model in models:
                rows.append({
                   "station_id":f"{s+11000}","region":"東北" if s<2 else "関東",
                   "model":model,"valid_at":valid.isoformat().replace("+00:00","Z"),
                   "fetched_at":(valid-dt.timedelta(hours=6)).isoformat().replace("+00:00","Z"),
                   "lead_h":6,
                   "wind_forecast_ms":wind-.5,"wind_observed_ms":wind,
                   "rain_forecast_mm":rain,"rain_observed_mm":rain,
                   "wind_direction_forecast_deg":270,"wind_direction_observed_deg":270
                })
    return rows

class CorrectionGateTests(unittest.TestCase):
    def test_no_data_never_activates_correction(self):
        result=cr.report([])
        self.assertFalse(result["automatic_correction_enabled"])
        self.assertFalse(result["forecast_correction_release_authorized"])
        for value in result["lead_groups"].values():
            self.assertFalse(value["evidence_sufficient_for_candidate_testing"])
            self.assertFalse(value["candidate_accepted"])
            self.assertGreater(len(value["missing_requirements"]),0)

    def test_independent_dates_not_inflated_by_many_stations_or_models(self):
        rows=pair_rows(5,stations=20)
        r=cr.report(rows)["lead_groups"]["6"]
        self.assertEqual(r["coverage"]["independent_days"],5)
        self.assertEqual(r["coverage"]["matched_common_hours"],100)
        self.assertFalse(r["evidence_sufficient_for_candidate_testing"])

    def test_months_seasons_and_historical_span_are_real(self):
        rows=pair_rows(550,stations=5)
        result=cr.report(rows)
        coverage=result["lead_groups"]["6"]["coverage"]
        self.assertEqual(coverage["independent_days"],550)
        self.assertEqual(coverage["calendar_months"],12)
        self.assertEqual(coverage["seasons"],4)
        self.assertEqual(coverage["reference_stations"],5)
        self.assertGreaterEqual(coverage["wet_days"],45)
        self.assertGreaterEqual(coverage["strong_holdout_days"],5)
        self.assertEqual(result["lead_groups"]["6"]["missing_requirements"],[])
        self.assertTrue(result["lead_groups"]["6"]["evidence_sufficient_for_candidate_testing"])
        self.assertFalse(result["lead_groups"]["6"]["candidate_accepted"])
        self.assertFalse(result["automatic_correction_enabled"])
        # A fully covered 6-hour bucket does not promote an unobserved 12-hour bucket.
        self.assertFalse(result["lead_groups"]["12"]["evidence_sufficient_for_candidate_testing"])

    def test_only_same_public_station_and_hour_not_later_forecast(self):
        valid=START
        obj={"station_id":"11000","model":"jma_msm",
             "fetched_at":(valid-dt.timedelta(hours=6)).isoformat(),
             "valid_at":valid.isoformat(),
             "wind_ms":3.0,"precipitation_1h_mm":0,
             "wind_direction_deg":355}
        obs={"station_id":"11000","observed_at":valid.isoformat(),
             "quality":"ok","wind_ms":4.0,"precipitation_1h_mm":0,
             "wind_direction_deg":2}
        rows=cr.observation_matches([obj],[obs],{"11000":"青森"})
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["region"],"東北")
        self.assertEqual(rows[0]["rain_observed_mm"],0)
        self.assertEqual(rows[0]["lead_h"],6)
        self.assertEqual(rows[0]["wind_direction_forecast_deg"],355)
        too_late=dict(obj,fetched_at=(valid+dt.timedelta(minutes=1)).isoformat())
        self.assertEqual(cr.observation_matches([too_late],[obs]),[])
        self.assertEqual(cr.observation_matches([obj],[dict(obs,quality="suspect")]),[])
        self.assertEqual(cr.observation_matches([obj],[dict(obs,station_id="99999")]),[])

    def test_different_model_issue_hours_or_observations_do_not_form_common_cohort(self):
        base=pair_rows(1,stations=1)
        self.assertEqual(len(cr.common_cohorts(base,6)),1)
        later=[dict(x) for x in base]
        later[-1]["fetched_at"]=(START-dt.timedelta(hours=6,minutes=40)).isoformat()
        self.assertEqual(len(cr.common_cohorts(later,6)),0)
        inconsistent=[dict(x) for x in base]
        inconsistent[-1]["wind_observed_ms"]+=1
        self.assertEqual(len(cr.common_cohorts(inconsistent,6)),0)
        inconsistent=[dict(x) for x in base]
        inconsistent[-1]["rain_observed_mm"]+=0.1
        self.assertEqual(len(cr.common_cohorts(inconsistent,6)),0)

    def test_incomplete_rain_or_wind_does_not_count_as_three_model_coverage(self):
        records=pair_rows(550,stations=5)
        for row in records:
            if row["model"]=="icon_seamless":
                row["rain_forecast_mm"]=None
        r=cr.report(records)["lead_groups"]["6"]
        self.assertEqual(r["coverage"]["matched_common_hours"],0)
        self.assertFalse(r["evidence_sufficient_for_candidate_testing"])

    def test_daily_archive_compressed_after_two_day_lag_and_immutable(self):
        now=dt.datetime(2026,11,10,10,tzinfo=UTC)
        when=dt.datetime(2026,11,8,6,tzinfo=UTC)
        rows=[]
        for station in range(5):
            for model in cr.MODELS:
                rows.append({
                    "station_id":str(11000+station),"model":model,
                    "valid_at":when.isoformat().replace("+00:00","Z"),
                    "fetched_at":(when-dt.timedelta(hours=6)).isoformat().replace("+00:00","Z"),
                    "lead_h":6,"wind_forecast_ms":4,"wind_observed_ms":5,
                    "rain_forecast_mm":0,"rain_observed_mm":0
                })
        with tempfile.TemporaryDirectory() as path:
            archive=Path(path)
            self.assertEqual(cr.archive_matches(rows,archive,now),15)
            self.assertEqual(cr.archive_matches(rows,archive,now),0)
            self.assertEqual(len(cr.read_archive(archive)),15)
            self.assertEqual(len(list(archive.glob("*.jsonl.gz"))),1)
            self.assertEqual(cr.report(cr.read_archive(archive))["records_archived"],15)
            # Do not freeze yesterday or today, to permit late observations.
            yesterday=[dict(r,valid_at="2026-11-09T06:00:00Z") for r in rows]
            self.assertEqual(cr.archive_matches(yesterday,archive,now),0)
            self.assertEqual(len(cr.read_archive(archive)),15)

    def test_missing_one_model_does_not_claim_common_samples(self):
        groups=pair_rows(550,stations=5,models=("jma_msm","ecmwf_ifs"))
        result=cr.report(groups)
        self.assertEqual(result["lead_groups"]["6"]["coverage"]["matched_common_hours"],0)
        self.assertFalse(result["automatic_correction_enabled"])

if __name__=="__main__":
    unittest.main()
