"""Offline regression tests for sanitized, bounded transient-retry diagnostics."""
import datetime as dt
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

from tools import three_model_collect as collector

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 22, 0, 20, tzinfo=UTC)


def sample_stations():
    return [
        {"id": str(10000 + i), "name": name, "lat": 30 + i, "lon": 130 + i,
         "wind_ms": 2, "precipitation_1h_mm": 0}
        for i, name in enumerate(collector.SITES)
    ]


def response(stations):
    valid = [(NOW + dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:00")
             for h in range(48)]
    return [
        {"latitude": site["lat"], "longitude": site["lon"],
         "hourly": {"time": valid, "wind_speed_10m": [3] * 48,
                    "wind_direction_10m": [90] * 48,
                    "precipitation": [0] * 48}}
        for site in stations
    ]


class RetryDiagnosticsTests(unittest.TestCase):
    def run_collection(self, fetcher):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "latest.json"
            source.write_text(json.dumps({
                "source": "jma-amedas-public-homepage-json",
                "stations": sample_stations()
            }), encoding="utf-8")
            return collector.collect(source, root / "out", fetcher, lambda: NOW)

    def test_one_transient_error_recovers_without_leaking_error_text(self):
        calls = {}
        def fetcher(model, sites):
            calls[model] = calls.get(model, 0) + 1
            if model == "jma_msm" and calls[model] == 1:
                raise urllib.error.URLError("private-url-and-location")
            return response(sites)
        result = self.run_collection(fetcher)
        msm = result["per_model"]["jma_msm"]
        self.assertEqual(msm["transient_retries_attempted"], 1)
        self.assertEqual(msm["transient_retries_recovered"], 1)
        self.assertEqual(result["calls_attempted"], 4)
        self.assertTrue(result["all_three_models_collected"])
        self.assertNotIn("private-url-and-location", json.dumps(result))
        self.assertEqual(result["per_model"]["ecmwf_ifs"]["transient_retries_attempted"], 0)

    def test_repeated_transient_failure_stops_after_one_retry(self):
        calls = {}
        def fetcher(model, sites):
            calls[model] = calls.get(model, 0) + 1
            if model == "jma_msm":
                raise urllib.error.URLError("private-url-and-location")
            return response(sites)
        result = self.run_collection(fetcher)
        msm = result["per_model"]["jma_msm"]
        self.assertEqual(calls["jma_msm"], 2)
        self.assertEqual(msm["transient_retries_attempted"], 1)
        self.assertEqual(msm["transient_retries_recovered"], 0)
        self.assertIn("network_unreachable", msm["failure_types"])
        self.assertNotIn("private-url-and-location", json.dumps(result))
        self.assertFalse(result["all_three_models_collected"])

    def test_http_429_is_never_retried(self):
        calls = []
        def fetcher(model, sites):
            calls.append(model)
            raise urllib.error.HTTPError("https://example.invalid/private", 429,
                                         "quota", {}, None)
        result = self.run_collection(fetcher)
        self.assertEqual(calls, ["jma_msm"])
        self.assertEqual(result["per_model"]["jma_msm"]["transient_retries_attempted"], 0)
        self.assertEqual(result["per_model"]["jma_msm"]["failure_types"], ["HTTP_429"])


if __name__ == "__main__":
    unittest.main()
