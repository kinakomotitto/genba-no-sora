"""Offline-only synthetic tests for weather research, no live network/API usage."""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import weather_learning as wl


class WeatherLearningTest(unittest.TestCase):
    def test_angle_wrap(self):
        self.assertEqual(wl.angle_diff(359, 1), 2)
        self.assertEqual(wl.angle_diff(0, 180), 180)

    def test_requires_same_station_and_close_time(self):
        valid = dt.datetime(2026, 11, 8, 6, tzinfo=dt.timezone.utc)
        forecast = {
            "station_id": "11111", "lead_group_h": 6,
            "valid_at": wl.iso(valid), "fetched_at": wl.iso(valid-dt.timedelta(hours=6)),
            "wind_speed_ms": 4, "temperature_c": 10,
            "wind_from_direction_deg": 359,
        }
        wrong_station = {
            "station_id": "22222", "observed_at": wl.iso(valid+dt.timedelta(minutes=10)),
            "wind_speed_ms": 6, "temperature_c": 12, "wind_from_direction_deg": 1,
        }
        far_time = {**wrong_station, "station_id": "11111",
                    "observed_at": wl.iso(valid+dt.timedelta(minutes=16))}
        self.assertEqual(wl.evaluate([forecast], [wrong_station,far_time], valid+dt.timedelta(hours=1)), [])
        good = {**wrong_station, "station_id": "11111"}
        scored = wl.evaluate([forecast], [good], valid+dt.timedelta(hours=1))
        self.assertEqual(scored[0]["wind_samples"], 1)
        self.assertIsNone(scored[0]["wind_mae_ms"])
        self.assertEqual(scored[0]["state"], "insufficient_data")

    def test_reveal_mae_only_after_twenty_valid_samples(self):
        rows,obs = [],[]
        base=dt.datetime(2026,11,5,0,tzinfo=dt.timezone.utc)
        for i in range(20):
            valid=base+dt.timedelta(hours=i)
            rows.append({
                "station_id":"11111","lead_group_h":6,
                "fetched_at":wl.iso(valid-dt.timedelta(hours=6)),
                "valid_at":wl.iso(valid),"wind_speed_ms":5,
                "temperature_c":5,"wind_from_direction_deg":359,
            })
            obs.append({"station_id":"11111",
                "observed_at":wl.iso(valid+dt.timedelta(minutes=10)),
                "wind_speed_ms":7,"temperature_c":8,"wind_from_direction_deg":1})
        result=wl.evaluate(rows,obs,base+dt.timedelta(hours=100))
        self.assertEqual(result[0]["wind_samples"],20)
        self.assertEqual(result[0]["wind_mae_ms"],2.0)
        self.assertEqual(result[0]["temperature_mae_c"],3.0)
        self.assertEqual(result[0]["wind_direction_mae_deg"],2.0)

    def test_wrong_issue_timing_not_scored(self):
        t=dt.datetime(2026,11,5,6,tzinfo=dt.timezone.utc)
        f={"station_id":"1","valid_at":wl.iso(t),
           "fetched_at":wl.iso(t+dt.timedelta(minutes=1)),
           "lead_group_h":6,"wind_speed_ms":5}
        o={"station_id":"1","observed_at":wl.iso(t+dt.timedelta(minutes=10)),"wind_speed_ms":3}
        self.assertEqual(wl.evaluate([f],[o],t+dt.timedelta(hours=1)),[])

    def test_deduplication_and_retention(self):
        now=dt.datetime(2026,11,10,tzinfo=dt.timezone.utc)
        t=wl.iso(now-dt.timedelta(days=1))
        old=wl.iso(now-dt.timedelta(days=200))
        rows=[
            {"station_id":"1","observed_at":t,"wind_speed_ms":2},
            {"station_id":"1","observed_at":t,"wind_speed_ms":3},
            {"station_id":"1","observed_at":old,"wind_speed_ms":8},
        ]
        kept=wl.normalize_history(rows,"observed_at",("station_id","observed_at"),now)
        self.assertEqual(len(kept),1)
        self.assertEqual(kept[0]["wind_speed_ms"],3)


if __name__=="__main__":
    unittest.main()
