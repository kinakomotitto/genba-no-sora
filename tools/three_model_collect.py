#!/usr/bin/env python3
"""Collect tiny, time-stamped 3-model forecasts for public AMeDAS reference sites.

Personal research prototype. Only exact PUBLIC station coordinates are sent to
Open-Meteo; no user GPS, saved sites, contact details or job-site data.
Three batched HTTP GET requests maximum per run, one per independent model.
No winner / correction claims. Failed models are recorded, not imputed as zero.
"""
import datetime as dt
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
INPUT=ROOT/"data"/"amedas"/"latest.json"
OUT=ROOT/"data"/"model-validation"
API="https://api.open-meteo.com/v1/forecast"
MODELS=("jma_msm","ecmwf_ifs","icon_seamless")
SITES=("札幌","青森","仙台","東京","名古屋","大阪","広島","福岡","那覇")
TARGET_LEADS=(6,12,24)
KEEP_DAYS=21
MAX_BYTES=1_000_000
UTC=dt.timezone.utc

def now_utc():
    return dt.datetime.now(UTC)

def numeric(v):
    return float(v) if isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) else None

def select_public_stations(snapshot):
    if snapshot.get("source")!="jma-amedas-public-homepage-json":
        raise ValueError("Only validated public JMA AMeDAS snapshots are allowed")
    lookup={}
    for row in snapshot.get("stations",[]):
        if row.get("name") in SITES and row.get("name") not in lookup:
            lat,lon=numeric(row.get("lat")),numeric(row.get("lon"))
            if lat is not None and lon is not None and 20<=lat<=46.5 and 122<=lon<=154:
                lookup[row["name"]]=row
    found=[lookup[name] for name in SITES if name in lookup]
    if len(found)<5:
        raise ValueError("Too few national representative stations in JMA snapshot")
    return found

def request_model(model,stations):
    params={
        "latitude":",".join(str(s["lat"]) for s in stations),
        "longitude":",".join(str(s["lon"]) for s in stations),
        "hourly":"wind_speed_10m,wind_direction_10m,precipitation",
        "models":model,"forecast_days":"2","timezone":"UTC",
        "wind_speed_unit":"ms","precipitation_unit":"mm"
    }
    url=API+"?"+urllib.parse.urlencode(params)
    request=urllib.request.Request(url,headers={
        "User-Agent":"genba-no-sora-personal-model-check/0.1",
        "Accept":"application/json"
    })
    with urllib.request.urlopen(request,timeout=25) as response:
        data=response.read(MAX_BYTES+1)
    if len(data)>MAX_BYTES:
        raise ValueError("Forecast response larger than 1MB")
    parsed=json.loads(data.decode("utf-8"))
    if not isinstance(parsed,list):
        raise ValueError("Expected a batch response list")
    if len(parsed)!=len(stations):
        raise ValueError("Incorrect number of model locations")
    for item,station in zip(parsed,stations):
        if not isinstance(item,dict) or item.get("error") or not isinstance(item.get("hourly"),dict):
            raise ValueError("Invalid hourly model output")
        # Numerical model gridpoints may differ slightly from the requested coordinates.
        lat,lon=numeric(item.get("latitude")),numeric(item.get("longitude"))
        if lat is None or lon is None or abs(lat-station["lat"])>0.4 or abs(lon-station["lon"])>0.4:
            raise ValueError("Model location does not match requested station")
    return parsed

def forecast_targets(fetched):
    """Only verification times which can match 6-hourly hourly-map snapshots."""
    if fetched.tzinfo is None:
        raise ValueError("Timezone-aware fetch time required")
    t=fetched.astimezone(UTC).replace(minute=0,second=0,microsecond=0)
    t-=dt.timedelta(hours=t.hour%6)
    targets={}
    for lead in TARGET_LEADS:
        valid=t+dt.timedelta(hours=lead)
        actual=(valid-fetched).total_seconds()/3600
        if 0<actual<=25 and abs(actual-lead)<=1:
            targets[valid.strftime("%Y-%m-%dT%H:%M")]=valid.isoformat().replace("+00:00","Z")
    return targets

def parse_forecast(model,stations,data,fetched):
    targets=forecast_targets(fetched)
    output=[]
    stamp=fetched.isoformat().replace("+00:00","Z")
    for station,blob in zip(stations,data):
        h=blob["hourly"]
        times=h.get("time",[])
        if not isinstance(times,list):
            raise ValueError("Hourly time vector is missing")
        for i,time in enumerate(times):
            if time not in targets:
                continue
            def metric(name):
                a=h.get(name)
                return numeric(a[i]) if isinstance(a,list) and i<len(a) else None
            wind=metric("wind_speed_10m")
            rain=metric("precipitation")
            direction=metric("wind_direction_10m")
            if wind is not None and wind<0:wind=None
            if rain is not None and rain<0:rain=None
            if wind is None and rain is None:
                continue
            output.append({
                "station_id":station["id"],"model":model,
                "fetched_at":stamp,"valid_at":targets[time],
                "wind_ms":round(wind,2) if wind is not None else None,
                "wind_direction_deg":round(direction%360,1) if direction is not None else None,
                "precipitation_1h_mm":round(rain,2) if rain is not None else None
            })
    return output

def save_daily(rows,when,output=OUT):
    output.mkdir(parents=True,exist_ok=True)
    day=output/"forecasts"
    day.mkdir(exist_ok=True)
    filename=day/(when.strftime("%Y-%m-%d")+".jsonl")
    existing={}
    if filename.exists():
        for line in filename.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r=json.loads(line)
                existing[(r["station_id"],r["model"],r["fetched_at"],r["valid_at"])]=r
    for row in rows:
        existing[(row["station_id"],row["model"],row["fetched_at"],row["valid_at"])]=row
    filename.write_text(
        "".join(json.dumps(row,separators=(",",":"),ensure_ascii=False)+"\n"
                for _,row in sorted(existing.items())),
        encoding="utf-8"
    )
    cutoff=when.date()-dt.timedelta(days=KEEP_DAYS)
    for item in day.glob("????-??-??.jsonl"):
        try:
            if dt.date.fromisoformat(item.stem)<cutoff:item.unlink()
        except ValueError:
            continue

def collect(snapshot_path=INPUT,output=OUT,fetcher=request_model,clock=now_utc):
    stamp=clock()
    status={
        "schema":1,"fetched_at":stamp.isoformat().replace("+00:00","Z"),
        "type":"research_pilot_public_stations_only",
        "not_nationwide_model_coverage":True,
        "models":list(MODELS),"requested_site_names":list(SITES),
        "per_model":{},"calls_attempted":0,"forecast_rows_saved":0,
        "automatic_correction_enabled":False,
        "data_source":"Open-Meteo (CC BY 4.0); free API only for non-commercial trials"
    }
    try:
        snapshot=json.loads(snapshot_path.read_text(encoding="utf-8"))
        stations=select_public_stations(snapshot)
        status["selected_station_count"]=len(stations)
        found=[]
        for model in MODELS:
            status["calls_attempted"]+=1
            try:
                data=fetcher(model,stations)
                rows=parse_forecast(model,stations,data,stamp)
                if not rows:
                    raise ValueError("No matching future times or valid model variables")
                found.extend(rows)
                status["per_model"][model]={"state":"ok","rows":len(rows)}
            except Exception as exc:
                # Avoid leaking URL or host internals to the public JSON.
                status["per_model"][model]={"state":"unavailable","reason":type(exc).__name__}
        if found:
            save_daily(found,stamp,output)
        status["forecast_rows_saved"]=len(found)
        status["state"]="saved" if len(found)>0 else "no_forecasts_available"
    except Exception as exc:
        status["state"]="not_ready"
        status["reason"]=type(exc).__name__
    output.mkdir(parents=True,exist_ok=True)
    (output/"collection-status.json").write_text(
        json.dumps(status,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"
    )
    print(json.dumps(status,ensure_ascii=False))
    return status

if __name__=="__main__":
    collect()
