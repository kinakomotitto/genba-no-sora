#!/usr/bin/env python3
"""Best-effort Github Issue alert for repeated public-weather research outages.

One open Issue per incident; close when research feed recovers. Github repo
followers' notification settings determine push/email; no app push is implied.
"""
import json
import os
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
HEALTH=ROOT/"data"/"model-validation"/"pipeline-health.json"
TITLE="現場の空：気象学習データ収集が3回連続で異常"
ALLOWED_REASONS={
    "observation_missing_or_stale":"全国実測が9時間超未更新",
    "national_observation_coverage_incomplete":"全国実測地点が200未満",
    "forecast_collection_missing_or_stale":"3モデルの収集記録が9時間超未更新",
    "model_coverage_degraded":"3モデルがそろわない",
    "verification_status_not_updated":"精度検証の結果が9時間超未更新",
}

def recommended_action(status,issues):
    if not isinstance(status,dict):return ("none",None)
    matching=[i for i in issues if i.get("title")==TITLE and i.get("state")=="OPEN"]
    current=matching[0] if matching else None
    count=status.get("consecutive_degraded_checks")
    if status.get("state")=="degraded" and isinstance(count,int) and not isinstance(count,bool) and count>=3:
        return ("none",None) if current else ("open",None)
    if status.get("state")=="healthy" and current:
        return ("close",current.get("number"))
    return ("none",None)

def issue_body(status):
    reasons=[ALLOWED_REASONS.get(reason,"不明な収集異常")
             for reason in status.get("reasons",[])]
    reasons=list(dict.fromkeys(reasons))
    return (
      "## 自動生成：研究用気象データの連続異常\n\n"
      f"GitHub Actionsで **{status.get('consecutive_degraded_checks',0)}回** 連続して"
      "公開アメダス・3モデルの研究用データに問題が見つかったため、確認を促します。\n\n"
      "原因候補（公開コードのみ）：\n"+
      "".join(f"- {line}\n" for line in reasons)+
      "\n**本番アプリの天気表示やiPhone通知が止まったと断定するものではありません。** "
      "自動補正は無効のままで、元の予報が使われます。\n\n"
      "確認する場所：GitHub Actions → 「全国アメダス・３モデル予報の自動検証」。"
      "実行ログと data/model-validation/collection-status.json のモデル別失敗理由を確認してください。\n\n"
      "復旧後の正常チェックでは、このIssueを自動で閉じます。\n"
    )

def gh(*args):
    p=subprocess.run(["gh",*args],check=True,capture_output=True,text=True,timeout=30)
    return p.stdout

def main():
    if os.environ.get("GITHUB_ACTIONS")!="true" or not os.environ.get("GH_TOKEN"):
        print("No GitHub Actions token: no notification action")
        return
    status=json.loads(HEALTH.read_text(encoding="utf-8"))
    issues=json.loads(gh("issue","list","--state","all","--limit","200","--json","number,title,state"))
    action,issue_number=recommended_action(status,issues)
    if action=="open":
        gh("issue","create","--title",TITLE,"--body",issue_body(status))
        print("Opened one sustained-outage GitHub Issue")
    elif action=="close" and isinstance(issue_number,int):
        gh("issue","close",str(issue_number),
           "--comment","公開気象データの健康状態が正常に回復したため、この異常検知Issueを自動で閉じます。")
        print("Closed recovered sustained-outage GitHub Issue")
    else:
        print("No new sustained-outage notification needed")

if __name__=="__main__":
    main()
