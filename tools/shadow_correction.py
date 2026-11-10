#!/usr/bin/env python3
"""Offline SHADOW ONLY weather correction challenger with chronological holdout.

This module never publishes an adjusted live forecast. Any reported "pass"
means only that a *candidate* merits further review, not that deployment is
authorized. All observations are from public AMeDAS sites, never user GPS.
"""
import datetime as dt
import json
import math
import random
import statistics
from collections import defaultdict
from pathlib import Path

from correction_readiness import JST, common_cohorts, timestamp, safe_nonnegative
from model_verification import MODELS

ROOT=Path(__file__).resolve().parents[1]
TRAIN_DAYS=210
HOLDOUT_DAYS=90
EVENT_WIND_MS=8.0  # descriptive only, NOT a forestry safety threshold
EVENT_RAIN_MM=5.0  # past-hour accumulation
WET_RAIN_MM=0.1
MIN_HOLDOUT_EVENT_DAYS=5
BOOTSTRAP_SAMPLES=240
SCOPE_MIN_DAYS={"region_month":45, "region_season":55, "month":35,
                "season":50, "region":70, "global":TRAIN_DAYS}
SHADOW_OUTPUT=ROOT/"data"/"model-validation"/"shadow-correction.json"

def jst_day(cohort):
    first=cohort[MODELS[0]]
    return timestamp(first["valid_at"]).astimezone(JST).date().isoformat()

def chronological_partition(cohorts,train_days=TRAIN_DAYS,holdout_days=HOLDOUT_DAYS):
    days=sorted({jst_day(g) for g in cohorts})
    if len(days)<train_days+holdout_days:
        return [],[],{"independent_days":len(days),"train_days":0,"holdout_days":0}
    held=set(days[-holdout_days:])
    trains=set(days[:-holdout_days])
    training=[g for g in cohorts if jst_day(g) in trains]
    holdout=[g for g in cohorts if jst_day(g) in held]
    return training,holdout,{
        "independent_days":len(days),"train_days":len(trains),
        "holdout_days":len(held),
        "train_through":days[-holdout_days-1],
        "holdout_since":days[-holdout_days]
    }

def value(group,model,metric):
    return safe_nonnegative(group[model][metric+"_forecast_"+("ms" if metric=="wind" else "mm")])

def truth(group,metric):
    return safe_nonnegative(group[MODELS[0]][metric+"_observed_"+("ms" if metric=="wind" else "mm")])

def median_model(group,metric):
    return statistics.median(value(group,m,metric) for m in MODELS)

def best_training_model(train,metric):
    best=None
    for model in MODELS:
        mae=sum(abs(value(g,model,metric)-truth(g,metric)) for g in train)/len(train)
        if best is None or mae<best[1]:
            best=(model,mae)
    return best

def scope_keys(group):
    row=group[MODELS[0]]
    month=int(row["month"]) if row.get("month") else timestamp(row["valid_at"]).astimezone(JST).month
    season=row.get("season")
    if not season:
        season=("冬" if month in (12,1,2) else "春" if month in (3,4,5)
                else "夏" if month in (6,7,8) else "秋")
    region=str(row.get("region") or "その他")
    return [
        ("region_month",region+"/"+str(month)),
        ("region_season",region+"/"+season),
        ("month",str(month)),
        ("season",season),
        ("region",region),
        ("global","all")
    ]

def train_adjustments(train,model,metric,minimum_train_days=TRAIN_DAYS):
    """Trains *only* on historical training dates; group size gates prevent overfit."""
    segments=defaultdict(list)
    for g in train:
        for item in scope_keys(g):
            segments[item].append(g)
    fitted={}
    for (scope,key),groups in segments.items():
        days={jst_day(g) for g in groups}
        minimum=max(5,minimum_train_days if scope=="global" else SCOPE_MIN_DAYS[scope])
        if len(days)<minimum:
            continue
        residuals=[truth(g,metric)-value(g,model,metric) for g in groups]
        if metric=="wind":
            offset=max(-1.5,min(1.5,statistics.median(residuals)))
            config={"type":"additive","offset":round(offset,4)}
        else:
            # Conservative bounded multiplicative rainfall correction.
            # Never synthesize rain from a zero forecast, don't fit on no-rain months.
            wet_days={jst_day(g) for g in groups if truth(g,metric)>=WET_RAIN_MM}
            if len(wet_days)<10:continue
            predicted=sum(value(g,model,metric) for g in groups)
            actual=sum(truth(g,metric) for g in groups)
            if predicted<1:continue
            factor=max(.75,min(1.25,actual/predicted))
            config={"type":"multiplicative","factor":round(factor,4)}
        fitted[(scope,key)]={"config":config,"days":len(days)}
    return fitted

def predict_shadow(group,model,metric,adjustments):
    base=value(group,model,metric)
    for scope in scope_keys(group):
        match=adjustments.get(scope)
        if match:
            config=match["config"]
            if metric=="wind":
                return max(0,base+config["offset"]),scope[0]
            return max(0,base*config["factor"]),scope[0]
    return base,"unadjusted_fallback"

def day_bootstrap_lower(improvements_by_day,samples=BOOTSTRAP_SAMPLES,seed=536):
    """Paired day-block bootstrap: correlated station-hours are one resampling unit."""
    days=sorted(improvements_by_day)
    if len(days)<30:return None
    rng=random.Random(seed)
    day_means=[statistics.mean(improvements_by_day[d]) for d in days]
    sampled=[]
    for _ in range(samples):
        result=[day_means[rng.randrange(len(days))] for _ in days]
        sampled.append(statistics.mean(result))
    sampled.sort()
    return round(sampled[math.floor(.025*(len(sampled)-1))],5)

def score_predictions(held,model,metric,adjustments):
    if not held:return None
    errors={"shadow":[],"baseline_selected":[],"median":[]}
    raw={m:[] for m in MODELS}
    safety={"missed_strong_wind":0,"missed_heavy_rain":0,"missed_wet":0,
            "baseline_missed_strong_wind":0,"baseline_missed_heavy_rain":0,"baseline_missed_wet":0}
    improvement=defaultdict(list)
    scope_usage=defaultdict(int)
    event_days=set()
    strong_days=set()
    wet_days=set()
    for g in held:
        day=jst_day(g)
        y=truth(g,metric)
        base=value(g,model,metric)
        corrected,scope=predict_shadow(g,model,metric,adjustments)
        scope_usage[scope]+=1
        med=median_model(g,metric)
        errors["shadow"].append(abs(corrected-y))
        errors["baseline_selected"].append(abs(base-y))
        errors["median"].append(abs(med-y))
        for m in MODELS:raw[m].append(abs(value(g,m,metric)-y))
        improvement[day].append(abs(base-y)-abs(corrected-y))
        if metric=="wind" and y>=EVENT_WIND_MS:
            event_days.add(day)
            strong_days.add(day)
            if corrected<EVENT_WIND_MS:safety["missed_strong_wind"]+=1
            if base<EVENT_WIND_MS:safety["baseline_missed_strong_wind"]+=1
        if metric=="rain":
            if y>=WET_RAIN_MM:
                wet_days.add(day)
                if corrected<WET_RAIN_MM:safety["missed_wet"]+=1
                if base<WET_RAIN_MM:safety["baseline_missed_wet"]+=1
            if y>=EVENT_RAIN_MM:
                event_days.add(day)
                if corrected<EVENT_RAIN_MM:safety["missed_heavy_rain"]+=1
                if base<EVENT_RAIN_MM:safety["baseline_missed_heavy_rain"]+=1
    n=len(held)
    def mae(a):return round(statistics.mean(a),4)
    best_model=min(raw,key=lambda m:statistics.mean(raw[m]))
    lower=day_bootstrap_lower(improvement)
    improvement_selected=mae(errors["baseline_selected"])-mae(errors["shadow"])
    improved_vs_all=all(mae(errors["shadow"])<mae(data) for data in raw.values())
    pass_safety=(safety["missed_strong_wind"]<=safety["baseline_missed_strong_wind"]
                and safety["missed_heavy_rain"]<=safety["baseline_missed_heavy_rain"]
                and safety["missed_wet"]<=safety["baseline_missed_wet"])
    sufficient_event_days=len(strong_days if metric=="wind" else wet_days)>=MIN_HOLDOUT_EVENT_DAYS
    # Precise promotion conditions are deliberately strict and are not a release authorization.
    gate=bool(lower is not None and lower>0 and improved_vs_all and
              mae(errors["shadow"])<mae(errors["median"]) and pass_safety and sufficient_event_days)
    return {
        "independent_holdout_days":len(improvement),
        "matched_holdout_station_hours":n,"model_used":model,
        "shadow_mae":mae(errors["shadow"]),
        "selected_raw_mae":mae(errors["baseline_selected"]),
        "median_raw_mae":mae(errors["median"]),
        "best_raw_model_in_holdout_FOR_DIAGNOSTIC_ONLY":best_model,
        "best_raw_model_mae":mae(raw[best_model]),
        "mae_improvement_vs_selected_raw":round(improvement_selected,4),
        "day_block_bootstrap_95pct_lower_improvement":lower,
        "strong_event_days":len(strong_days),"wet_event_days":len(wet_days),
        "safety_counts":safety,"scope_usage":dict(scope_usage),
        "shadow_candidate_passed_strict_holdout_tests":gate
    }

def trial(rows,readiness=None,min_train_days=TRAIN_DAYS,holdout_days=HOLDOUT_DAYS):
    """Compute isolated evidence. No live weather endpoint reads the result."""
    output={
        "schema":1,"state":"collecting_data",
        "mode":"offline_challenger_only",
        "experiment_scope":"public_station_only",
        "automatic_correction_enabled":False,
        "release_authorized":False,
        "candidate_selected_for_app":None,
        "approved_model_weights":None,
        "by_lead":{},
        "cautions":[
            "Candidate models are fit only on preceding dates; withheld dates never tune parameters.",
            "No live app, push notification, GPS, job-site forecasts or safety decisions are modified.",
            "Even a passing holdout challenger does not prove mountain/forestry-site accuracy.",
            "Rainfall is one-hour total; strong-event cutoffs are research diagnostics, not work thresholds."
        ]
    }
    for lead in (3,6,12,24):
        common=common_cohorts(rows,lead)
        train,held,split=chronological_partition(common,min_train_days,holdout_days)
        result={"split":split,"status":"insufficient_history","wind":None,"rain":None,
                "candidate_for_public_release":False}
        if train and held:
            result["status"]="shadow_evaluated"
            for metric in ("wind","rain"):
                model,_=best_training_model(train,metric)
                adjustments=train_adjustments(train,model,metric,min_train_days)
                result[metric]=score_predictions(held,model,metric,adjustments)
            candidate_pass=all(result[k] and
                result[k]["shadow_candidate_passed_strict_holdout_tests"] for k in ("wind","rain"))
            readiness_pass=bool(readiness and readiness.get("lead_groups",{}).get(str(lead),{})
                .get("evidence_sufficient_for_candidate_testing",False))
            result["candidate_passed_holdout"]=candidate_pass
            result["long_term_evidence_passed"]=readiness_pass
            if candidate_pass and readiness_pass:
                result["status"]="passes_shadow_checks_requires_separate_release_review"
                # Deliberately never automatically authorize a live change.
        output["by_lead"][str(lead)]=result
    return output

def save_trial(rows,readiness=None,output=SHADOW_OUTPUT,now=None):
    result=trial(rows,readiness)
    now=now or dt.datetime.now(dt.timezone.utc)
    result["evaluated_at_utc"]=now.isoformat().replace("+00:00","Z")
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"state":result["state"],"automatic_correction_enabled":False,
                      "lead_statuses":{k:v["status"] for k,v in result["by_lead"].items()}},
                     ensure_ascii=False))
    return result
