#!/usr/bin/env python3
"""Long-horizon quality gate for public-station forecast verification (v0.35).

This module DOES NOT apply a forecast correction. Its only public output is
audit data. The rollout switch is hard-disabled until an independent release
with verified scope, shadow forecasts, weather-regime checks and safety review.
"""
import datetime as dt
import gzip
import json
import math
import random
from collections import defaultdict
from pathlib import Path

from model_verification import MODELS, VALID_QUALITY, number, timestamp, valid_rows

UTC=dt.timezone.utc
JST=dt.timezone(dt.timedelta(hours=9))
ROOT=Path(__file__).resolve().parents[1]
ARCHIVE=ROOT/"data"/"model-validation"/"matched"
KEEP_DAYS=730
# Internal conservative pilot criteria, not an international universal standard.
REQUIREMENTS={
    "history_span_days":540,
    "independent_days":300,
    "reference_stations":5,
    "calendar_months":12,
    "seasons":4,
    "days_per_season":40,
    "days_per_month":10,
    "training_days":210,
    "holdout_days":90,
    "matched_common_hours":1000,
    "wet_days":45,
    "strong_wind_days":20,
    "wet_holdout_days":10,
    "strong_holdout_days":5,
}
WIND_HIGH_MS=8.0  # Research diagnostic threshold, NOT a work-stop threshold.
RAIN_EVENT_MM=0.1

# Public AMeDAS reference stations; this is NOT the user's saved job sites.
REGIONS={"札幌":"北海道","青森":"東北","仙台":"東北","東京":"関東",
         "名古屋":"中部","大阪":"近畿","広島":"中国","福岡":"九州","那覇":"沖縄"}

def month_season(date):
    m=date.month
    return ("冬" if m in (12,1,2) else "春" if m in (3,4,5)
            else "夏" if m in (6,7,8) else "秋")

def safe_nonnegative(value):
    v=number(value)
    return v if v is not None and v>=0 else None

def observation_matches(forecasts,observations,names=None):
    """Exact matching observation hour, no future/hindsight forecast information."""
    names=names or {}
    obs_index={}
    for row in observations:
        try:
            if row.get("quality") not in VALID_QUALITY:continue
            sid=str(row["station_id"])
            valid=timestamp(row["observed_at"])
            if valid.minute or valid.second or valid.microsecond:continue
            key=(sid,valid.isoformat())
            obs_index[key]=row
        except (KeyError,TypeError,ValueError,OverflowError):
            continue
    matches=[]
    for (sid,valid_text,lead,model),fc in valid_rows(forecasts).items():
        observed=obs_index.get((sid,valid_text))
        if observed is None:continue
        valid=timestamp(valid_text)
        requested=timestamp(fc["fetched_at"])
        if requested>=valid:continue
        fw=safe_nonnegative(fc.get("wind_ms"))
        ow=safe_nonnegative(observed.get("wind_ms"))
        fr=safe_nonnegative(fc.get("precipitation_1h_mm"))
        ora=safe_nonnegative(observed.get("precipitation_1h_mm"))
        if (fw is None or ow is None) and (fr is None or ora is None):continue
        fd=number(fc.get("wind_direction_deg"))
        od=number(observed.get("wind_direction_deg"))
        local=valid.astimezone(JST)
        matches.append({
            "station_id":sid,"region":REGIONS.get(names.get(sid,""),"その他"),
            "model":model,"valid_at":valid.isoformat().replace("+00:00","Z"),
            "fetched_at":requested.isoformat().replace("+00:00","Z"),
            "lead_h":lead,"month":local.month,"season":month_season(local),
            "wind_forecast_ms":fw,"wind_observed_ms":ow,
            "rain_forecast_mm":fr,"rain_observed_mm":ora,
            "wind_direction_forecast_deg":fd%360 if fd is not None else None,
            "wind_direction_observed_deg":od%360 if od is not None else None
        })
    return matches

def identity(row):
    return (str(row["station_id"]),str(row["valid_at"]),int(row["lead_h"]),str(row["model"]))

def archive_matches(rows,archive=ARCHIVE,now=None,finalization_lag_days=2):
    """Write immutable, gzip-compressed DAILY public-station match partitions.

    Avoid continually rewriting a giant 2-year/monthly Git blob at every 6-hour
    run. Only days >=2 days old are frozen, to allow late JMA/model arrivals.
    A daily partition must contain >=5 complete 3-model cohorts or it is not
    called final. Strictly public station identifiers, no user GPS/site names.
    """
    now=now or dt.datetime.now(UTC)
    if now.tzinfo is None:raise ValueError("timezone-aware now required")
    if finalization_lag_days<1:raise ValueError("finalization lag too short")
    archive.mkdir(parents=True,exist_ok=True)
    today=now.astimezone(JST).date()
    latest_day=today-dt.timedelta(days=finalization_lag_days)
    cutoff=(now.astimezone(UTC)-dt.timedelta(days=KEEP_DAYS)).date()
    grouped=defaultdict(dict)
    for row in rows:
        try:
            when=timestamp(row["valid_at"])
            day=when.astimezone(JST).date()
            if day<cutoff or day>latest_day:continue
            key=identity(row)
            grouped[day.isoformat()][key]=row
        except (KeyError,ValueError,TypeError):
            continue
    appended=0
    for day,values in sorted(grouped.items()):
        destination=archive/(day+".jsonl.gz")
        if destination.exists():continue # immutable once a day is finalized
        payload=list(values.values())
        # Require enough matching *complete* three-model groups.
        if sum(len(common_cohorts(payload,lead)) for lead in (3,6,12,24))<5:
            continue
        if len(payload)>6000:
            raise ValueError("Daily matched archive exceeds guarded size; migrate storage")
        data="".join(
            json.dumps(values[k],ensure_ascii=False,separators=(",",":"))+"\n"
            for k in sorted(values)
        ).encode("utf-8")
        compressed=gzip.compress(data,compresslevel=8,mtime=0)
        if len(compressed)>500_000:
            raise ValueError("Compressed daily archive exceeds 500kB cap")
        destination.write_bytes(compressed)
        appended+=len(payload)
    for f in archive.glob("????-??-??.jsonl.gz"):
        try:
            day=dt.date.fromisoformat(f.name[:10])
            if day<cutoff:f.unlink()
        except ValueError:
            continue
    return appended

def read_archive(archive=ARCHIVE):
    """Read the new small daily files and any legacy monthly JSONL (if present)."""
    rows={}
    if not archive.exists():return []
    for file in sorted(archive.glob("????-??.jsonl")):
        for line in file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                item=json.loads(line)
                rows[identity(item)]=item
    for file in sorted(archive.glob("????-??-??.jsonl.gz")):
        raw=gzip.decompress(file.read_bytes()).decode("utf-8")
        for line in raw.splitlines():
            if line.strip():
                item=json.loads(line)
                rows[identity(item)]=item
    return [rows[key] for key in sorted(rows)]

def common_cohorts(rows,lead):
    """Only same station/time/lead with three independent model predictions."""
    grouped=defaultdict(dict)
    for r in rows:
        if r.get("model") not in MODELS or r.get("lead_h")!=lead:continue
        try:
            ts=timestamp(r["valid_at"])
            if timestamp(r["fetched_at"])>=ts:continue
            sid=str(r["station_id"])
        except (KeyError,TypeError,ValueError,OverflowError):continue
        # All models must be matched to the same public observing station.
        grouped[(sid,ts.isoformat())][r["model"]]=r
    def complete(group):
        if len(group)!=len(MODELS):return False
        # Candidate readiness requires *both* wind and 1h precipitation,
        # for all three models and the same quality-checked observation.
        for row in group.values():
            if any(safe_nonnegative(row.get(k)) is None for k in (
                "wind_forecast_ms","wind_observed_ms",
                "rain_forecast_mm","rain_observed_mm")):
                return False
        return True
    return [g for g in grouped.values() if complete(g)]

def daily_classification(groups):
    dates=set();months=set();seasons=set();seasons_days=defaultdict(set)
    months_days=defaultdict(set);wet_days=set();strong_days=set()
    station_ids=set()
    for g in groups:
        r=g[MODELS[0]]
        at=timestamp(r["valid_at"]).astimezone(JST)
        day=at.date().isoformat()
        dates.add(day);months.add(at.month);seasons.add(month_season(at))
        seasons_days[month_season(at)].add(day)
        months_days[at.month].add(day)
        station_ids.add(str(r["station_id"]))
        rain=safe_nonnegative(r.get("rain_observed_mm"))
        wind=safe_nonnegative(r.get("wind_observed_ms"))
        if rain is not None and rain>=RAIN_EVENT_MM:wet_days.add(day)
        if wind is not None and wind>=WIND_HIGH_MS:strong_days.add(day)
    dates_sorted=sorted(dates)
    if len(dates_sorted)>=REQUIREMENTS["holdout_days"]:
        held_days=set(dates_sorted[-REQUIREMENTS["holdout_days"]:])
    else:held_days=set()
    return {
      "independent_days":len(dates),
      "reference_stations":len(station_ids),
      "calendar_months":len(months),
      "seasons":len(seasons),
      "days_per_season":min((len(seasons_days.get(s,set())) for s in ("春","夏","秋","冬")),default=0),
      "days_per_month":min((len(months_days.get(m,set())) for m in range(1,13)),default=0),
      "training_days":max(0,len(dates)-len(held_days)),
      "holdout_days":len(held_days),
      "matched_common_hours":len(groups),
      "wet_days":len(wet_days),
      "strong_wind_days":len(strong_days),
      "wet_holdout_days":len(wet_days&held_days),
      "strong_holdout_days":len(strong_days&held_days),
      "history_span_days":(dt.date.fromisoformat(dates_sorted[-1])-dt.date.fromisoformat(dates_sorted[0])).days+1 if dates_sorted else 0,
    }

def report(rows):
    result={"schema":1,"status":"collecting_validation_evidence",
            "research_thresholds":REQUIREMENTS,
            "automatic_correction_enabled":False,
            "forecast_correction_release_authorized":False,
            "safety_threshold_wind_ms":None,
            "records_archived":len(rows),
            "lead_groups":{},
            "monthly_and_seasonal_validity_required":True,
            "notes":[
              "Thresholds are conservative pilot design goals, not universal WMO pass marks.",
              "Counts are unique independent calendar days, not multiplied by hourly observations.",
              "All three models must have the same station/time/lead to count as a fair cohort.",
              "Wind >=8 m/s is a diagnostic regime, NOT a forestry work-stop threshold.",
              "Rain, snowfall, rapid gusts, terrain effects, model-version changes and holdout skill need separate validation.",
              "No day-of-month memorization; calendar effects are season/month and pre-known conditions only.",
              "No auto-weighting, bias correction or safety judgments, even if these gates pass.",
              "Private GPS and field sites are never used for the public research archive."
            ]}
    for lead in (3,6,12,24):
        counts=daily_classification(common_cohorts(rows,lead))
        failures=[{"criterion":k,"actual":counts[k],"required":v}
                  for k,v in REQUIREMENTS.items() if counts[k]<v]
        result["lead_groups"][str(lead)]={
            "coverage":counts,"missing_requirements":failures,
            "evidence_sufficient_for_candidate_testing":len(failures)==0,
            "candidate_accepted":False,"automatic_correction_enabled":False
        }
    return result
