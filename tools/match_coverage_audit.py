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
    # Separate finalized evidence from the two-day waiting period.
    finalized_by_lead={lead:lead_counts[lead]-pending_by_lead[lead] for lead in LEADS}
    current=status.get("common_three_model_station_hours",{})
    gaps={lead:max(0,current.get(LEADS[0],0)-current.get(lead,0))
          for lead in LEADS if isinstance(current.get(lead),int)}
    return {
        "finalized_cohorts_by_lead_current_window":finalized_by_lead,
        "comparison_gap_from_6h":gaps,
        "observation_alignment_diagnosis":"not_measured_from_aggregated_status",
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
    summary_path=__import__("os").environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path,"a",encoding="utf-8") as summary:
            summary.write("## Forecast match coverage (read-only)\\n")
            summary.write("Archived rows: {} | Pending rows: {}\\n\\n".format(
                report["archive_rows_reported"],report["pending_finalization_rows"]))
            summary.write("| Lead | Complete cohorts | Pending | Finalized in window | Gap vs 6h |\\n")
            summary.write("|---|---:|---:|---:|---:|\\n")
            for lead in LEADS:
                summary.write("| {}h | {} | {} | {} | {} |\\n".format(
                    lead,report["complete_cohorts_by_lead_current_window"][lead],
                    report["pending_cohorts_by_lead"][lead],
                    report["finalized_cohorts_by_lead_current_window"][lead],
                    report["comparison_gap_from_6h"].get(lead,"n/a")))
            summary.write("\\nObservation timestamp mismatch causes require row-level analysis; not inferred from totals.\\n")
    if report["eligible_unarchived_days"]:
        print("::warning::Eligible public-station matches remain unarchived")

if __name__=="__main__":
    main()
