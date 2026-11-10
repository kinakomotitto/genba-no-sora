#!/usr/bin/env python3
"""Offline health summary for the public-station weather research pipeline.

Never sends data or claims a forecast is safe. This status is intended to make
failures visible even if the GitHub Actions run partially succeeds.
"""
import datetime as dt
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
UTC=dt.timezone.utc
AMEDAS=ROOT/"data"/"amedas"/"latest.json"
MODEL=ROOT/"data"/"model-validation"/"collection-status.json"
VERIFICATION=ROOT/"data"/"model-validation"/"status.json"
OUTPUT=ROOT/"data"/"model-validation"/"pipeline-health.json"
MAX_OBSERVATION_HOURS=9
MAX_FORECAST_HOURS=9

def utc_time(s):
    if not s or not isinstance(s,str):
        return None
    try:
        d=dt.datetime.fromisoformat(s.replace("Z","+00:00"))
        return d.astimezone(UTC) if d.tzinfo else None
    except ValueError:
        return None

def read_json(file):
    if not file.exists():
        return None
    try:
        d=json.loads(file.read_text(encoding="utf-8"))
        return d if isinstance(d,dict) else None
    except (OSError,ValueError):
        return None

def age_hours(when,now):
    value=utc_time(when)
    return round((now-value).total_seconds()/3600,2) if value else None

def assess(observation,collection,validation,now=None,previous=None):
    now=now or dt.datetime.now(UTC)
    if now.tzinfo is None:raise ValueError("timezone-aware now required")
    now=now.astimezone(UTC)
    reasons=[]
    obs_hours=age_hours((observation or {}).get("observed_at"),now)
    metrics=(observation or {}).get("metrics") or {}
    if not isinstance(metrics,dict):metrics={}
    station_count=int(metrics.get("stations",0))
    previous=previous if isinstance(previous,dict) else {}
    prior_stations=previous.get("national_observation_station_count")
    if isinstance(prior_stations,int) and not isinstance(prior_stations,bool) and prior_stations>=200:
        if station_count<prior_stations*.8:
            reasons.append("national_observation_coverage_dropped")
    for metric in ("valid_wind","valid_rain"):
        value=metrics.get(metric)
        if isinstance(value,int) and not isinstance(value,bool) and value<200:
            reasons.append("national_observation_metric_missing")
    if obs_hours is None or obs_hours<-.1 or obs_hours>MAX_OBSERVATION_HOURS:
        reasons.append("observation_missing_or_stale")
    if station_count<200:
        reasons.append("national_observation_coverage_incomplete")
    forecast_hours=age_hours((collection or {}).get("fetched_at"),now)
    if forecast_hours is None or forecast_hours<-.1 or forecast_hours>MAX_FORECAST_HOURS:
        reasons.append("forecast_collection_missing_or_stale")
    good=[k for k,v in (collection or {}).get("per_model",{}).items() if isinstance(v,dict) and v.get("state")=="ok"]
    if len(good)<3 or (collection or {}).get("state")!="saved":
        reasons.append("model_coverage_degraded")
    verification_age=age_hours((validation or {}).get("updated_at_utc"),now)
    if verification_age is None or verification_age>MAX_FORECAST_HOURS:
        reasons.append("verification_status_not_updated")
    previous_count=previous.get("consecutive_degraded_checks",0)
    if not isinstance(previous_count,int) or isinstance(previous_count,bool) or previous_count<0:
        previous_count=0
    old_at=utc_time(previous.get("assessed_at_utc"))
    if old_at is None or not (0<=((now-old_at).total_seconds()/3600)<=8.5):
        # A skipped schedule should not falsely count as consecutive checks.
        previous_count=0
    consecutive=min(previous_count+1,1000) if reasons else 0
    alert_open_eligible=consecutive>=3
    return {
        "schema":2,"assessed_at_utc":now.isoformat().replace("+00:00","Z"),
        "state":"healthy" if not reasons else "degraded",
        "consecutive_degraded_checks":consecutive,
        "sustained_outage_alert_eligible":alert_open_eligible,
        "sustained_outage_after_checks":3,
        "reasons":reasons,
        "national_observation_station_count":station_count,
        "observation_age_hours":obs_hours,
        "forecast_collection_age_hours":forecast_hours,
        "verification_age_hours":verification_age,
        "available_models":good,
        "three_model_comparison_available":len(good)==3,
        "automatic_correction_enabled":False,
        "detail":"Healthy means the research data feed is fresh, not that forecasts are accurate or safe."
    }

def run(root=ROOT,now=None):
    obs=read_json(root/"data"/"amedas"/"latest.json")
    collection=read_json(root/"data"/"model-validation"/"collection-status.json")
    validation=read_json(root/"data"/"model-validation"/"status.json")
    previous=read_json(root/"data"/"model-validation"/"pipeline-health.json")
    report=assess(obs,collection,validation,now,previous)
    output=root/"data"/"model-validation"/"pipeline-health.json"
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False))
    return report

if __name__=="__main__":
    run()
