#!/usr/bin/env python3
"""把多台机器的订阅 URL 上报到 sub-worker（v2 安全版）。

用法：
  python scripts/report.py --base https://sub.example.com --token "$REPORT_TOKEN" \
      --file machines.json

machines.json:
  {
    "sgw-oracle-nat": "https://entitled-....trycloudflare.com/xxx.txt",
    "sjc-oracle-nat": "https://psp-....trycloudflare.com/xxx.txt"
  }

相对 v1 的安全修正（审计 SW-09）：
  * token 与订阅正文都不进入 curl 的 argv（同机 `ps` 可见）：
    token 写进 0600 临时配置文件由 `curl -K` 读取，正文走 stdin。
  * 强制 https，拒绝明文地址。
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from urllib.parse import urlparse


def require_https(url, what):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        sys.exit(f"{what} 必须是 https URL: {url}")
    return url


def curl_with_config(config, data=None):
    """用 0600 临时配置调用 curl；data 通过 stdin 传入。"""
    fd, path = tempfile.mkstemp(prefix="subworker-", suffix=".curl")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(config)
        cmd = ["curl", "-K", path]
        if data is None:
            return subprocess.check_output(cmd)
        return subprocess.check_output(cmd, input=data)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def fetch(url):
    config = "\n".join([f'url = "{url}"', "silent", "show-error", "fail", "location", "max-time = 30"]) + "\n"
    return curl_with_config(config).strip()


def post_report(base, token, machine, body):
    config = "\n".join(
        [
            f'url = "{base}/api/v1/report/{machine}"',
            "request = \"POST\"",
            "silent",
            "show-error",
            "fail",
            "location",
            "max-time = 30",
            'header = "Content-Type: text/plain"',
            'header = "Authorization: Bearer ' + token.replace('"', "") + '"',
            "data-binary = @-",
        ]
    ) + "\n"
    return json.loads(curl_with_config(config, body).decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("SUB_WORKER_BASE", ""))
    ap.add_argument("--token", default=os.environ.get("SUB_TOKEN", ""), help="上报密钥（建议每机独立密钥）")
    ap.add_argument("--file", help="JSON: {machine: subscription_url}")
    ap.add_argument("--machine", action="append", default=[], help="machine=url（可重复）")
    args = ap.parse_args()

    if not args.base or not args.token:
        sys.exit("需要 --base 和 --token（或 SUB_WORKER_BASE / SUB_TOKEN）")
    base = require_https(args.base.rstrip("/"), "--base")

    machines = {}
    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            machines.update(json.load(fh))
    for item in args.machine:
        if "=" not in item:
            sys.exit(f"--machine 格式应为 machine=url: {item}")
        name, url = item.split("=", 1)
        machines[name] = url

    if not machines:
        sys.exit("没有要上报的机器")

    ok = 0
    for name, url in machines.items():
        require_https(url, f"{name} 的订阅地址")
        body = fetch(url)
        result = post_report(base, args.token, name, body)
        print(f"{name}: changed={result.get('changed')} bytes={result.get('bytes')} updated_at={result.get('updated_at')}")
        ok += 1
    print(f"done: {ok}/{len(machines)}")


if __name__ == "__main__":
    main()
