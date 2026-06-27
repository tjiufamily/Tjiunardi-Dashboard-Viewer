#!/usr/bin/env python3
"""
Yahoo Quote Cache Refresh — Hermes cron wrapper (Windows Store Python, no sandbox DNS issues).
"""
import os
import subprocess
import sys
from pathlib import Path

GOOD_PYTHON = Path(
    r"C:\Users\tjiun\AppData\Local\Microsoft\WindowsApps"
    r"\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe"
)

WORKER = Path(__file__).resolve().parent / "yahoo_quote_refresh_worker.py"


def main() -> int:
    if not GOOD_PYTHON.is_file():
        print(f"ERROR: Python not found at {GOOD_PYTHON}", flush=True)
        return 1
    if not WORKER.is_file():
        print(f"ERROR: Worker not found at {WORKER}", flush=True)
        return 1

    clean_env: dict[str, str] = {}
    keep_prefixes = (
        "SYSTEM",
        "USER",
        "COMPUTER",
        "PATH",
        "TEMP",
        "TMP",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "WINDIR",
        "SYSTEMROOT",
        "PROGRAM",
        "ONEDRIVE",
        "OS",
        "PROCESSOR",
        "NUMBER_OF",
        "PATHEXT",
        "COMSPEC",
        "SUPABASE",
    )
    for k, v in os.environ.items():
        if any(k.startswith(p) for p in keep_prefixes):
            clean_env[k] = v
    for bad in ("PYTHONPATH", "PYTHONUSERBASE", "VIRTUAL_ENV", "HERMES_SANDBOX", "HERMES_HOME"):
        clean_env.pop(bad, None)
    clean_env["PYTHONUTF8"] = "1"
    clean_env["PYTHONIOENCODING"] = "utf-8"

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )

    print(f"Spawning Yahoo quote refresh via {GOOD_PYTHON}...", flush=True)
    proc = subprocess.run(
        [str(GOOD_PYTHON), str(WORKER)],
        capture_output=True,
        text=True,
        timeout=180,
        env=clean_env,
        creationflags=creationflags,
        cwd=str(WORKER.parent),
    )
    if proc.stdout:
        print(proc.stdout, flush=True)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, flush=True)
    if proc.returncode != 0:
        print(f"Worker failed with exit code {proc.returncode}", flush=True)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
