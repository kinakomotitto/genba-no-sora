#!/usr/bin/env python3
"""Exploratory, non-corrective temperature-vs-elevation research from JMA stations.

No network, no personal GPS, no forecast correction, no guessed cloudiness.
Public quality-checked JMA temperatures at SAME observation timestamp only.
A warmer higher station is NOT proof of a local temperature inversion; this
is a preliminary contrast between distinct stations and terrains.
"""
import datetime as dt
import json
import math
import statistics
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
INPUT=ROOT/"data"/"amedas"
OUTPUT=ROOT/"data"/"model-validation"/"terrain-temperature-research.json"
JST=dt.timezone(dt.timedelta(hours=9))
MAX_PAIR_DISTANCE_KM=25.0
MIN_ELEVATION_DIFFERENCE_M=70.0
MAX_ELEVATION_DIFFERENCE_M=800.0
MAX_PAIRS=160
MAX_HISTORY_DAYS=14
MIN_DIAGNOSTIC_DAYS=7
MIN_DIAGNOSTIC_TIMESTAMPS=10

def finite(x,lo,hi):
    if isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x):
        return None
    return float(x) if lo<=x<=hi else None

def timestamp(value):
    if not isinstance(value,str):return None
    try:
        parsed=dt.datetime.fromisoformat(value.replace("Z","+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(JST) if parsed.tzinfo else None

def distance_km(a,b):
    r=math.pi/180
    lat1,lat2=a["lat"]*r,b["lat"]*r
    delta_lat=lat2-lat1
    delta_lon=(b["lon"]-a["lon"])*r
    h=math.sin(delta_lat/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(delta_lon/2)**2
    return 12742*math.asin(min(1,math.sqrt(max(0,h))))

def eligible_stations(snapshot):
    """Use stations with public ground elevation and measured temperature."""
    rows=[]
    for raw in snapshot.get("stations",[]):
        if not isinstance(raw,dict):continue
        sid=raw.get("id")
        lat=finite(raw.get("lat"),20,46.5)
        lon=finite(raw.get("lon"),122,154)
        altitude=finite(raw.get("altitude_m"),-500,4000)
        temp=finite(raw.get("temperature_c"),-60,55)
        if not isinstance(sid,str) or not sid.isdigit() or None in (lat,lon,altitude,temp):
            continue
        rows.append({"id":sid,"lat":lat,"lon":lon,"altitude_m":altitude})
    return sorted(rows,key=lambda s:s["id"])

def choose_pairs(rows,limit=MAX_PAIRS):
    """Fixed, deterministic one-to-one station pairs for this rolling report."""
    candidates=[]
    for i,a in enumerate(rows):
        for b in rows[i+1:]:
            # Coarse bounding box before the great-circle calculation.
            if abs(a["lat"]-b["lat"])>.24 or abs(a["lon"]-b["lon"])>.34:
                continue
            height=abs(a["altitude_m"]-b["altitude_m"])
            if not MIN_ELEVATION_DIFFERENCE_M<=height<=MAX_ELEVATION_DIFFERENCE_M:
                continue
            dist=distance_km(a,b)
            if dist>MAX_PAIR_DISTANCE_KM:
                continue
            lower,higher=(a,b) if a["altitude_m"]<b["altitude_m"] else (b,a)
            candidates.append((dist,lower["id"],higher["id"],height))
    candidates.sort()
    used=set()
    result=[]
    for distance,low,high,height in candidates:
        if low in used or high in used:continue
        result.append({"low":low,"high":high,"distance_km":round(distance,1),
                       "elevation_difference_m":round(height,1)})
        used.update((low,high))
        if len(result)>=limit:break
    return result

def load_snapshots(folder,cutoff):
    snapshots={}
    # Duplicates by timestamp are not independent data points.
    archive=folder/"recent"
    if not archive.exists():return []
    for file in sorted(archive.glob("????-??-??.jsonl")):
        for line in file.read_text(encoding="utf-8").splitlines():
            if not line.strip():continue
            try:item=json.loads(line)
            except ValueError:continue
            when=timestamp(item.get("at"))
            if when is None or when.date()<cutoff or when.date()>cutoff+dt.timedelta(days=MAX_HISTORY_DAYS):
                continue
            if not isinstance(item.get("rows"),list):continue
            snapshots[when.isoformat()]=item
    return [snapshots[k] for k in sorted(snapshots)]

def summarize(values):
    if not values:return {
        "samples":0,"matched_timestamps":0,"distinct_days":0,
        "warmer_higher_count":0,"warmer_higher_share":None,
        "mean_higher_minus_lower_c":None,"median_higher_minus_lower_c":None
    }
    diffs=[v["diff"] for v in values]
    return {
        "samples":len(values),
        "matched_timestamps":len({v["timestamp"] for v in values}),
        "distinct_days":len({v["day"] for v in values}),
        "warmer_higher_count":sum(v>0 for v in diffs),
        "warmer_higher_share":round(sum(v>0 for v in diffs)/len(diffs),3),
        "mean_higher_minus_lower_c":round(statistics.mean(diffs),2),
        "median_higher_minus_lower_c":round(statistics.median(diffs),2)
    }

def analyze(snapshot,history,updated=None):
    """A descriptive multi-station study, never a calibration target."""
    updated=updated or dt.datetime.now(dt.timezone.utc)
    pairs=choose_pairs(eligible_stations(snapshot))
    days=[]
    sample_counts={"day":[],"night":[],"night_calm":[],"night_other_wind":[]}
    observed_stamps=set()
    station_ids={x for p in pairs for x in (p["low"],p["high"])}
    for period in history:
        when=timestamp(period.get("at"))
        if when is None:continue
        is_day=6<=when.hour<18  # fixed JST clock hours, not actual sunrise/sunset
        readings={}
        for row in period.get("rows",[]):
            if not isinstance(row,list) or len(row)!=5:continue
            sid,wind,_direction,_rain,temp=row
            if sid not in station_ids:continue
            t=finite(temp,-60,55)
            w=finite(wind,0,100)
            if t is not None:readings[sid]=(t,w)
        day=when.date().isoformat()
        period_name="day" if is_day else "night"
        for pair in pairs:
            low,high=readings.get(pair["low"]),readings.get(pair["high"])
            if not low or not high:continue
            record={"diff":high[0]-low[0],"timestamp":when.isoformat(),"day":day}
            sample_counts[period_name].append(record)
            observed_stamps.add(when.isoformat())
            if not is_day:
                if low[1] is not None and high[1] is not None:
                    group="night_calm" if max(low[1],high[1])<=2 else "night_other_wind"
                    sample_counts[group].append(record)
        days.append(day)
    summaries={name:summarize(values) for name,values in sample_counts.items()}
    unique_dates=sorted(set(days))
    enough=(len(unique_dates)>=MIN_DIAGNOSTIC_DAYS
            and summaries["night"]["matched_timestamps"]>=MIN_DIAGNOSTIC_TIMESTAMPS
            and summaries["day"]["matched_timestamps"]>=MIN_DIAGNOSTIC_TIMESTAMPS
            and len(pairs)>=10)
    result={
        "schema":1,"study":"station_elevation_day_night_air_temperature",
        "updated_at_utc":updated.astimezone(dt.timezone.utc).isoformat().replace("+00:00","Z"),
        "state":"exploratory_diagnostics_only" if enough else "collecting_observations",
        "automatic_correction_enabled":False,"production_forecast_changes":False,
        "source":"JMA public AMeDAS temperature/wind; original quality flag 0 only",
        "area":"public_stations_in_japan_not_user_gps",
        "observation_history_days_limit":MAX_HISTORY_DAYS,
        "station_selection":"deterministic nearest disjoint pairs, same timestamp, 70-800m elevation separation within 25km",
        "matched_pair_count":len(pairs),
        "stations_in_selected_pairs":len(station_ids),
        "earliest_observation_jst":unique_dates[0] if unique_dates else None,
        "latest_observation_jst":unique_dates[-1] if unique_dates else None,
        "distinct_observation_days":len(unique_dates),
        "distinct_matched_timestamps":len(observed_stamps),
        "day_night_definition_jst":"day 06:00-17:59 / night 18:00-05:59 (not local sunrise/sunset)",
        "by_period":summaries,
        "interpretation":"Higher station warmer is a cross-station contrast, NOT demonstrated inversion, error or local observation.",
        "next_evidence_needed":"Longer dates/seasons, station representativeness, forecast temperature snapshots, and independent held-out validation before considering any correction.",
        "limitations":[
            "Pairs are selected from latest available stations and may change over time.",
            "Different sensors, locations, terrain and land cover cause temperature differences.",
            "Multiple pairs/timestamps are correlated, not independent proof of a physical inversion.",
            "Cloud cover, radiative cooling and valley geometry are not directly measured here.",
            "No local user position or private workplace coordinates are collected."
        ]
    }
    return result

def run(root=ROOT,now=None):
    snapshot_file=root/"data"/"amedas"/"latest.json"
    if not snapshot_file.exists():
        raise FileNotFoundError("A public JMA station snapshot is required")
    snapshot=json.loads(snapshot_file.read_text(encoding="utf-8"))
    if snapshot.get("source")!="jma-amedas-public-homepage-json":
        raise ValueError("Unexpected data source")
    when=timestamp(snapshot.get("observed_at"))
    if when is None:raise ValueError("Missing valid JMA observation time")
    cutoff=when.date()-dt.timedelta(days=MAX_HISTORY_DAYS-1)
    history=load_snapshots(root/"data"/"amedas",cutoff)
    result=analyze(snapshot,history,updated=now)
    output=root/"data"/"model-validation"/"terrain-temperature-research.json"
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"state":result["state"],"matched_pairs":result["matched_pair_count"],
                      "days":result["distinct_observation_days"],
                      "night_samples":result["by_period"]["night"]["samples"],
                      "day_samples":result["by_period"]["day"]["samples"],
                      "automatic_correction_enabled":False},ensure_ascii=False))
    return result

if __name__=="__main__":
    run()
