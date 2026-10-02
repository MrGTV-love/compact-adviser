"""Run a macOS live smoke command after an atomic shared resource/start claim."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time


def claim_start(stamp, now, load, free, max_load, min_free, spacing):
    # Lock the existing stamp, not a new private copy or a replacement inode.
    # Release before the command: this enforces start spacing, not concurrency.
    with open(stamp, "r+", encoding="utf-8") as shared:
        fcntl.flock(shared, fcntl.LOCK_EX)
        previous = int(shared.read().strip())
        sample = {
            "epoch": now,
            "load1": load,
            "memory_free_pct": free,
            "fleet_last_start": previous,
            "seconds_since_fleet_start": now - previous,
            "ready": load < max_load and free >= min_free and now - previous >= spacing,
        }
        if sample["ready"]:
            shared.seek(0)
            shared.write(f"{now}\n")
            shared.truncate()
            shared.flush()
            os.fsync(shared.fileno())
            sample["recorded_shared_start"] = now
        return sample


def memory_free():
    output = subprocess.check_output(["memory_pressure", "-Q"], text=True)
    match = re.search(r"System-wide memory free percentage: (\d+)%", output)
    if match is None:
        raise ValueError("memory_pressure did not report free memory")
    return int(match.group(1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stamp", required=True, type=Path)
    parser.add_argument("--receipts", required=True, type=Path)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--max-load", required=True, type=float)
    parser.add_argument("--min-free", required=True, type=int)
    parser.add_argument("--spacing", required=True, type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a live command after -- is required")
    if args.max_load <= 0 or not 0 <= args.min_free <= 100 or args.spacing < 0:
        parser.error("invalid resource/start policy")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    while True:
        free = memory_free()
        sample = claim_start(args.stamp, int(time.time()), os.getloadavg()[0], free,
                             args.max_load, args.min_free, args.spacing)
        sample.update(scenario=args.scenario, head=head,
                      phase="start" if sample["ready"] else "wait")
        with args.receipts.open("a", encoding="utf-8") as receipts:
            receipts.write(json.dumps(sample) + "\n")
        if sample["ready"]:
            break
        time.sleep(30)
    with args.log.open("w", encoding="utf-8") as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    end = {"scenario": args.scenario, "head": head, "phase": "end",
           "epoch": int(time.time()), "exit": result.returncode}
    with args.receipts.open("a", encoding="utf-8") as receipts:
        receipts.write(json.dumps(end) + "\n")
    print(json.dumps(end))
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
