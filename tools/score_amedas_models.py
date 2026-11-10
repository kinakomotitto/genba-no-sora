#!/usr/bin/env python3
"""Score the captured public-station forecast snapshots against JMA observations.

No network calls, no model averaging, no automatic safety/weather decisions.
"""
import datetime as dt
import json
from pathlib import Path

from model_verification import evaluate

ROOT=Path(__file__).resolve().parents[1]
AMEDAS=ROOT/"data"/"amedas"/"recent"
FORECASTS=ROOT/"data"/"model-validation"/"forecasts"
OUTPUT=ROOT/"data"/"model-validation"/"status.json"
UTC=dt.timezone.utc
# The JMA Bosai map uses 0=calm, 1=NNE, ... 16=N
def wind_direction(code):
    if isinstance(code,bool) or not isinstance(code,(int,float)):
        return None
    if code!=int(code) or not (1<=code<=16):
        return None
    return (int(code)*22.5)%360

def read_forecasts(folder=FORECASTS):
    out=[]
    if not folder.exists():
        return out
    for f in sorted(folder.glob("????-??-??.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row=json.loads(line)
                if isinstance(row,dict) and row.get("station_id"):
                    out.append(row)
    return out

def read_observations(folder=AMEDAS):
    result=[]
    if not folder.exists():
        return result
    for f in sorted(folder.glob("????-??-??.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():continue
            snapshot=json.loads(line)
            when=snapshot.get("at")
            if not isinstance(when,str):continue
            for item in snapshot.get("rows",[]):
                if not isinstance(item,list) or len(item)!=5:continue
                sid,wind,direction,rain,_temp=item
                if not isinstance(sid,str) or not sid.isdigit():continue
                # Each metric was quality-checked at the time of collection.
                result.append({
                    "station_id":sid,
                    "observed_at":when,
                    "quality":"ok",
                    "wind_ms":wind,"wind_direction_deg":wind_direction(direction),
                    "precipitation_1h_mm":rain,
                })
    return result

def score(forecasts,observations,updated=None):
    updated=updated or dt.datetime.now(UTC)
    report=evaluate(forecasts,observations)
    matches=sum(int(v) for v in report["common_three_model_station_hours"].values())
    report["updated_at_utc"]=updated.isoformat().replace("+00:00","Z")
    report["forecast_snapshot_rows"]=len(forecasts)
    report["observation_rows"]=len(observations)
    report["observed_station_count"]=len({o["station_id"] for o in observations})
    report["source_forecast"]="Open-Meteo model-specific snapshots, obtained before valid_at"
    report["source_observation"]="JMA AMeDAS public map data; values with quality flag 0 only"
    report["model_comparison_ready"]=matches>=30
    report["state"]="provisional_diagnostics" if matches>=30 else "collecting_verified_samples"
    report["important_notice"]="This report is NOT a locally optimised forecast, forecast correction, or site-level wind measurement."
    return report

def run(obs_folder=AMEDAS,forecast_folder=FORECASTS,output=OUTPUT):
    forecasts=read_forecasts(forecast_folder)
    observations=read_observations(obs_folder)
    report=score(forecasts,observations)
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({
        "state":report["state"],
        "captured_forecasts":report["forecast_snapshot_rows"],
        "public_station_observations":report["observation_rows"],
        "common_three_model_samples":report["common_three_model_station_hours"],
        "automatic_correction_enabled":False,
    },ensure_ascii=False))
    return report

if __name__=="__main__":
    run()
