"""Offline synthetic verification of nationwide AMeDAS parser; zero HTTP traffic."""
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import amedas_snapshot as am

class AmedasTests(unittest.TestCase):
    def data(self,n=210):
        cat={}
        raw={}
        for i in range(n):
            key=str(11000+i)
            cat[key]={"lat":[40,i%50/10],"lon":[141,i%45/10],"kjName":"試験地点"}
            raw[key]={"wind":[2.5,0],"windDirection":[1,0],
                      "precipitation1h":[0,0],"temp":[9.5,0]}
        return cat,raw

    def test_floor_to_published_hour_not_future(self):
        now=dt.datetime(2026,11,10,10,21,tzinfo=dt.timezone.utc)
        t=am.map_timestamp("2026-11-10T19:20:00+09:00",now)
        self.assertEqual(t.isoformat(),"2026-11-10T19:00:00+09:00")
        with self.assertRaises(ValueError):
            am.map_timestamp("2026-11-10T12:00:00+09:00",now)

    def test_quality_zero_only_dont_confuse_zero_with_missing(self):
        self.assertEqual(am.observed([0,0]),0)
        self.assertEqual(am.observed([0,6]),None)
        self.assertEqual(am.observed([2,1]),None)
        self.assertIsNone(am.observed(None))

    def test_national_map_parser_and_observation_values(self):
        cat,raw=self.data()
        raw["11000"]["wind"]=[0,6]
        raw["11001"]["precipitation1h"]=[0,6]
        result=am.parse_map(cat,raw,dt.datetime(2026,11,10,19,tzinfo=am.JST))
        self.assertEqual(result["metrics"]["stations"],210)
        self.assertEqual(result["metrics"]["valid_wind"],209)
        self.assertEqual(result["metrics"]["valid_rain"],209)
        self.assertIsNone(result["stations"][0]["wind_ms"])
        self.assertIsNone(result["stations"][0]["wind_direction_16"])
        self.assertIsNone(result["stations"][1]["precipitation_1h_mm"])
        self.assertEqual(result["stations"][2]["precipitation_1h_mm"],0)

    def test_reject_partial_silent_nationwide_collection(self):
        cat,raw=self.data(30)
        with self.assertRaisesRegex(ValueError,"Too few"):
            am.parse_map(cat,raw,dt.datetime(2026,11,10,19,tzinfo=am.JST))

    def test_local_archive_no_duplicate_time(self):
        cat,raw=self.data()
        snap=am.parse_map(cat,raw,dt.datetime(2026,11,10,19,tzinfo=am.JST))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            self.assertTrue(am.save(snap,root))
            self.assertFalse(am.save(snap,root))
            self.assertEqual(len(list((root/"recent").glob("*.jsonl"))),1)
            self.assertEqual(len((root/"recent"/"2026-11-10.jsonl").read_text().splitlines()),1)

if __name__=="__main__":
    unittest.main()
