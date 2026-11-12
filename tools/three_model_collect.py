#!/usr/bin/env python3
"""Collect tiny, time-stamped 3-model forecasts for public AMeDAS reference sites.

Personal research prototype. Only exact PUBLIC station coordinates are sent to
Open-Meteo; no user GPS, saved sites, contact details or job-site data.
At most 16 bounded HTTP GET requests per run across 3 models.
A coordinate in a batch still consumes provider API allocation; this is capped.
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
# Up to 36 public stations across Japan (not a claim of prefecture completeness).
MAX_PUBLIC_REFERENCE_STATIONS=36
MAX_DAILY_SITE_MODEL_UNITS=600  # 36 sites x 3 models x 4 UTC slots = 432.
RUNS_PER_DAY=4
MAX_STATIONS_PER_REQUEST=9  # avoid large all-or-nothing requests
MAX_HTTP_GETS_PER_RUN=16  # 36 stations -> 4 chunks x 3 models = 12 GETs
TARGET_LEADS=(6,12,24)
KEEP_DAYS=21
MAX_BYTES=1_000_000
UTC=dt.timezone.utc

class ForecastResponseError(ValueError):
    def __init__(self,reason_code):
        # Only these static codes go into the public Git repository.
        self.reason_code=str(reason_code)
        super().__init__(self.reason_code)

def now_utc():
    return dt.datetime.now(UTC)

def numeric(v):
    return float(v) if isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) else None

def select_public_stations(snapshot,max_sites=MAX_PUBLIC_REFERENCE_STATIONS,preferred_station_ids=None):
    if not isinstance(max_sites,int) or not len(SITES)<=max_sites<=MAX_PUBLIC_REFERENCE_STATIONS:
        raise ValueError("Invalid limit for public reference stations")
    if snapshot.get("source")!="jma-amedas-public-homepage-json":
        raise ValueError("Only validated public JMA AMeDAS snapshots are allowed")
    lookup={}
    for row in snapshot.get("stations",[]):
        if row.get("name") in SITES and row.get("name") not in lookup:
            lat,lon=numeric(row.get("lat")),numeric(row.get("lon"))
            if lat is not None and lon is not None and 20<=lat<=46.5 and 122<=lon<=154:
                lookup[row["name"]]=row
    anchors=[lookup[name] for name in SITES if name in lookup]
    if len(anchors)<5:
        raise ValueError("Too few national representative stations in JMA snapshot")
    candidates=[]
    for row in snapshot.get("stations",[]):
        sid=str(row.get("id",""))
        lat,lon=numeric(row.get("lat")),numeric(row.get("lon"))
        if not sid.isdigit() or lat is None or lon is None:
            continue
        if not 20<=lat<=46.5 or not 122<=lon<=154:
            continue
        if numeric(row.get("wind_ms")) is None or numeric(row.get("precipitation_1h_mm")) is None:
            continue
        candidates.append(row)
    # Keep the same public stations over time, otherwise the changing JMA
    # missing-value pattern makes longitudinal evaluation incomparable.
    found=list(anchors)
    chosen={str(x["id"]) for x in found}
    by_id={str(row["id"]):row for row in candidates}
    if isinstance(preferred_station_ids,list):
        for station_id in preferred_station_ids[:MAX_PUBLIC_REFERENCE_STATIONS]:
            sid=str(station_id)
            if len(found)>=max_sites:break
            if sid not in chosen and sid in by_id:
                found.append(by_id[sid])
                chosen.add(sid)
    # Only expand remaining slots by geographically separated public stations.
    candidates=sorted((row for row in candidates if str(row["id"]) not in chosen),
                      key=lambda item:str(item["id"]))
    def distance_km(a,b):
        r=math.pi/180
        a_lat,b_lat=a["lat"]*r,b["lat"]*r
        dlat=b_lat-a_lat
        dlon=(b["lon"]-a["lon"])*r
        x=math.sin(dlat/2)**2+math.cos(a_lat)*math.cos(b_lat)*math.sin(dlon/2)**2
        return 12742*math.asin(min(1,math.sqrt(x)))
    while len(found)<max_sites and candidates:
        furthest=max(candidates,key=lambda c:min(distance_km(c,s) for s in found))
        found.append(furthest)
        candidates.remove(furthest)
    if len(found)*len(MODELS)*RUNS_PER_DAY>MAX_DAILY_SITE_MODEL_UNITS:
        raise ValueError("National model collection exceeds daily weighted site-model budget")
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
        raise ForecastResponseError("response_too_large")
    parsed=json.loads(data.decode("utf-8"))
    if not isinstance(parsed,list):
        raise ForecastResponseError("invalid_batch_response_type")
    if len(parsed)!=len(stations):
        raise ForecastResponseError("missing_requested_locations")
    for item,station in zip(parsed,stations):
        if not isinstance(item,dict) or item.get("error") or not isinstance(item.get("hourly"),dict):
            raise ForecastResponseError("model_missing_hourly_or_error")
        # Numerical model gridpoints may differ slightly from the requested coordinates.
        lat,lon=numeric(item.get("latitude")),numeric(item.get("longitude"))
        if lat is None or lon is None or abs(lat-station["lat"])>0.4 or abs(lon-station["lon"])>0.4:
            raise ForecastResponseError("model_grid_location_mismatch")
    return parsed

def forecast_targets(fetched):
    """Capture real 6/12/24-hour-ahead forecasts despite delayed cron starts.

    GitHub's scheduled jobs can start more than an hour late. Accept starts
    up to 2h30 after a 00/06/12/18 UTC slot, never a whole missed cycle.
    Choose hourly target times around the ACTUAL fetch time (not the original
    cron slot), so downstream verification uses honest forecast lead times.
    Do not reconstruct or backdate forecasts for missed runs.
    """
    if fetched.tzinfo is None:
        raise ValueError("Timezone-aware fetch time required")
    actual=fetched.astimezone(UTC)
    scheduled_slot=actual.replace(minute=0,second=0,microsecond=0)
    scheduled_slot-=dt.timedelta(hours=scheduled_slot.hour%6)
    delay=actual-scheduled_slot
    if not dt.timedelta(0)<=delay<=dt.timedelta(hours=2,minutes=30):
        return {}
    # Open-Meteo supplies hourly targets. Nearest hour keeps each lead in
    # the existing verifier's <=1-hour tolerance without claiming a stale
    # schedule-derived forecast was made six hours before its target.
    target_hour=actual.replace(minute=0,second=0,microsecond=0)
    if actual-target_hour>=dt.timedelta(minutes=30):
        target_hour+=dt.timedelta(hours=1)
    targets={}
    for lead in TARGET_LEADS:
        valid=target_hour+dt.timedelta(hours=lead)
        actual_lead=(valid-actual).total_seconds()/3600
        if 0<actual_lead<=25 and abs(actual_lead-lead)<=1:
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
            if not isinstance(time,str):continue
            try:
                target_key=dt.datetime.fromisoformat(time.replace("Z","+00:00")).strftime("%Y-%m-%dT%H:%M")
            except ValueError:
                continue
            if target_key not in targets:
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
                "fetched_at":stamp,"valid_at":targets[target_key],
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

def adaptive_station_target(previous):
    """Never blindly repeat a national query size that just failed."""
    if not isinstance(previous,dict):
        return len(SITES)
    old=previous.get("selected_station_count",len(SITES))
    if not isinstance(old,int) or not len(SITES)<=old<=MAX_PUBLIC_REFERENCE_STATIONS:
        return len(SITES)
    models=previous.get("per_model",{})
    if not isinstance(models,dict):return len(SITES)
    ok=sum(1 for item in models.values()
           if isinstance(item,dict) and item.get("state")=="ok")
    if previous.get("state")=="saved" and ok==len(MODELS):
        return min(MAX_PUBLIC_REFERENCE_STATIONS,old+9)
    if previous.get("state")=="saved" and ok>0:
        return max(len(SITES),old-9)
    return len(SITES)

def collect(snapshot_path=INPUT,output=OUT,fetcher=request_model,clock=now_utc):
    stamp=clock()
    status={
        "schema":1,"fetched_at":stamp.isoformat().replace("+00:00","Z"),
        "type":"research_pilot_public_stations_only",
        "not_nationwide_model_coverage":True,
        "models":list(MODELS),"requested_site_names":list(SITES),
        "per_model":{},"calls_attempted":0,"forecast_rows_saved":0,
        "max_http_get_requests":MAX_HTTP_GETS_PER_RUN,
        "request_chunk_size":MAX_STATIONS_PER_REQUEST,
        "automatic_correction_enabled":False,
        "data_source":"Open-Meteo (CC BY 4.0); free API only for non-commercial trials"
    }
    try:
        snapshot=json.loads(snapshot_path.read_text(encoding="utf-8"))
        previous=None
        old_status=output/"collection-status.json"
        if old_status.exists():
            try:previous=json.loads(old_status.read_text(encoding="utf-8"))
            except (OSError,ValueError):pass
        target=adaptive_station_target(previous)
        if not forecast_targets(stamp):
            # An off-window manual/very-late run must not erase the last
            # successful model coverage or fabricate a failed collection.
            # Keep the last persisted report intact for truthful freshness
            # checks; the skip remains visible in this run's Actions log.
            status["state"]="not_ready"
            status["reason"]="outside_scheduled_window"
            previous_failures=(previous or {}).get("consecutive_model_failures",0) if isinstance(previous,dict) else 0
            status["consecutive_model_failures"]=previous_failures if isinstance(previous_failures,int) and previous_failures>=0 else 0
            status["all_three_models_collected"]=False
            status["previous_collection_status_preserved"]=old_status.exists()
            print(json.dumps(status,ensure_ascii=False))
            return status
        preferred=previous.get("station_ids") if isinstance(previous,dict) else None
        stations=select_public_stations(snapshot,max_sites=target,
                                        preferred_station_ids=preferred)
        status["selected_station_target"]=target
        status["adaptive_backoff_used"]=bool(
            isinstance(previous,dict) and target<previous.get("selected_station_count",0))
        status["selected_station_count"]=len(stations)
        status["station_ids"]=[str(s["id"]) for s in stations]
        status["daily_site_model_units_estimate"]=len(stations)*len(MODELS)*RUNS_PER_DAY
        status["maximum_daily_site_model_units"]=MAX_DAILY_SITE_MODEL_UNITS
        status["selection_method"]="9 anchor stations + deterministic farthest-point public stations with wind and rain observations"
        found=[]
        api_throttled=False
        for model in MODELS:
            rows=[]
            failures=[]
            successes=0
            for start in range(0,len(stations),MAX_STATIONS_PER_REQUEST):
                chunk=stations[start:start+MAX_STATIONS_PER_REQUEST]
                if api_throttled:
                    failures.append("upstream_rate_limited_stop")
                    break
                if status["calls_attempted"]>=MAX_HTTP_GETS_PER_RUN:
                    failures.append("request_budget_exhausted")
                    break
                status["calls_attempted"]+=1
                try:
                    # An HTTP 400 can be specific to one unsupported gridpoint.
                    # Isolate that public station without discarding valid peers.
                    # Never retry 401/403/429, and never exceed the run budget.
                    def fetch_bounded(subset,already_counted=False):
                        if not already_counted:
                            if status["calls_attempted"]>=MAX_HTTP_GETS_PER_RUN:
                                raise ForecastResponseError("request_budget_exhausted")
                            status["calls_attempted"]+=1
                        try:
                            return [(subset,fetcher(model,subset))]
                        except Exception as error:
                            if model!="jma_msm" or getattr(error,"code",None)!=400:
                                raise
                            if len(subset)==1:
                                failures.append("HTTP_400")
                                return []
                            midpoint=len(subset)//2
                            return (fetch_bounded(subset[:midpoint])+
                                    fetch_bounded(subset[midpoint:]))
                    batches=fetch_bounded(chunk,already_counted=True)
                    piece=[]
                    for subset,response in batches:
                        piece.extend(parse_forecast(model,subset,response,stamp))
                    if not piece:raise ValueError("No matching future hourly forecast")
                    rows.extend(piece)
                    expected={v for v in forecast_targets(stamp).values()}
                    completed={}
                    for item in piece:
                        if item["wind_ms"] is not None and item["precipitation_1h_mm"] is not None:
                            completed.setdefault(str(item["station_id"]),set()).add(item["valid_at"])
                    complete=sum(1 for site in chunk if completed.get(str(site["id"]))==expected)
                    successes+=complete
                    if complete<len(chunk):
                        failures.append("incomplete_station_or_target_hours")
                except Exception as exc:
                    # HTTP status is useful for diagnosing provider limits, but
                    # full URL/IP/token information is NEVER written to GitHub.
                    code=getattr(exc,"code",None)
                    reason=("HTTP_"+str(code) if isinstance(code,int)
                            else getattr(exc,"reason_code",type(exc).__name__))
                    failures.append(reason)
                    # Stop immediately on shared-IP rate limits or disabled
                    # access; do not retry or query other models this run.
                    if code in (401,403,429):
                        api_throttled=True
                        break
            found.extend(rows)
            status["per_model"][model]={
                "state":"ok" if not failures and successes==len(stations)
                  else ("partial" if successes else "unavailable"),
                "rows":len(rows),"stations_successful":successes,
                "failed_batches":len(failures),
                "failure_types":sorted(set(failures))
            }
        if found:
            save_daily(found,stamp,output)
        status["forecast_rows_saved"]=len(found)
        status["state"]="saved" if len(found)>0 else "no_forecasts_available"
    except Exception as exc:
        status["state"]="not_ready"
        # Avoid leaking raw third-party response bodies or full request URLs.
        status["reason"]="outside_scheduled_window" if str(exc)=="forecast_collection_outside_scheduled_hour" else type(exc).__name__
    # A "saved" collection can still have only one model and cannot support
    # three-way verification. Count consecutive imperfect scheduled runs.
    previous_count=(previous or {}).get("consecutive_model_failures",0) if isinstance(previous,dict) else 0
    if not isinstance(previous_count,int) or previous_count<0:previous_count=0
    fully_healthy=(status["state"]=="saved" and
                   all(status["per_model"].get(m,{}).get("state")=="ok" for m in MODELS))
    # Off-window manual runs are not weather failures and must not pollute streak.
    if status.get("reason")=="outside_scheduled_window":
        status["consecutive_model_failures"]=previous_count
    else:
        status["consecutive_model_failures"]=0 if fully_healthy else min(previous_count+1,1000)
    status["all_three_models_collected"]=fully_healthy
    output.mkdir(parents=True,exist_ok=True)
    (output/"collection-status.json").write_text(
        json.dumps(status,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"
    )
    print(json.dumps(status,ensure_ascii=False))
    return status

if __name__=="__main__":
    collect()
