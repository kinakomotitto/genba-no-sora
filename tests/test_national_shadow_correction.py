"""Offline-only checks of national collection, shadow backtest and fail-closed guard."""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import three_model_collect as nc
import shadow_correction as sc
import correction_guard as guard
import weather_collection_health as health
from model_verification import MODELS

UTC=dt.timezone.utc
START=dt.datetime(2025,1,1,6,tzinfo=UTC)

def synthetic_matches(day_count=310,stations=2):
    rows=[]
    for day_number in range(day_count):
        when=START+dt.timedelta(days=day_number)
        month=when.month
        season=("冬" if month in (12,1,2) else
                "春" if month in (3,4,5) else
                "夏" if month in (6,7,8) else "秋")
        truth_wind=9.5 if day_number%7==0 else 4.5
        truth_rain=6 if day_number%5==0 else (1.0 if day_number%3==0 else 0.0)
        for sid in range(stations):
            for i,model in enumerate(MODELS):
                rows.append({
                    "station_id":str(11000+sid),"model":model,
                    "valid_at":when.isoformat().replace("+00:00","Z"),
                    "fetched_at":(when-dt.timedelta(hours=6)).isoformat().replace("+00:00","Z"),
                    "lead_h":6,"month":month,"season":season,"region":"東北",
                    "wind_forecast_ms":max(0,truth_wind-(2.0+i*.2)),
                    "wind_observed_ms":truth_wind,
                    "rain_forecast_mm":round(truth_rain*.8,3),
                    "rain_observed_mm":truth_rain,
                    "wind_direction_forecast_deg":300,"wind_direction_observed_deg":300
                })
    return rows

class Tests(unittest.TestCase):
    def test_national_geographic_selection_spreads_not_just_anchors(self):
        anchors=[
            {"id":f"{i+10000}","name":name,"lat":30+i*1.15,"lon":130+i*1.2,
             "wind_ms":1.0,"precipitation_1h_mm":0.0}
            for i,name in enumerate(nc.SITES)
        ]
        extra=[
            {"id":f"{i+20000}","name":f"public_{i}",
             "lat":24+(i%13)*1.65,"lon":125+(i//13)*2.1,
             "wind_ms":1.5,"precipitation_1h_mm":.5}
            for i in range(104)
        ]
        catalog={"source":"jma-amedas-public-homepage-json",
                 "stations":anchors+extra}
        selected=nc.select_public_stations(catalog)
        self.assertEqual(len(selected),nc.MAX_PUBLIC_REFERENCE_STATIONS)
        self.assertTrue(set(nc.SITES).issubset({r["name"] for r in selected}))
        self.assertEqual(selected,nc.select_public_stations(catalog))
        self.assertLessEqual(len(selected)*3*4,nc.MAX_DAILY_SITE_MODEL_UNITS)
        self.assertGreater(max(x["lat"] for x in selected)-min(x["lat"] for x in selected),15)

    def test_dry_run_unhealthy_data_is_not_treated_as_healthy(self):
        now=dt.datetime(2026,11,10,12,tzinfo=UTC)
        obs={"observed_at":"2026-11-10T11:00:00Z","metrics":{"stations":1250}}
        collection={"state":"saved","fetched_at":"2026-11-10T11:30:00Z",
                    "per_model":{m:{"state":"ok"} for m in MODELS}}
        evaluation={"updated_at_utc":"2026-11-10T11:30:00Z"}
        good=health.assess(obs,collection,evaluation,now)
        self.assertEqual(good["state"],"healthy")
        self.assertFalse(good["automatic_correction_enabled"])
        bad=health.assess(obs,dict(collection,per_model={
            "jma_msm":{"state":"ok"},
            "ecmwf_ifs":{"state":"unavailable"}}),evaluation,now)
        self.assertEqual(bad["state"],"degraded")
        self.assertIn("model_coverage_degraded",bad["reasons"])
        stale=health.assess(dict(obs,observed_at="2026-11-09T11:00:00Z"),
                            collection,evaluation,now)
        self.assertIn("observation_missing_or_stale",stale["reasons"])

    def test_health_only_alerts_on_three_consecutive_scheduled_bad_checks(self):
        now=dt.datetime(2026,11,10,12,tzinfo=UTC)
        obs={"observed_at":"2026-11-10T11:00:00Z","metrics":{"stations":1250}}
        bad={"state":"no_forecasts_available","fetched_at":"2026-11-10T11:30:00Z",
             "per_model":{m:{"state":"unavailable"} for m in MODELS}}
        good={"state":"saved","fetched_at":"2026-11-10T11:30:00Z",
              "per_model":{m:{"state":"ok"} for m in MODELS}}
        verification={"updated_at_utc":"2026-11-10T11:30:00Z"}
        former={"assessed_at_utc":"2026-11-10T06:00:00Z",
                "consecutive_degraded_checks":2}
        report=health.assess(obs,bad,verification,now,former)
        self.assertEqual(report["consecutive_degraded_checks"],3)
        self.assertTrue(report["sustained_outage_alert_eligible"])
        healed=health.assess(obs,good,verification,now,report)
        self.assertEqual(healed["consecutive_degraded_checks"],0)
        self.assertFalse(healed["sustained_outage_alert_eligible"])
        old=dict(former,assessed_at_utc="2026-11-09T12:00:00Z")
        gap=health.assess(obs,bad,verification,now,old)
        self.assertEqual(gap["consecutive_degraded_checks"],1)
        self.assertFalse(gap["sustained_outage_alert_eligible"])

    def test_chronological_shadow_uses_unseen_90_days_and_does_not_go_live(self):
        data=synthetic_matches()
        report=sc.trial(data)
        result=report["by_lead"]["6"]
        self.assertEqual(result["split"]["train_days"],220)
        self.assertEqual(result["split"]["holdout_days"],90)
        self.assertEqual(result["status"],"shadow_evaluated")
        self.assertLess(result["wind"]["shadow_mae"],result["wind"]["selected_raw_mae"])
        self.assertLess(result["rain"]["shadow_mae"],result["rain"]["selected_raw_mae"])
        self.assertFalse(report["release_authorized"])
        self.assertFalse(report["automatic_correction_enabled"])
        self.assertIsNone(report["candidate_selected_for_app"])
        self.assertIsNone(report["approved_model_weights"])
        self.assertEqual(report["by_lead"]["12"]["status"],"insufficient_history")

    def test_seasonal_backtest_requires_four_untouched_quarterly_windows(self):
        early=sc.trial(synthetic_matches(550))
        readiness=early["by_lead"]["6"]["rolling_validation"]
        self.assertFalse(readiness["passed"])
        self.assertEqual(readiness["state"],"insufficient_seasonal_evidence")
        enough=sc.trial(synthetic_matches(580))
        rolling=enough["by_lead"]["6"]["rolling_validation"]
        self.assertEqual(rolling["fold_count"],4)
        self.assertEqual(rolling["required_folds"],4)
        self.assertEqual(rolling["independent_days"],580)
        self.assertEqual(len(rolling["seasons_covered"]),4)
        dates=set()
        for fold in rolling["folds"]:
            self.assertLess(fold["training_through"],fold["holdout_from"])
            self.assertLessEqual(fold["holdout_from"],fold["holdout_through"])
            self.assertNotIn(fold["holdout_from"],dates)
            dates.add(fold["holdout_from"])
        self.assertFalse(enough["release_authorized"])
        self.assertFalse(enough["automatic_correction_enabled"])

    def test_guard_rejects_a_single_good_holdout_without_four_seasons(self):
        trial={"mode":"offline_challenger_only","by_lead":{
            "6":{"candidate_passed_holdout":True,
                 "rolling_validation":{"passed":False,"fold_count":1},
                 "wind":{"shadow_candidate_passed_strict_holdout_tests":True},
                 "rain":{"shadow_candidate_passed_strict_holdout_tests":True}}}}
        readiness={"lead_groups":{"6":{"evidence_sufficient_for_candidate_testing":True}}}
        outcome=guard.decide(trial,{"state":"healthy"},readiness)
        self.assertEqual(outcome["shadow_state"],"fallback_to_original_models")
        self.assertFalse(outcome["candidate_lead_time_checks"]["6"])

    def test_no_future_information_leaks_into_calibration(self):
        rows=synthetic_matches()
        cohort=sc.common_cohorts(rows,6)
        train,held,details=sc.chronological_partition(cohort)
        model,_=sc.best_training_model(train,"wind")
        fitted=sc.train_adjustments(train,model,"wind")
        # Mutating only withheld observations must not alter training parameters.
        for group in held:
            for prediction in group.values():
                prediction["wind_observed_ms"]+=90
        train2,held2,_=sc.chronological_partition(cohort)
        fitted2=sc.train_adjustments(train2,model,"wind")
        self.assertEqual(fitted,fitted2)

    def test_fail_closed_guard_rolls_back_shadow_to_original_models(self):
        good_health={"state":"healthy"}
        accepted={"mode":"offline_challenger_only","by_lead":{
            "6":{"candidate_passed_holdout":True,
                 "rolling_validation":{"passed":True,"fold_count":4},
                 "wind":{"shadow_candidate_passed_strict_holdout_tests":True},
                 "rain":{"shadow_candidate_passed_strict_holdout_tests":True}}}}
        readiness={"lead_groups":{"6":{"evidence_sufficient_for_candidate_testing":True}}}
        shadow=guard.decide(accepted,good_health,readiness)
        self.assertEqual(shadow["shadow_state"],"shadow_only_candidate_for_review")
        self.assertFalse(shadow["automatic_correction_enabled"])
        bad=guard.decide(accepted,{"state":"degraded"},readiness,shadow)
        self.assertTrue(bad["shadow_rollback_activated"])
        self.assertEqual(bad["shadow_state"],"fallback_to_original_models")
        self.assertEqual(bad["live_forecast_source"],"original_uncorrected_models")
        no_data=guard.decide({}, {}, {}, shadow)
        self.assertTrue(no_data["shadow_rollback_activated"])
        self.assertFalse(no_data["production_rollout_authorized"])

    def test_missing_one_model_gives_no_shadow_forecasts(self):
        rows=[r for r in synthetic_matches(305) if r["model"]!="icon_seamless"]
        result=sc.trial(rows)
        self.assertEqual(result["by_lead"]["6"]["status"],"insufficient_history")
        self.assertFalse(result["automatic_correction_enabled"])

if __name__=="__main__":
    unittest.main()
