#!/usr/bin/env python3
"""Audit weather model performance across lead, month, season, region and day/night.

Every score uses only three-model common station/time cohorts. No model is ever
automatically promoted; event sample sizes and calendar-day diversity reported.
"""
import datetime as dt
import math
from collections import defaultdict

from correction_readiness import common_cohorts, month_season, safe_nonnegative, timestamp, JST
from model_verification import MODELS, angle_error, number

WIND_REGIME_MS=8.0  # Analysis regime, NOT an occupational safety threshold.
WET_MM=0.1
HEAVY_MM=5.0
MIN_DAYS=30
MIN_EVENT_DAYS=15

def pct(numerator,denominator):
    return round(numerator/denominator,3) if denominator else None

def observed_contingency(forecast,observed,limit):
    hits=sum(1 for p,y in zip(forecast,observed) if y>=limit and p>=limit)
    misses=sum(1 for p,y in zip(forecast,observed) if y>=limit and p<limit)
    false=sum(1 for p,y in zip(forecast,observed) if y<limit and p>=limit)
    return {"hits":hits,"misses":misses,"false_alarms":false,
            "detection_rate":pct(hits,hits+misses),
            "false_alarm_ratio":pct(false,hits+false),
            "threat_score":pct(hits,hits+misses+false)}

def score_group(group,model):
    rows=[item[model] for item in group]
    days={timestamp(row["valid_at"]).astimezone(JST).date().isoformat() for row in rows}
    wind=[(number(r.get("wind_forecast_ms")),number(r.get("wind_observed_ms"))) for r in rows]
    rain=[(number(r.get("rain_forecast_mm")),number(r.get("rain_observed_mm"))) for r in rows]
    if not all(None not in pair for pair in wind+rain):
        raise ValueError("Expected only comparable samples")
    wa=[abs(p-y) for p,y in wind];ra=[abs(p-y) for p,y in rain]
    n=len(rows)
    wind_bias=sum(p-y for p,y in wind)/n if n else None
    direction=[]
    for r in rows:
        p,y=number(r.get("wind_direction_forecast_deg")),number(r.get("wind_direction_observed_deg"))
        w=number(r.get("wind_observed_ms"))
        if None not in (p,y,w) and w>=1:
            direction.append(angle_error(p,y))
    def event_days(metric,threshold):
        return len({timestamp(r["valid_at"]).astimezone(JST).date().isoformat()
                    for r in rows if r[metric]>=threshold})
    wet_days=event_days("rain_observed_mm",WET_MM)
    strong_days=event_days("wind_observed_ms",WIND_REGIME_MS)
    heavy_days=event_days("rain_observed_mm",HEAVY_MM)
    # More samples from one storm/day cannot replace a diverse weather history.
    scorable=len(days)>=MIN_DAYS
    return {
      "model":model,"matched_station_hours":n,"independent_calendar_days":len(days),
      "wet_event_days":wet_days,"strong_wind_event_days":strong_days,
      "heavy_precip_event_days":heavy_days,
      "status":"provisional_only" if scorable else "insufficient_independent_days",
      "wind_mae_ms":round(sum(wa)/n,3) if scorable else None,
      "wind_rmse_ms":round(math.sqrt(sum((p-y)**2 for p,y in wind)/n),3) if scorable else None,
      "wind_mean_bias_ms":round(wind_bias,3) if scorable else None,
      "wind_p90_absolute_error_ms":round(sorted(wa)[max(0,math.ceil(.9*n)-1)],3) if scorable else None,
      "wind_direction_mae_deg":round(sum(direction)/len(direction),2)
        if scorable and len(direction)>=MIN_DAYS else None,
      "wind_8ms_event_skill":observed_contingency([p for p,_ in wind],[y for _,y in wind],WIND_REGIME_MS)
        if scorable and strong_days>=MIN_EVENT_DAYS else None,
      "precipitation_mae_mm":round(sum(ra)/n,3) if scorable else None,
      "precipitation_wet_skill":observed_contingency([p for p,_ in rain],[y for _,y in rain],WET_MM)
        if scorable and wet_days>=MIN_EVENT_DAYS else None,
      "precipitation_5mm_skill":observed_contingency([p for p,_ in rain],[y for _,y in rain],HEAVY_MM)
        if scorable and heavy_days>=MIN_EVENT_DAYS else None,
    }

def audit(records):
    output={
      "schema":1,"state":"shadow_verification_only",
      "strong_wind_diagnostic_threshold_ms":WIND_REGIME_MS,
      "heavy_precip_diagnostic_threshold_mm_per_h":HEAVY_MM,
      "ranked_winner":None,"automatic_weights_enabled":False,
      "wind_and_precipitation_scores":{
        "by_lead":{},"by_season_6h":{},"by_month_6h":{},
        "by_region_6h":{},"by_daynight_6h":{}
      },
      "notes":[
        "No grade is released without >=30 independent days; event skill requires >=15 event days.",
        "Only the same public station, target hour and forecast lead where all 3 models have wind and precipitation count.",
        "No ranking before an independent chronological holdout, confidence intervals and checks that severe-weather misses do not rise.",
        "Monthly, seasonal, regional and day/night breakdowns are descriptive; no automatic personalised onsite correction.",
        "8 m/s and 5 mm/h are RESEARCH event categories, not official warnings or site work-stop thresholds."
      ]
    }
    out=output["wind_and_precipitation_scores"]
    for lead in (3,6,12,24):
        cohorts=common_cohorts(records,lead)
        out["by_lead"][str(lead)]=[score_group(cohorts,m) for m in MODELS]
        if lead!=6:continue
        for table,selector in (
            ("by_season_6h",lambda row: month_season(timestamp(row["valid_at"]).astimezone(JST))),
            ("by_month_6h",lambda row: f'{timestamp(row["valid_at"]).astimezone(JST).month:02d}'),
            ("by_region_6h",lambda row: row.get("region") or "その他"),
            ("by_daynight_6h",lambda row: "昼" if 6<=timestamp(row["valid_at"]).astimezone(JST).hour<18 else "夜")
        ):
            groups=defaultdict(list)
            for g in cohorts:
                key=selector(g[MODELS[0]])
                groups[key].append(g)
            out[table]={key:[score_group(records,m) for m in MODELS]
                        for key,records in sorted(groups.items())}
    return output
