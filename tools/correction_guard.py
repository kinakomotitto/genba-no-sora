#!/usr/bin/env python3
"""Fail-closed circuit-breaker report for SHADOW correction, not live forecasts.

State transitions are explicit and deterministic; an unhealthy weather feed,
a missing model, degraded severe-weather event skill, or lack of independent
holdout evidence always falls back to the original uncorrected three models.
"""
import datetime as dt
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/"data"/"model-validation"/"correction-guard.json"

def decide(shadow,health,readiness,previous=None):
    reasons=[]
    if not isinstance(health,dict) or health.get("state")!="healthy":
        reasons.append("research_feed_not_healthy")
    if not isinstance(shadow,dict) or shadow.get("mode")!="offline_challenger_only":
        reasons.append("no_valid_shadow_experiment")
    statuses=(shadow or {}).get("by_lead",{}) if isinstance(shadow,dict) else {}
    ready=(readiness or {}).get("lead_groups",{}) if isinstance(readiness,dict) else {}
    candidates={}
    for lead in ("3","6","12","24"):
        evidence=bool(ready.get(lead,{}).get("evidence_sufficient_for_candidate_testing"))
        details=statuses.get(lead,{})
        wind=details.get("wind") if isinstance(details,dict) else None
        rain=details.get("rain") if isinstance(details,dict) else None
        passed=bool(evidence and details.get("candidate_passed_holdout")
                    and wind and wind.get("shadow_candidate_passed_strict_holdout_tests")
                    and rain and rain.get("shadow_candidate_passed_strict_holdout_tests"))
        candidates[lead]=passed
    if not any(candidates.values()):
        reasons.append("no_candidate_passed_independent_evaluation")
    # These status files may only authorize research. Never let flags in input
    # silently switch on public forecast corrections.
    previous=(previous or {}).get("shadow_state","fallback_to_original_models")
    state=("shadow_only_candidate_for_review" if not reasons else "fallback_to_original_models")
    return {
        "schema":1,"shadow_state":state,
        "previous_shadow_state":previous,
        "shadow_rollback_activated":previous=="shadow_only_candidate_for_review" and bool(reasons),
        "fallback_reason_codes":reasons,
        "candidate_lead_time_checks":candidates,
        "live_forecast_source":"original_uncorrected_models",
        "automatic_correction_enabled":False,
        "production_rollout_authorized":False,
        "user_gps_uploaded":False,
        "notice":"Shadow-only guard; no corrections can reach iPhone weather display."
    }

def run(root=ROOT):
    def read(filename):
        path=root/"data"/"model-validation"/filename
        try:return json.loads(path.read_text(encoding="utf-8"))
        except (OSError,ValueError):return {}
    shadow=read("shadow-correction.json")
    health=read("pipeline-health.json")
    main=read("status.json")
    previous=read("correction-guard.json")
    result=decide(shadow,health,main.get("correction_readiness"),previous)
    result["updated_at_utc"]=dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00","Z")
    out=root/"data"/"model-validation"/"correction-guard.json"
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"shadow_state":result["shadow_state"],
                      "automatic_correction_enabled":False,
                      "rollback":result["shadow_rollback_activated"],
                      "fail_closed_reasons":result["fallback_reason_codes"]},ensure_ascii=False))
    return result

if __name__=="__main__":
    run()
