#!/usr/bin/env python3
"""Low-frequency nationwide JMA AMeDAS public-web snapshot collector.

Uses 3 HTTP GETs maximum per run (latest clock, station metadata, one full-Japan
hourly map). No per-station polling, retries, user GPS, commercial APIs or fees.
The public homepage JSON is undocumented and may break/change without notice.
"""
import datetime as dt
import json
import math
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/"data"/"amedas"
BASE="https://www.jma.go.jp/bosai/amedas/"
JST=dt.timezone(dt.timedelta(hours=9))
UTC=dt.timezone.utc
KEEP_DAYS=14
MAX_BYTES=2_000_000
USER_AGENT="genba-no-sora-public-amedas-snapshot/0.1 (+https://github.com/kinakomotitto/genba-no-sora)"

def get_text(path):
    if not path.startswith(BASE):
        raise ValueError("External URL not allowed")
    with urllib.request.urlopen(
        urllib.request.Request(path,headers={"User-Agent":USER_AGENT,"Accept":"application/json,text/plain"}),
        timeout=15
    ) as response:
        raw=response.read(MAX_BYTES+1)
    if len(raw)>MAX_BYTES:
        raise ValueError("JMA response exceeds size limit")
    return raw.decode("utf-8")

def numeric(value):
    if isinstance(value,bool) or not isinstance(value,(float,int)):
        return None
    return round(float(value),2) if math.isfinite(value) else None

def observed(metric):
    """Only JMA web JSON array [value,quality=0] is accepted as measured data."""
    if not isinstance(metric,list) or len(metric)<2 or metric[1]!=0:
        return None
    return numeric(metric[0])

def coordinate(coords):
    if not isinstance(coords,list) or len(coords)!=2:
        return None
    degree,minute=numeric(coords[0]),numeric(coords[1])
    if degree is None or minute is None or not 0 <= minute < 60:
        return None
    return round(degree+minute/60,5)

def map_timestamp(clock_text,now=None):
    when=dt.datetime.fromisoformat(clock_text.strip())
    if when.utcoffset()!=dt.timedelta(hours=9):
        raise ValueError("Latest JMA timestamp is not in JST")
    now=now or dt.datetime.now(UTC)
    elapsed=(now-when.astimezone(UTC)).total_seconds()
    if elapsed < -60 or elapsed>7200:
        raise ValueError("JMA observation clock is stale or future")
    # Use a published exact hour, not an inferred future map; essential for 1h rain accumulation.
    return when.replace(minute=0,second=0,microsecond=0)

def parse_map(catalog,raw_map,when):
    if not isinstance(catalog,dict) or not isinstance(raw_map,dict):
        raise ValueError("Unexpected station/map structure")
    rows=[]
    summary={"stations":0,"valid_wind":0,"valid_rain":0,"valid_temperature":0}
    for station_id,obs in raw_map.items():
        details=catalog.get(station_id)
        if not (isinstance(station_id,str) and station_id.isdigit() and isinstance(details,dict) and isinstance(obs,dict)):
            continue
        lat,lon=coordinate(details.get("lat")),coordinate(details.get("lon"))
        if lat is None or lon is None or not (20<=lat<=46.5 and 122<=lon<=154):
            continue
        wind=observed(obs.get("wind"))
        rain=observed(obs.get("precipitation1h"))
        temp=observed(obs.get("temp"))
        direction=observed(obs.get("windDirection"))
        if wind is not None and wind<0:wind=None
        if rain is not None and rain<0:rain=None
        if direction is not None and not (0<=direction<=16 and direction.is_integer()):
            direction=None
        if wind is None:direction=None
        # no signal -> don't emit an empty observation
        if wind is None and rain is None and temp is None:
            continue
        rows.append({
            "id":station_id,"name":str(details.get("kjName") or station_id)[:60],
            "lat":lat,"lon":lon,
            "wind_ms":wind,"wind_direction_16":int(direction) if direction is not None else None,
            "precipitation_1h_mm":rain,"temperature_c":temp
        })
        summary["stations"]+=1
        summary["valid_wind"]+=wind is not None
        summary["valid_rain"]+=rain is not None
        summary["valid_temperature"]+=temp is not None
    if len(rows)<200:
        raise ValueError("Too few valid nationwide observations; aborting update")
    rows.sort(key=lambda x:x["id"])
    return {
        "schema":1,"source":"jma-amedas-public-homepage-json",
        "observed_at":when.isoformat(),"collection_type":"automated_observations_not_forecast_verification",
        "processed_from":"JMA AMeDAS public map data (quality flag 0 only)",
        "source_url":BASE+"data/map/"+when.strftime("%Y%m%d%H%M%S")+".json",
        "attribution":"出典：気象庁ホームページのアメダス公開情報を加工",
        "metrics":summary,"stations":rows
    }

def compact_history(snapshot):
    """Store just observed measurements; catalog metadata remains in latest."""
    return {
        "at":snapshot["observed_at"],"source":"jma_amedas",
        "rows":[[s["id"],s["wind_ms"],s["wind_direction_16"],
                 s["precipitation_1h_mm"],s["temperature_c"]] for s in snapshot["stations"]]
    }

def save(snapshot,root=OUTPUT):
    root.mkdir(parents=True,exist_ok=True)
    latest=root/"latest.json"
    if latest.exists():
        old=json.loads(latest.read_text(encoding="utf-8"))
        if old.get("observed_at")==snapshot["observed_at"]:
            return False
    latest.write_text(json.dumps(snapshot,ensure_ascii=False,separators=(",",":"))+"\n",encoding="utf-8")
    now=dt.datetime.fromisoformat(snapshot["observed_at"])
    archives=root/"recent";archives.mkdir(exist_ok=True)
    day_file=archives/(now.strftime("%Y-%m-%d")+".jsonl")
    records={}
    if day_file.exists():
        for ln in day_file.read_text(encoding="utf-8").splitlines():
            if ln.strip():
                r=json.loads(ln)
                records[r["at"]]=r
    records[snapshot["observed_at"]]=compact_history(snapshot)
    day_file.write_text("".join(json.dumps(r,ensure_ascii=False,separators=(",",":"))+"\n" for at,r in sorted(records.items())),encoding="utf-8")
    cutoff=now.date()-dt.timedelta(days=KEEP_DAYS)
    for file in archives.glob("????-??-??.jsonl"):
        try:
            if dt.date.fromisoformat(file.stem)<cutoff:file.unlink()
        except ValueError:
            continue
    return True

def collect():
    latest_text=get_text(BASE+"data/latest_time.txt")
    hour=map_timestamp(latest_text)
    catalog=json.loads(get_text(BASE+"const/amedastable.json"))
    map_url=BASE+"data/map/"+hour.strftime("%Y%m%d%H%M%S")+".json"
    raw_map=json.loads(get_text(map_url))
    snapshot=parse_map(catalog,raw_map,hour)
    snapshot["fetched_at_utc"]=dt.datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00","Z")
    if save(snapshot):
        print(f"Saved nationwide AMeDAS observation at {hour.isoformat()}: {snapshot['metrics']}")
    else:
        print("Identical observation timestamp already exists; no change")

if __name__=="__main__":
    collect()
