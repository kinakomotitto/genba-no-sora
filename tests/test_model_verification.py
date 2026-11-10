"""Synthetic data only: the accuracy evaluator must never need external APIs."""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import model_verification as mv

BASE=dt.datetime(2026,11,1,tzinfo=dt.timezone.utc)
def stamp(t):
    return t.isoformat().replace("+00:00","Z")

def prediction(model,valid,wind=5,rain=0,lead=6,station="31111",direction=359):
    return {"station_id":station,"model":model,"valid_at":stamp(valid),
            "fetched_at":stamp(valid-dt.timedelta(hours=lead)),
            "wind_ms":wind,"precipitation_1h_mm":rain,"wind_direction_deg":direction}

def observation(valid,wind=6,rain=0,station="31111",quality="ok",direction=1):
    return {"station_id":station,"observed_at":stamp(valid),"quality":quality,
            "wind_ms":wind,"precipitation_1h_mm":rain,"wind_direction_deg":direction}

def row(report,model,lead=6):
    return next(r for r in report["rows"] if r["model"]==model and r["lead_h"]==lead)

class EvaluationTest(unittest.TestCase):
    def test_fair_three_model_cohort_and_bias(self):
        forecasts=[]; observations=[]
        for i in range(35):
            valid=BASE+dt.timedelta(hours=i)
            observations.append(observation(valid,wind=7,rain=(1 if i%3==0 else 0)))
            for model,wind in (("jma_msm",5),("ecmwf_ifs",7),("icon_seamless",8)):
                forecasts.append(prediction(model,valid,wind,rain=(1 if i%3==0 else 0)))
        report=mv.evaluate(forecasts,observations)
        self.assertEqual(report["common_three_model_station_hours"]["6"],35)
        self.assertEqual(row(report,"jma_msm")["wind_mae_ms"],2.0)
        self.assertEqual(row(report,"jma_msm")["wind_bias_ms"],-2.0)
        self.assertEqual(row(report,"ecmwf_ifs")["wind_mae_ms"],0.0)
        self.assertEqual(row(report,"icon_seamless")["wind_mae_ms"],1.0)
        self.assertEqual(row(report,"jma_msm")["direction_mae_deg"],2.0)
        self.assertIsNone(report["optimal_model"])
        self.assertFalse(report["auto_correction_enabled"])

    def test_missing_is_not_zero_and_insufficient_does_not_score(self):
        valid=BASE+dt.timedelta(hours=6)
        forecast=prediction("jma_msm",valid)
        forecast.pop("precipitation_1h_mm")
        report=mv.evaluate([forecast],[observation(valid,rain=3)])
        self.assertEqual(row(report,"jma_msm")["wind_samples"],1)
        self.assertEqual(row(report,"jma_msm")["rain_samples"],0)
        self.assertIsNone(row(report,"jma_msm")["wind_mae_ms"])

    def test_no_hindsight_wrong_station_quality_or_accumulation_time(self):
        valid=BASE+dt.timedelta(hours=6)
        f=prediction("jma_msm",valid)
        hindsight=dict(f,fetched_at=stamp(valid+dt.timedelta(minutes=1)))
        wrong_station=observation(valid,station="99999")
        bad_quality=observation(valid,quality="questionable")
        report=mv.evaluate([hindsight],[observation(valid)],min_samples=2)
        self.assertEqual(row(report,"jma_msm")["station_time_matches"],0)
        report=mv.evaluate([f],[wrong_station,bad_quality],min_samples=2)
        self.assertEqual(row(report,"jma_msm")["station_time_matches"],0)
        report=mv.evaluate([f],[observation(valid+dt.timedelta(minutes=7))],min_samples=2)
        self.assertEqual(row(report,"jma_msm")["wind_samples"],1)
        self.assertEqual(row(report,"jma_msm")["rain_samples"],0)

    def test_duplicate_forecast_and_circular_direction(self):
        valid=BASE+dt.timedelta(hours=6)
        f=prediction("jma_msm",valid)
        duplicate=dict(f,wind_ms=8)
        report=mv.evaluate([f,duplicate],[observation(valid)],min_samples=2)
        self.assertEqual(row(report,"jma_msm")["wind_samples"],1)
        self.assertEqual(mv.angle_error(359,1),2)

    def test_rain_miss_is_not_averaged_away(self):
        forecasts=[];observations=[]
        for i in range(31):
            valid=BASE+dt.timedelta(hours=i)
            rain=1 if i%2==0 else 0
            forecasts.append(prediction("icon_seamless",valid,rain=0))
            observations.append(observation(valid,rain=rain))
        result=mv.evaluate(forecasts,observations)
        self.assertEqual(row(result,"icon_seamless")["rain_observed_events"],16)
        self.assertEqual(row(result,"icon_seamless")["rain_missed_events"],16)

if __name__=="__main__":
    unittest.main()
