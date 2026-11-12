"""Offline regression tests: same-time official station temperature contrasts only."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import terrain_temperature_research as tr

JST=dt.timezone(dt.timedelta(hours=9))

def station(i,side):
    return {
        "id":str(30000+i*2+side),
        "name":("低い" if side==0 else "高い")+"観測所"+str(i),
        "lat":28+i*1.25+side*.05,
        "lon":125+i*2.0+side*.05,
        "altitude_m":20 if side==0 else 170,
        "temperature_c":10.0
    }

def example(pair_count=12):
    stations=[station(i,side) for i in range(pair_count) for side in (0,1)]
    return {"source":"jma-amedas-public-homepage-json","observed_at":"2026-11-13T09:00:00+09:00",
            "stations":stations}

def snapshot(d,h,pair_count=12,wind=1.0):
    # On a sample night the higher station is warmer: illustrative contrast,
    # never evidence that any selected user's GPS location was warmer.
    stamp=dt.datetime(2026,11,d,h,0,tzinfo=JST).isoformat()
    rows=[]
    for i in range(pair_count):
        for side in (0,1):
            temp=(10 if side==0 else (12 if h==21 else 8))
            rows.append([station(i,side)["id"],wind,1,0,temp])
    return {"at":stamp,"rows":rows}

class TerrainStudyTests(unittest.TestCase):
    def test_pairs_use_real_public_elevation_no_fake_or_distant_station(self):
        obs=example(2)
        obs["stations"].append({"id":"9999","lat":35,"lon":139,
                                "altitude_m":None,"temperature_c":10})
        obs["stations"].append({"id":"1000","lat":35.1,"lon":139.1,
                                "altitude_m":100,"temperature_c":None})
        rows=tr.eligible_stations(obs)
        self.assertEqual(len(rows),4)
        pairs=tr.choose_pairs(rows)
        self.assertEqual(len(pairs),2)
        self.assertTrue(all(p["elevation_difference_m"]==150.0 for p in pairs))
        self.assertTrue(all(p["distance_km"]<=tr.MAX_PAIR_DISTANCE_KM for p in pairs))

    def test_time_matched_day_night_and_wind_not_guessing_inversion(self):
        data=[snapshot(d,h) for d in range(1,13) for h in (9,21)]
        report=tr.analyze(example(),data,dt.datetime(2026,11,13,tzinfo=dt.timezone.utc))
        self.assertEqual(report["matched_pair_count"],12)
        self.assertEqual(report["distinct_observation_days"],12)
        self.assertEqual(report["by_period"]["day"]["samples"],144)
        self.assertEqual(report["by_period"]["night"]["samples"],144)
        self.assertEqual(report["by_period"]["day"]["matched_timestamps"],12)
        self.assertEqual(report["by_period"]["night"]["matched_timestamps"],12)
        self.assertEqual(report["by_period"]["night_calm"]["samples"],144)
        self.assertEqual(report["by_period"]["night_other_wind"]["samples"],0)
        self.assertEqual(report["by_period"]["night"]["mean_higher_minus_lower_c"],2)
        self.assertEqual(report["by_period"]["day"]["mean_higher_minus_lower_c"],-2)
        self.assertEqual(report["by_period"]["night"]["warmer_higher_share"],1)
        self.assertEqual(report["state"],"exploratory_diagnostics_only")
        self.assertFalse(report["automatic_correction_enabled"])
        self.assertFalse(report["production_forecast_changes"])
        self.assertIn("NOT demonstrated inversion",report["interpretation"])
        self.assertNotIn("gps_latitude",report)

    def test_quality_missing_and_stale_counts_not_marked_sufficient(self):
        good=snapshot(1,21,2)
        bad=snapshot(1,9,2)
        bad["rows"][1][4]=None
        bad["rows"][3][4]=float("nan")
        bad["rows"][0][4]=1000
        study=tr.analyze(example(2),[good,bad])
        self.assertEqual(study["by_period"]["day"]["samples"],0)
        self.assertEqual(study["by_period"]["night"]["samples"],2)
        self.assertEqual(study["state"],"collecting_observations")
        self.assertIsNone(study["by_period"]["day"]["mean_higher_minus_lower_c"])
        self.assertIsNone(study["by_period"]["day"]["warmer_higher_share"])

    def test_archive_is_read_only_output_is_aggregate(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            obs=root/"data"/"amedas"
            obs.mkdir(parents=True)
            (obs/"latest.json").write_text(json.dumps(example()),encoding="utf8")
            rec=obs/"recent"
            rec.mkdir()
            path=rec/"2026-11-12.jsonl"
            src=snapshot(12,21)
            path.write_text(json.dumps(src)+"\n",encoding="utf8")
            original=path.read_bytes()
            result=tr.run(root=root,now=dt.datetime(2026,11,13,tzinfo=dt.timezone.utc))
            self.assertEqual(result["by_period"]["night"]["samples"],12)
            self.assertEqual(original,path.read_bytes(),"raw source records must not be mutated")
            out=root/"data"/"model-validation"/"terrain-temperature-research.json"
            report=json.loads(out.read_text(encoding="utf8"))
            self.assertFalse(report["automatic_correction_enabled"])
            self.assertNotIn("rows",report)
            self.assertNotIn("endpoint",report)
            self.assertEqual(report["matched_pair_count"],12)

    def test_old_snapshots_without_station_elevation_fail_closed(self):
        snap=example(2)
        for p in snap["stations"]:p.pop("altitude_m")
        report=tr.analyze(snap,[snapshot(1,9,2)])
        self.assertEqual(report["matched_pair_count"],0)
        self.assertEqual(report["by_period"]["day"]["samples"],0)
        self.assertEqual(report["state"],"collecting_observations")

if __name__=="__main__":
    unittest.main()
