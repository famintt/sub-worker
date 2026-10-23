#!/usr/bin/env python3
"""把多台机器的订阅 URL 上报到 sub-worker。

用法：
  python scripts/report.py --base https://xxx.workers.dev --token "$TOKEN" \
      --file machines.json

machines.json:
  {
    "sgw-oracle-nat": "https://entitled-....trycloudflare.com/xxx.txt",
    "sjc-oracle-nat": "https://psp-....trycloudflare.com/xxx.txt"
  }

只依赖 curl，避免 Python urllib 被 Cloudflare 的 bot 规则拦截。
"""

import argparse
import json
import os
import subprocess
import sys


def curl(args):
    return subprocess.check_output(["curl", "-fsSL", *args])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("SUB_WORKER_BASE", ""))
    ap.add_argument("--token", default=os.environ.get("SUB_TOKEN", ""))
    ap.add_argument("--file", help="JSON: {machine: subscription_url}")
    ap.add_argument("--machine", action="append", default=[], help="machine=url（可重复）")
    args = ap.parse_args()

    if not args.base or not args.token:
        sys.exit("需要 --base 和 --token（或 SUB_WORKER_BASE / SUB_TOKEN）")

    machines = {}
    if args.file:
        machines.update(json.load(open(args.file, encoding="utf-8")))
    for item in args.machine:
        if "=" not in item:
            sys.exit(f"--machine 格式应为 machine=url: {item}")
        name, url = item.split("=", 1)
        machines[name] = url

    if not machines:
        sys.exit("没有要上报的机器")

    ok = 0
    for name, url in machines.items():
        body = curl([url]).strip()
        result = json.loads(
            curl(
                [
                    "-X",
                    "POST",
                    "-H",
                    f"Authorization: Bearer {args.token}",
                    "--data-binary",
                    body.decode("ascii"),
                    f"{args.base.rstrip('/')}/api/v1/report/{name}",
                ]
            )
        )
        print(f"{name}: changed={result.get('changed')} bytes={result.get('bytes')} updated_at={result.get('updated_at')}")
        ok += 1
    print(f"done: {ok}/{len(machines)}")


if __name__ == "__main__":
    main()
