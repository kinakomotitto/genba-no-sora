#!/usr/bin/env python3
"""Read-only diagnostic of scheduled GitHub Actions start delays.

Never equate a green Actions result with a successful weather-data collection.
No personal locations or tokens are persisted.
"""
import datetime as dt
import json
import os
import urllib.request

UTC=dt.timezone.utc
SCHEDULE_HOURS=(0,6,12,18)
SCHEDULE_MINUTE=12
WARN_MINUTES=30

def expected_slot(started):
    if started.tzinfo is None:
        raise ValueError("timezone-aware start required")
    now=started.astimezone(UTC)
    options=[]
    for days_back in (0,1):
        date=(now-dt.timedelta(days=days_back)).date()
        for hour in SCHEDULE_HOURS:
            slot=dt.datetime.combine(date,dt.time(hour,SCHEDULE_MINUTE),UTC)
            if slot<=now:
                options.append(slot)
    return max(options)

def diagnose(started,scheduled_event=True):
    if not scheduled_event:
        return {"state":"not_scheduled","delay_minutes":None}
    slot=expected_slot(started)
    minutes=round((started-slot).total_seconds()/60,1)
    return {"state":"late" if minutes>WARN_MINUTES else "on_time",
            "expected_at_utc":slot.isoformat(),
            "observed_at_utc":started.astimezone(UTC).isoformat(),
            "delay_minutes":minutes,
            "warning_threshold_minutes":WARN_MINUTES,
            "note":"Workflow start delay only; not evidence of model collection success."}

def main():
    event=os.environ.get("GITHUB_EVENT_NAME","")
    if event!="schedule":
        print(json.dumps(diagnose(dt.datetime.now(UTC),False)))
        return
    token=os.environ.get("GH_TOKEN")
    repo=os.environ.get("GITHUB_REPOSITORY")
    run_id=os.environ.get("GITHUB_RUN_ID")
    if not token or not repo or not run_id:
        print("::warning::Schedule timing unavailable: missing GitHub run metadata")
        return
    url=f"https://api.github.com/repos/{repo}/actions/runs/{run_id}"
    request=urllib.request.Request(url,headers={
        "Authorization":f"Bearer {token}",
        "Accept":"application/vnd.github+json",
        "User-Agent":"genba-no-sora-schedule-audit"})
    try:
        with urllib.request.urlopen(request,timeout=10) as response:
            run=json.load(response)
        started=dt.datetime.fromisoformat(run["run_started_at"].replace("Z","+00:00"))
        report=diagnose(started)
        print(json.dumps(report,ensure_ascii=False))
        if report["state"]=="late":
            print(f"::warning::Scheduled workflow started {report['delay_minutes']} minutes late")
    except (OSError,ValueError,KeyError,TypeError) as exc:
        print(f"::warning::Schedule timing unavailable ({type(exc).__name__})")

if __name__=="__main__":
    main()
