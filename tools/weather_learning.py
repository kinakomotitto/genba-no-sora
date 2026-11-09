#!/usr/bin/env python3
"""Experimental forecast verification for PUBLIC weather stations only.

No user GPS, site names, or manual observations are uploaded.
Forecast: MET Norway Locationforecast 2.0 (CC BY 4.0).
Observation: tenkinow (unofficial JMA observation redistributor).
These are NOT safety-critical live measurements.
"""
import datetime as dt
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UTC = dt.timezone.utc
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "learning"
USER_AGENT = "genba-no-sora-research/0.1 (+https://github.com/kinakomotitto/genba-no-sora)"
# These are PUBLIC CITY-CENTRE points used only to locate PUBLIC observing stations.
# Never put user-provided coordinates in this list.
CENTRES = (
    {"label": "青森市周辺", "lat": 40.824, "lon": 140.740},
    {"label": "八戸市周辺", "lat": 40.511, "lon": 141.488},
    {"label": "むつ市周辺", "lat": 41.293, "lon": 141.184},
)
LEADS = (6, 12, 24)
OBS_SOURCE = "tenkinow-unofficial-jma"
FORECAST_SOURCE = "met-norway-locationforecast-2.0"


def utc_now():
    return dt.datetime.now(UTC)


def iso(t):
    return t.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError("Missing timestamp")
    t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not t.tzinfo:
        raise ValueError("Naive timestamp")
    return t.astimezone(UTC)


def finite_number(x):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    if not math.isfinite(x):
        return None
    return float(x)


def get_json(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        data = response.read(2_000_000)
    return json.loads(data.decode("utf-8"))


def get_station_and_observation(point, now):
    query = urllib.parse.urlencode({"lat": point["lat"], "lon": point["lon"]})
    data = get_json("https://api.tenkinow.com/v1/weather/latest?" + query)
    station, reading = data["station"], data["observation"]
    at = parse_time(reading["observed_at"])
    # Never grade a forecast using an old or future-dated reading.
    if not dt.timedelta(minutes=-2) <= now - at <= dt.timedelta(minutes=45):
        raise ValueError("Observation timestamp is stale or in the future")
    lat, lon = finite_number(station["lat"]), finite_number(station["lon"])
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Invalid station coordinates")
    st_id = str(station["id"])
    if not st_id.isdigit() or len(st_id) > 12:
        raise ValueError("Invalid public station ID")
    location = {
        "station_id": st_id, "station_name": str(station["name"])[:60],
        "lat": lat, "lon": lon, "altitude_m": station.get("altitude_m"),
        "public_area": point["label"],
    }
    values = {
        **location, "source": OBS_SOURCE, "observed_at": iso(at),
        "retrieved_at": iso(now),
        "temperature_c": finite_number(reading.get("temp_c")),
        "wind_speed_ms": finite_number(reading.get("wind_ms")),
        "wind_from_direction_deg": finite_number(reading.get("wind_direction_deg")),
        "precipitation_1h_mm": finite_number(reading.get("precipitation_1h_mm")),
        "attribution": data.get("attribution", {}),
    }
    return location, values


def forecast_at_station(station, now):
    qs = urllib.parse.urlencode({
        "lat": round(station["lat"], 4), "lon": round(station["lon"], 4)
    })
    payload = get_json(
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?" + qs
    )
    prop = payload["properties"]
    updated = iso(parse_time(prop["meta"]["updated_at"]))
    series = prop["timeseries"]
    if not isinstance(series, list) or not series:
        raise ValueError("Empty MET forecast series")
    parsed = [(parse_time(x["time"]), x) for x in series]
    values = []
    for hours in LEADS:
        goal = now + dt.timedelta(hours=hours)
        t, item = min(parsed, key=lambda pair: abs(pair[0] - goal))
        if abs((t - goal).total_seconds()) > 45 * 60:
            continue
        instant = item["data"]["instant"]["details"]
        values.append({
            "station_id": station["station_id"],
            "station_name": station["station_name"],
            "public_area": station["public_area"],
            "station_lat": station["lat"], "station_lon": station["lon"],
            "source": FORECAST_SOURCE,
            "provider_updated_at": updated, "fetched_at": iso(now),
            "valid_at": iso(t), "lead_group_h": hours,
            "actual_lead_h": round((t - now).total_seconds()/3600, 3),
            "temperature_c": finite_number(instant.get("air_temperature")),
            "wind_speed_ms": finite_number(instant.get("wind_speed")),
            "wind_from_direction_deg": finite_number(instant.get("wind_from_direction")),
            "wind_gust_ms": finite_number(instant.get("wind_speed_of_gust")),
        })
    return values


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                rows.append(obj)
        except ValueError:
            raise ValueError(f"Invalid JSONL row at {path.name}:{n}")
    return rows


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def normalize_history(rows, time_field, unique_fields, now):
    cutoff = now - dt.timedelta(days=90)
    unique = {}
    for row in rows:
        try:
            if parse_time(row[time_field]) < cutoff:
                continue
            key = tuple(row[k] for k in unique_fields)
            unique[key] = row
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(unique.values(), key=lambda x: (x[time_field], str(x.get("station_id", ""))))


def angle_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def evaluate(forecasts, observations, now):
    # No interpolation or fabricated "ground truth": only a real station reading
    # from the same exact station, at most 15 minutes from the forecast target.
    obs_by_station = {}
    for reading in observations:
        obs_by_station.setdefault(reading["station_id"], []).append(reading)
    results = {}
    for f in forecasts:
        try:
            ft = parse_time(f["valid_at"])
            issued = parse_time(f["fetched_at"])
        except (KeyError, ValueError):
            continue
        if ft > now or issued >= ft:
            continue
        obs = obs_by_station.get(f.get("station_id"), [])
        matching = []
        for o in obs:
            try:
                observed = parse_time(o["observed_at"])
                gap = abs((ft - observed).total_seconds())
                if gap <= 15*60 and observed > issued:
                    matching.append((gap, o))
            except (ValueError, KeyError):
                continue
        if not matching:
            continue
        _, o = min(matching, key=lambda pair: pair[0])
        key = (f["station_id"], str(f["lead_group_h"]))
        score = results.setdefault(key, {"wind_errors": [], "temp_errors": [], "direction_errors": []})
        for source_key, bucket in (("wind_speed_ms", "wind_errors"), ("temperature_c", "temp_errors")):
            v, actual = finite_number(f.get(source_key)), finite_number(o.get(source_key))
            if v is not None and actual is not None:
                score[bucket].append(abs(v - actual))
        fv, ov = finite_number(f.get("wind_speed_ms")), finite_number(o.get("wind_speed_ms"))
        fd, od = finite_number(f.get("wind_from_direction_deg")), finite_number(o.get("wind_from_direction_deg"))
        if all(x is not None for x in (fv, ov, fd, od)) and min(fv, ov) >= 1:
            score["direction_errors"].append(angle_diff(fd, od))
    out = []
    for (station, lead), score in sorted(results.items()):
        wind = score["wind_errors"]
        temp = score["temp_errors"]
        directions = score["direction_errors"]
        n = len(wind)
        out.append({
            "station_id": station, "lead_group_h": int(lead),
            "wind_samples": n,
            "wind_mae_ms": round(sum(wind)/n, 2) if n >= 20 else None,
            "temperature_samples": len(temp),
            "temperature_mae_c": round(sum(temp)/len(temp), 2) if len(temp) >= 20 else None,
            "wind_direction_samples": len(directions),
            "wind_direction_mae_deg": round(sum(directions)/len(directions), 1) if len(directions) >= 20 else None,
            "state": "evaluating" if n >= 20 else "insufficient_data",
        })
    return out


def main():
    now = utc_now()
    DATA.mkdir(parents=True, exist_ok=True)
    f_path = DATA / "forecasts.jsonl"
    o_path = DATA / "observations.jsonl"
    f_rows, o_rows = read_jsonl(f_path), read_jsonl(o_path)
    added_forecasts, added_observations, errors = [], [], []
    for point in CENTRES:
        try:
            station, observation = get_station_and_observation(point, now)
            added_observations.append(observation)
            values = forecast_at_station(station, now)
            if not values:
                raise ValueError("No 6/12/24-hour forecast matches")
            added_forecasts.extend(values)
            print(f"OK: {point['label']} station={station['station_id']}: {len(values)} forecast leads")
        except Exception as exc:
            # One offline station must not hide success at other stations.
            errors.append({"public_area": point["label"], "reason": str(exc)[:180]})
            print(f"WARN: {point['label']}: {exc}", file=sys.stderr)
    if not added_forecasts:
        # No fresh predictions: do not report this run as successful.
        raise RuntimeError("No new forecasts collected; leaving previous summary intact")
    f_rows = normalize_history(
        f_rows + added_forecasts, "fetched_at",
        ("station_id", "provider_updated_at", "valid_at", "lead_group_h"), now
    )
    o_rows = normalize_history(
        o_rows + added_observations, "observed_at",
        ("station_id", "observed_at"), now
    )
    write_jsonl(f_path, f_rows)
    write_jsonl(o_path, o_rows)
    summary = {
        "state": "experimental_collection",
        "last_successful_run_utc": iso(now),
        "source_forecast": FORECAST_SOURCE,
        "source_observation": OBS_SOURCE,
        "forecast_rows": len(f_rows), "observation_rows": len(o_rows),
        "new_forecast_rows": len(added_forecasts),
        "new_observation_rows": len(added_observations),
        "errors": errors,
        "metrics": evaluate(f_rows, o_rows, now),
        "notes": [
            "Public observation stations, NOT private forest worksites.",
            "Observation data are unofficial redistributions of JMA reports.",
            "Metrics withheld until 20 wind samples; do not infer site accuracy.",
            "No local GPS data, user site names or manual observations were uploaded.",
            "Not a source for safety-critical decisions or warnings.",
        ],
        "attribution": [
            {"provider": "MET Norway", "license": "CC BY 4.0", "url": "https://api.met.no/"},
            {"provider": "JMA observation data via tenkinow", "url": "https://tenkinow.com/ja/",
             "license": "Japan Public Data License v1.0; see per-reading attribution"},
        ],
    }
    (DATA / "status.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(f"Saved {len(f_rows)} forecasts, {len(o_rows)} observations. Issues={len(errors)}")


if __name__ == "__main__":
    main()
