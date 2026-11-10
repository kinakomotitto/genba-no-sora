"""Fully synthetic, offline tests: no weather API calls or private user data."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import three_model_collect as tc
import score_amedas_models as sm

UTC=dt.timezone.utc
NOW=dt.datetime(2026,11,10,0,20,tzinfo=UTC)

def stations():
    return [{"id":str(11000+i),"name":name,"lat":35.0+i/3,"lon":137.0+i/3,
             "wind_ms":2,"precipitation_1h_mm":0}
            for i,name in enumerate(tc.SITES)]

def snap():
    return {"source":"jma-amedas-public-homepage-json","stations":stations()}

def fake_model(model,site_list):
    times=[(dt.datetime(2026,11,10,tzinfo=UTC)+dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M")
           for h in range(0,48)]
    return [{"latitude":s["lat"],"longitude":s["lon"],"hourly":{
        "time":times,"wind_speed_10m":[2.5]*len(times),
        "wind_direction_10m":[270]*len(times),
        "precipitation":[0.0]*len(times)
    }} for s in site_list]

class TestNationwidePilot(unittest.TestCase):
    def test_public_station_only_and_batch_count(self):
        self.assertEqual(len(tc.select_public_stations(snap())),len(tc.SITES))
        self.assertEqual(tc.forecast_targets(NOW),{
            "2026-11-10T06:00":"2026-11-10T06:00:00Z",
            "2026-11-10T12:00":"2026-11-10T12:00:00Z",
            "2026-11-11T00:00":"2026-11-11T00:00:00Z"})
        collected=tc.parse_forecast("jma_msm",stations(),fake_model("jma_msm",stations()),NOW)
        self.assertEqual(len(collected),27)
        self.assertEqual(collected[0]["precipitation_1h_mm"],0.0)
        self.assertEqual(collected[0]["fetched_at"],"2026-11-10T00:20:00Z")
        self.assertTrue(all(dt.datetime.fromisoformat(r["fetched_at"].replace("Z","+00:00")) <
                            dt.datetime.fromisoformat(r["valid_at"].replace("Z","+00:00"))
                            for r in collected))

    def test_model_failure_is_visible_and_not_imputed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            inp=root/"amedas.json";inp.write_text(json.dumps(snap()),encoding="utf-8")
            calls=[]
            def fake(model,sites):
                calls.append(model)
                if model=="icon_seamless":raise RuntimeError("Simulated unavailable model")
                return fake_model(model,sites)
            result=tc.collect(inp,root/"model-validation",fake,lambda:NOW)
            self.assertEqual(len(calls),3)
            self.assertEqual(result["forecast_rows_saved"],54)
            self.assertEqual(result["per_model"]["icon_seamless"]["state"],"unavailable")
            self.assertEqual(result["state"],"saved")
            self.assertEqual(len(tc.jsonl if hasattr(tc,"jsonl") else
                (root/"model-validation"/"forecasts"/"2026-11-10.jsonl").read_text().splitlines()),54)
            result2=tc.collect(inp,root/"model-validation",fake,lambda:NOW)
            self.assertEqual(result2["state"],"saved")
            self.assertEqual(len((root/"model-validation"/"forecasts"/"2026-11-10.jsonl").read_text().splitlines()),54)

    def test_split_nationwide_requests_and_preserve_partial_results(self):
        initial=stations()
        extras=[]
        for i in range(65):
            extras.append({
                "id":str(20000+i),"name":"公開観測所"+str(i),
                "lat":25+(i%12)*1.5,"lon":126+(i//12)*2.7,
                "wind_ms":2.0,"precipitation_1h_mm":0.1
            })
        snapshot={"source":"jma-amedas-public-homepage-json",
                  "stations":initial+extras}
        chosen=tc.select_public_stations(snapshot)
        self.assertEqual(len(chosen),36)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            origin=root/"amedas.json"
            origin.write_text(json.dumps(snapshot),encoding="utf-8")
            output=root/"output"
            output.mkdir()
            (output/"collection-status.json").write_text(json.dumps({
                "selected_station_count":27,"state":"saved",
                "per_model":{model:{"state":"ok"} for model in tc.MODELS}
            }),encoding="utf-8")
            queries=[]
            def bounded(model,subset):
                queries.append((model,len(subset)))
                if model=="icon_seamless" and subset[0]["name"] not in tc.SITES:
                    raise RuntimeError("one chunk of stations unavailable")
                return fake_model(model,subset)
            state=tc.collect(origin,root/"output",bounded,lambda:NOW)
            self.assertEqual(state["selected_station_count"],36)
            self.assertEqual(state["calls_attempted"],12)
            self.assertTrue(all(n<=9 for _,n in queries))
            self.assertEqual(state["per_model"]["jma_msm"]["state"],"ok")
            self.assertEqual(state["per_model"]["ecmwf_ifs"]["state"],"ok")
            self.assertEqual(state["per_model"]["icon_seamless"]["state"],"partial")
            self.assertEqual(state["per_model"]["icon_seamless"]["stations_successful"],9)
            self.assertTrue(state["forecast_rows_saved"]>200)
            self.assertEqual(state["daily_site_model_units_estimate"],432)

    def test_adaptive_recovery_restarts_with_9_sites_after_failing_at_36(self):
        self.assertEqual(tc.adaptive_station_target(None),9)
        previous={
            "selected_station_count":36,
            "state":"no_forecasts_available",
            "per_model":{m:{"state":"unavailable"} for m in tc.MODELS}
        }
        self.assertEqual(tc.adaptive_station_target(previous),9)
        previous["state"]="saved"
        previous["per_model"]={m:{"state":"ok"} for m in tc.MODELS}
        self.assertEqual(tc.adaptive_station_target(previous),36)
        previous["selected_station_count"]=9
        self.assertEqual(tc.adaptive_station_target(previous),18)

    def test_public_source_required(self):
        with self.assertRaises(ValueError):
            tc.select_public_stations({"source":"private-field","stations":stations()})

    def test_direction_and_observation_matching(self):
        self.assertIsNone(sm.wind_direction(0))
        self.assertEqual(sm.wind_direction(16),0)
        self.assertEqual(sm.wind_direction(1),22.5)
        self.assertEqual(sm.wind_direction(12),270)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);obs=root/"recent";obs.mkdir()
            (obs/"2026-11-10.jsonl").write_text(json.dumps({
                "at":"2026-11-10T15:00:00+09:00",
                "rows":[["11000",2.0,16,0.0,5.0],
                        ["11001",None,None,None,None]]})+"\n",encoding="utf-8")
            parsed=sm.read_observations(obs)
            self.assertEqual(len(parsed),2)
            self.assertEqual(parsed[0]["wind_direction_deg"],0)
            self.assertEqual(parsed[0]["precipitation_1h_mm"],0)
            self.assertIsNone(parsed[1]["wind_ms"])

    def test_evaluation_reports_only_no_optimisation(self):
        f=[]
        o=[]
        for h in range(36):
            valid=NOW+dt.timedelta(hours=6+h*6)
            obs=valid.isoformat().replace("+00:00","Z")
            o.append({"station_id":"11000","observed_at":obs,"quality":"ok",
                      "wind_ms":6,"precipitation_1h_mm":0.5,"wind_direction_deg":0})
            for model in tc.MODELS:
                f.append({"station_id":"11000","model":model,"valid_at":obs,
                          "fetched_at":(valid-dt.timedelta(hours=6)).isoformat().replace("+00:00","Z"),
                          "wind_ms":5,"wind_direction_deg":0,"precipitation_1h_mm":0.5})
        result=sm.score(f,o,NOW)
        self.assertEqual(result["state"],"provisional_diagnostics")
        self.assertEqual(result["common_three_model_station_hours"]["6"],36)
        self.assertFalse(result["auto_correction_enabled"])
        self.assertIsNone(result["optimal_model"])

if __name__=="__main__":
    unittest.main()
