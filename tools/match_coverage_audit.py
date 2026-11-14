#!/usr/bin/env python3
"""Read-only audit of public-station forecast/observation match coverage.

Only aggregated counters are printed. No stored files are modified and no
user location or worksite information is accessed.
"""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
STATUS=ROOT/"data"/"model-validation"/"status.json"
LEADS=("6","12","24")

def summarize(status):
    progress=status.get("match_archive_progress",{})
    days=progress.get("daily",[])
    archived=status.get("correction_readiness",{}).get("records_archived",0)
    lead_counts={lead:0 for lead in LEADS}
    pending_by_lead={lead:0 for lead in LEADS}
    for day in days:
        counts=day.get("cohorts_by_lead",{})
        for lead in LEADS:
            count=counts.get(lead,0)
            if isinstance(count,int) and count>=0:
                lead_counts[lead]+=count
                if day.get("state")=="pending_two_day_lag":
                    pending_by_lead[lead]+=count
    return {
        "archive_rows_reported":archived,
        "pending_finalization_rows":progress.get("pending_finalization_rows",0),
        "eligible_unarchived_days":progress.get("eligible_unarchived_days",0),
        "complete_cohorts_by_lead_current_window":lead_counts,
        "pending_cohorts_by_lead":pending_by_lead,
        "days_by_state":{state:sum(d.get("state")==state for d in days)
                         for state in sorted({d.get("state") for d in days if isinstance(d.get("state"),str)})},
        "recommendation":"Investigate hourly observation alignment and missing model/station values before increasing API requests.",
        "automatic_correction_enabled":False
    }

def main():
    report=summarize(json.loads(STATUS.read_text(encoding="utf-8")))
    print(json.dumps(report,ensure_ascii=False))
    if report["eligible_unarchived_days"]:
        print("::warning::Eligible public-station matches remain unarchived")

if __name__=="__main__":
    main()
