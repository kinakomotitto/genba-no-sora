#!/usr/bin/env python3
"""Offline, read-only comparison of *previously captured* public-station forecasts.

Requires user-supplied JSONL; makes no network requests and never uploads coordinates.
This is an evaluation prototype, NOT an automatically learning weather forecast.
"""
import argparse
import datetime as dt
import json
import math
from collections import defaultdict
from pathlib import Path

MODELS = ("jma_msm", "ecmwf_ifs", "icon_seamless")
LEAD_WINDOWS = (3, 6, 12, 24)
MIN_SAMPLES = 30  # diagnostics only; not enough to certify superiority
VALID_QUALITY = {"ok", "confirmed"}

def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing timestamp")
    date = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise ValueError("Timezone required")
    return date.astimezone(dt.timezone.utc)

def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None

def angle_error(forecast, observed):
    return abs((forecast - observed + 180) % 360 - 180)

def jsonl(path):
    if path is None:
        return []
    result = []
    for line_no, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        obj = json.loads(line)
        if not isinstance(obj, dict):
            raise ValueError(f"Expected object at line {line_no}")
        result.append(obj)
    return result

def choose_lead(hours):
    if not (0 < hours <= 25):
        return None
    return min((h for h in LEAD_WINDOWS if abs(h - hours) <= 1), key=lambda h: abs(h-hours), default=None)

def valid_rows(forecasts):
    """De-duplicate by model, station, target hour, lead group; never use hindsight."""
    selected = {}
    for row in forecasts:
        try:
            if row.get("model") not in MODELS:
                continue
            station = str(row["station_id"])
            if not station or station == "None":
                continue
            issued = timestamp(row["fetched_at"])
            valid = timestamp(row["valid_at"])
            if issued >= valid:
                continue
            lead = choose_lead((valid-issued).total_seconds()/3600)
            if lead is None:
                continue
            key = (station, valid.isoformat(), lead, row["model"])
            old = selected.get(key)
            if old is None or issued > timestamp(old["fetched_at"]):
                selected[key] = row
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return selected

def evaluate(forecasts, observations, min_samples=MIN_SAMPLES):
    """Evaluate same-station/time independent model predictions; no auto-weights."""
    if min_samples < 2:
        raise ValueError("min_samples must be at least 2")
    obs_by_station = defaultdict(list)
    for obs in observations:
        try:
            if obs.get("quality") not in VALID_QUALITY:
                continue
            station = str(obs["station_id"])
            when = timestamp(obs["observed_at"])
            obs_by_station[station].append((when, obs))
        except (KeyError, TypeError, ValueError, OverflowError):
            continue

    measurements = {}
    issued_forecasts=valid_rows(forecasts)
    for (station, valid_text, lead, model), forecast in issued_forecasts.items():
        valid = timestamp(valid_text)
        nearby = [(abs((when-valid).total_seconds()), when, obs)
                  for when, obs in obs_by_station[station]
                  if abs((when-valid).total_seconds()) <= 600]
        if not nearby:
            continue
        gap, _, obs = min(nearby, key=lambda item: item[0])
        samples = {}
        for metric in ("wind_ms", "precipitation_1h_mm"):
            pred, actual = number(forecast.get(metric)), number(obs.get(metric))
            # One-hour precipitation must align with the exact hourly accumulation end.
            if metric == "precipitation_1h_mm" and gap > 300:
                continue
            if pred is not None and actual is not None and pred >= 0 and actual >= 0:
                samples[metric] = (pred, actual)
        fdir, odir = number(forecast.get("wind_direction_deg")), number(obs.get("wind_direction_deg"))
        fwind, owind = number(forecast.get("wind_ms")), number(obs.get("wind_ms"))
        if None not in (fdir, odir, fwind, owind) and min(fwind, owind) >= 1:
            samples["direction_deg"] = (fdir%360, odir%360)
        if samples:
            measurements[(station, valid_text, lead, model)] = samples

    stats = []
    for model in MODELS:
        for lead in LEAD_WINDOWS:
            rows = [data for (_, _, l, m), data in measurements.items() if m == model and l == lead]
            wind = [pair for row in rows for metric,pair in row.items() if metric == "wind_ms"]
            rain = [pair for row in rows for metric,pair in row.items() if metric == "precipitation_1h_mm"]
            directions = [pair for row in rows for metric,pair in row.items() if metric == "direction_deg"]
            n_wind, n_rain = len(wind),len(rain)
            verified = n_wind >= min_samples and n_rain >= min_samples
            stats.append({
                "model":model, "lead_h":lead, "station_time_matches":len(rows),
                "wind_samples":n_wind, "rain_samples":n_rain,
                "direction_samples":len(directions),
                "wind_mae_ms":round(sum(abs(p-a) for p,a in wind)/n_wind,3) if n_wind>=min_samples else None,
                "wind_bias_ms":round(sum(p-a for p,a in wind)/n_wind,3) if n_wind>=min_samples else None,
                "rain_mae_mm":round(sum(abs(p-a) for p,a in rain)/n_rain,3) if n_rain>=min_samples else None,
                "rain_missed_events":sum(1 for p,a in rain if a>=0.1 and p<0.1) if n_rain>=min_samples else None,
                "rain_observed_events":sum(1 for _,a in rain if a>=0.1) if n_rain>=min_samples else None,
                "direction_mae_deg":round(sum(angle_error(p,a) for p,a in directions)/len(directions),2)
                    if len(directions)>=min_samples else None,
                "state":"diagnostics_only" if verified else "insufficient_data",
            })
    # Pairwise/common-sample counts prevent misleading raw-MAE rankings.
    cohort=defaultdict(dict)
    for station,valid,lead,model in measurements:
        samples=measurements[(station,valid,lead,model)]
        if "wind_ms" not in samples or "precipitation_1h_mm" not in samples:
            continue
        cohort[(station,valid,lead)][model]=timestamp(
            issued_forecasts[(station,valid,lead,model)]["fetched_at"])
    common={}
    for lead in LEAD_WINDOWS:
        groups=0
        for (_,_,l),issued in cohort.items():
            if l!=lead or not all(m in issued for m in MODELS):
                continue
            times=list(issued.values())
            if max(times)-min(times)<=dt.timedelta(minutes=15):
                groups+=1
        common[str(lead)]=groups
    return {
        "schema":1,
        "state":"evaluation_prototype_only",
        "source_type":"public_weather_stations",
        "model_ids":list(MODELS),
        "min_samples_for_diagnostics":min_samples,
        "common_three_model_station_hours":common,
        "rows":stats,
        "optimal_model":None,
        "auto_correction_enabled":False,
        "notes":[
          "No winner or model weighting: a time-separated, weather-diverse holdout is required.",
          "10-minute station wind observations differ from model 10m wind predictions.",
          "Mountain forests can have different wind from public observing stations.",
          "Hourly precipitation must be aligned by its one-hour accumulation end.",
          "Quality-unverified observations, non-numeric and missing readings are excluded.",
          "Not an official warning or a substitute for onsite safety procedures.",
        ],
    }

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forecasts",required=True,help="Snapshot JSONL from public stations")
    parser.add_argument("--observations",required=True,help="Quality-checked observed JSONL")
    parser.add_argument("--output",help="Optional local JSON summary (no uploading)")
    args=parser.parse_args()
    report=evaluate(jsonl(args.forecasts),jsonl(args.observations))
    text=json.dumps(report,ensure_ascii=False,indent=2)+"\n"
    if args.output:
        Path(args.output).write_text(text,encoding="utf-8")
    else:
        print(text,end="")

if __name__=="__main__":
    main()
