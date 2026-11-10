#!/usr/bin/env python3
"""Nationwide public AMeDAS station forecast-collection scheduler. DRY RUN ONLY.

No networking, no observation data acquisition, no remote writes, no user GPS.
Accepts the publicly available JMA amedastable.json *file*, supplied locally.
Station availability and weather-data licenses must be validated separately.
"""
import argparse
import datetime as dt
import json
import math
import zlib
from collections import Counter
from pathlib import Path

MODELS = ("jma_msm", "ecmwf_ifs", "icon_seamless")
SLOTS_UTC = ("00:00", "06:00", "12:00", "18:00")
DEFAULT_MAX_SITE_MODEL_JOBS = 5500
DEFAULT_MAX_FOCUS_STATIONS = 100

def coordinates(pair):
    if not isinstance(pair, list) or len(pair) != 2:
        raise ValueError("Invalid coordinate pair")
    deg, minutes = pair
    if isinstance(deg, bool) or isinstance(minutes, bool):
        raise ValueError("Invalid numeric coordinates")
    deg, minutes = float(deg), float(minutes)
    if not math.isfinite(deg) or not math.isfinite(minutes) or not 0 <= minutes < 60:
        raise ValueError("Invalid degree/minute values")
    return deg + minutes/60

def load_public_station_catalog(path):
    """The JMA homepage publishes static station metadata, not live observations."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Expect JMA station mapping")
    stations = []
    for code, details in raw.items():
        if not (isinstance(code, str) and code.isdigit() and isinstance(details, dict)):
            continue
        try:
            lat = coordinates(details["lat"])
            lon = coordinates(details["lon"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not (20 <= lat <= 46 and 122 <= lon <= 154):
            continue
        name = str(details.get("kjName", ""))[:60]
        stations.append({"station_id": code, "name": name, "lat": round(lat, 6),
                         "lon": round(lon, 6), "type": str(details.get("type", "")),
                         "elements": str(details.get("elems", ""))})
    stations.sort(key=lambda row: row["station_id"])
    if not stations:
        raise ValueError("No valid public stations in the catalog")
    return stations

def choose_base_slot(station_id, date):
    # Balanced across time slots, rotates daily to reduce systematic time-of-day bias.
    crc = zlib.crc32(station_id.encode("ascii")) & 0xffffffff
    return (crc + date.toordinal()) % len(SLOTS_UTC)

def nationwide_plan(stations, date, focus_ids=(), max_jobs=DEFAULT_MAX_SITE_MODEL_JOBS,
                    max_focus_stations=DEFAULT_MAX_FOCUS_STATIONS):
    """Plan forecast requests in station x model *units*, not API calls.

    If even once-daily nationwide coverage exceeds budget, refuse rather than
    misleadingly reporting "all Japan covered".
    """
    if not isinstance(date, dt.date):
        raise ValueError("date must be a date")
    ids = {s["station_id"] for s in stations}
    if len(ids) != len(stations):
        raise ValueError("Duplicate stations")
    requested = sorted(set(focus_ids))
    unknown = set(requested) - ids
    if unknown:
        raise ValueError("Unknown focus station IDs: " + ",".join(sorted(unknown)))
    base = len(stations) * len(MODELS)
    if max_jobs < base:
        raise ValueError(f"Daily budget {max_jobs} < full nationwide baseline {base}; no collection scheduled")
    # Each focus station adds 3 extra 6-hour cycles for each of the 3 models.
    extra_per_station = len(MODELS) * (len(SLOTS_UTC)-1)
    allowed_focus = max(0, (max_jobs-base)//extra_per_station)
    allowed_focus = min(allowed_focus, max_focus_stations)
    focus = set(requested[:allowed_focus])
    jobs = []
    for s in stations:
        base_slot = choose_base_slot(s["station_id"], date)
        for slot_idx, slot in enumerate(SLOTS_UTC):
            if slot_idx != base_slot and s["station_id"] not in focus:
                continue
            for model in MODELS:
                jobs.append({"station_id":s["station_id"],"model":model,
                             "utc_slot":slot, "class":"focus" if s["station_id"] in focus else "baseline",
                             "lat":s["lat"],"lon":s["lon"]})
    total = len(jobs)
    if total > max_jobs:
        raise RuntimeError("Internal budget overrun")
    by_slot = dict(sorted(Counter(j["utc_slot"] for j in jobs).items()))
    return {
        "state":"dry_run_only_no_network_calls",
        "date_utc":date.isoformat(),"catalog_station_count":len(stations),
        "model_count":len(MODELS),"models":list(MODELS),
        "baseline_station_model_jobs":base,"daily_station_model_jobs":total,
        "station_model_job_budget":max_jobs,
        "extra_focus_station_count":len(focus),
        "focus_requested_count":len(requested),
        "focus_not_selected":len(requested)-len(focus),
        "jobs_by_utc_slot":by_slot,
        "observation_fetch_jobs":0,
        "commercial_license_confirmed":False,
        "data_collection_enabled":False,
        "notes":[
           "All stations are planned for 1 daily snapshot per model; focus stations 4 daily snapshots.",
           "Site-model job units are NOT HTTP request counts; multi-site API batching may be priced differently.",
           "No live weather data are accessed; station catalog is metadata only.",
           "Data access permissions and a quality-verified AMeDAS feed are prerequisites.",
           "Do not persist private GPS or job-site names in public research.",
           "Observed rain and wind require compatible station instrumentation and temporal aggregation.",
        ],
    }, jobs

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--station-catalog",required=True,help="Locally downloaded JMA amedastable.json")
    parser.add_argument("--date",default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    parser.add_argument("--focus-station-ids",default="",help="Opt-in PUBLIC station IDs only (comma-separated)")
    parser.add_argument("--max-site-model-jobs",type=int,default=DEFAULT_MAX_SITE_MODEL_JOBS)
    parser.add_argument("--max-focus-stations",type=int,default=DEFAULT_MAX_FOCUS_STATIONS)
    parser.add_argument("--jobs-output",help="Optional locally written detailed JSON, no upload")
    args=parser.parse_args()
    stations=load_public_station_catalog(args.station_catalog)
    summary,jobs=nationwide_plan(
        stations,dt.date.fromisoformat(args.date),
        [x.strip() for x in args.focus_station_ids.split(",") if x.strip()],
        args.max_site_model_jobs,args.max_focus_stations
    )
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    if args.jobs_output:
        Path(args.jobs_output).write_text(json.dumps(jobs,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")

if __name__=="__main__":
    main()
