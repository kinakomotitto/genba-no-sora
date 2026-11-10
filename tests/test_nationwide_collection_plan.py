"""No network calls: validate nationwide scheduling with synthetic station metadata."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import nationwide_collection_plan as np

class CollectionPlanTests(unittest.TestCase):
    def sample_stations(self,n):
        return [
            {"station_id":f"{x:05d}","name":"synthetic","lat":35+x/10000,
             "lon":138+x/10000,"type":"C","elements":"11111111"}
            for x in range(n)
        ]

    def test_jma_degree_minute_coordinates(self):
        self.assertAlmostEqual(np.coordinates([40,30]),40.5)
        with self.assertRaises(ValueError):np.coordinates([40,60])

    def test_read_public_station_metadata(self):
        catalog={"31111":{"kjName":"sample","lat":[40,31.2],"lon":[141,56.1],"alt":26},
                 "99999":{"kjName":"outside","lat":[1,0],"lon":[1,0]}}
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"amedastable.json"
            path.write_text(json.dumps(catalog),encoding="utf-8")
            parsed=np.load_public_station_catalog(path)
            self.assertEqual(len(parsed),1)
            self.assertAlmostEqual(parsed[0]["lat"],40.52)

    def test_nationwide_baseline_each_station_each_model_once(self):
        stations=self.sample_stations(31)
        summary,jobs=np.nationwide_plan(stations,dt.date(2026,11,10),max_jobs=150)
        self.assertEqual(summary["baseline_station_model_jobs"],93)
        self.assertEqual(summary["daily_station_model_jobs"],93)
        self.assertEqual(len(set((x["station_id"],x["model"]) for x in jobs)),93)
        self.assertEqual(set(x["model"] for x in jobs),set(np.MODELS))
        self.assertFalse(summary["data_collection_enabled"])

    def test_focus_every_six_hours_without_exceeding_budget(self):
        stations=self.sample_stations(5)
        summary,jobs=np.nationwide_plan(stations,dt.date(2026,11,10),focus_ids=["00000","00001"],max_jobs=25)
        self.assertEqual(summary["daily_station_model_jobs"],24)
        self.assertEqual(summary["extra_focus_station_count"],1)
        self.assertEqual(summary["focus_not_selected"],1)
        self.assertEqual(len([j for j in jobs if j["station_id"]=="00000"]),12)

    def test_budget_too_small_refuses_false_national_coverage(self):
        with self.assertRaisesRegex(ValueError,"full nationwide baseline"):
            np.nationwide_plan(self.sample_stations(3),dt.date(2026,11,10),max_jobs=8)

    def test_unknown_focus_rejected(self):
        with self.assertRaisesRegex(ValueError,"Unknown focus"):
            np.nationwide_plan(self.sample_stations(1),dt.date(2026,11,10),focus_ids=["not_public"])

    def test_day_rotation(self):
        station="31111"
        a=np.choose_base_slot(station,dt.date(2026,11,10))
        b=np.choose_base_slot(station,dt.date(2026,11,11))
        self.assertEqual((a+1)%4,b)

if __name__=="__main__":
    unittest.main()
