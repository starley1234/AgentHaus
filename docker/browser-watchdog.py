#!/usr/bin/env python3
"""Container-level watchdog for runaway / orphaned Chromium processes.

Why this exists
---------------
The agent-server already guards *its own* browser
(``openhands.tools.browser_use.process_guard``).  But the failure we actually
hit took the whole server down with it: a Chromium ``--type=gpu-process``
helper survived its parent, was re-parented to PID 1 (the bash entrypoint,
which never reaps), and burned ~99% of one core for 64 hours of CPU time.
Every neighbour in the container then started timing out — the Telegram bridge
spammed ``poll error: ETIMEDOUT`` and bash requests never returned.

This script is the outer defence layer.  It is deliberately:

* **standalone** — pure standard library, no imports from the SDK, so it keeps
  working when the agent-server is dead, wedged or being restarted;
* **conservative** — it only ever signals processes that are unmistakably
  Chromium/Chrome/Edge *and* belong to automation (guard marker on the command
  line, or a browser-use profile directory).  A browser a human opened in the
  VNC desktop is left alone unless it pins a core for many minutes;
* **cheap** — one /proc scan every ``OH_BROWSER_WATCHDOG_INTERVAL_SECONDS``.

What it does
------------
1. ``renice`` every automation browser process (``+OH_BROWSER_NICE_LEVEL``,
   default 10) so a spinning browser can never starve the Python/Node event
   loops sharing the container.
2. Kill browser processes whose parent is gone (orphans) — the exact shape of
   the incident.
3. Kill a browser process that keeps using ≥ ``CPU_PERCENT`` of a core for
   ``CPU_SECONDS`` while nothing else is happening.
4. Kill a browser process that exceeded an absolute CPU-time budget
   (``MAX_CPU_MINUTES``) or lifetime (``MAX_AGE_MINUTES``).

Usage
-----
    browser-watchdog.py             # run forever (started by entrypoint.sh)
    browser-watchdog.py --sweep     # one pass: kill orphans, then exit
    browser-watchdog.py --status    # print a JSON report, then exit
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path


LOG_PREFIX = "[browser-watchdog]"

GUARD_FLAG = "--oh-browser-guard"
USER_DATA_DIR_FLAG = "--user-data-dir="
BROWSER_HINTS = ("chrome", "chromium", "headless_shell", "msedge", "brave")
# Profile dirs browser-use creates for automation runs.
AUTOMATION_PROFILE_HINTS = (
    "browser-use-user-data-dir-",
    "browseruse-tmp-",
    ".config/browseruse",
)


def env_float(name: str, default: float, *, allow_zero: bool = False) -> float:
    """Read a positive float; ``allow_zero`` makes 0 mean "disabled"."""
    raw = os.environ.get(name, "")
    if not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        log(f"ignoring non-numeric {name}={raw!r}, using {default}")
        return default
    if value > 0:
        return value
    if value == 0 and allow_zero:
        return 0.0
    log(f"ignoring non-positive {name}={raw!r}, using {default}")
    return default


def env_int(name: str, default: int, *, allow_zero: bool = False) -> int:
    return int(env_float(name, float(default), allow_zero=allow_zero))


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "")
    if not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def log(message: str) -> None:
    print(f"{LOG_PREFIX} {message}", flush=True)


# ── /proc sampling ──────────────────────────────────────────────────────────

PROC = Path(os.environ.get("OH_BROWSER_WATCHDOG_PROCFS", "/proc"))
CLK_TCK = float(os.sysconf("SC_CLK_TCK"))
PAGE_SIZE = float(os.sysconf("SC_PAGE_SIZE"))


def boot_epoch() -> float:
    try:
        with (PROC / "stat").open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.startswith("btime "):
                    return float(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return time.time()


BOOT_EPOCH = boot_epoch()


class Proc:
    __slots__ = (
        "pid",
        "ppid",
        "cpu_seconds",
        "rss_bytes",
        "start_epoch",
        "argv",
        "nice",
    )

    def __init__(
        self,
        pid: int,
        ppid: int,
        cpu_seconds: float,
        rss_bytes: int,
        start_epoch: float,
        argv: list[str],
        nice: int,
    ) -> None:
        self.pid = pid
        self.ppid = ppid
        self.cpu_seconds = cpu_seconds
        self.rss_bytes = rss_bytes
        self.start_epoch = start_epoch
        self.argv = argv
        self.nice = nice

    @property
    def name(self) -> str:
        return Path(self.argv[0]).name.lower() if self.argv else ""

    @property
    def is_browser(self) -> bool:
        return self.guard_token is not None or any(
            hint in self.name for hint in BROWSER_HINTS
        )

    @property
    def is_helper(self) -> bool:
        return any(arg.startswith("--type=") for arg in self.argv)

    @property
    def helper_type(self) -> str:
        for arg in self.argv:
            if arg.startswith("--type="):
                return arg[len("--type=") :] or "unknown"
        return "browser"

    @property
    def guard_token(self) -> str | None:
        prefix = f"{GUARD_FLAG}="
        for arg in self.argv:
            if arg.startswith(prefix):
                return arg[len(prefix) :]
        return None

    @property
    def user_data_dir(self) -> str:
        for arg in self.argv:
            if arg.startswith(USER_DATA_DIR_FLAG):
                return arg[len(USER_DATA_DIR_FLAG) :]
        return ""

    @property
    def is_automation(self) -> bool:
        if self.guard_token is not None:
            return True
        data_dir = self.user_data_dir.lower()
        return any(hint in data_dir for hint in AUTOMATION_PROFILE_HINTS)

    @property
    def cpu_minutes(self) -> float:
        return self.cpu_seconds / 60.0

    @property
    def age_minutes(self) -> float:
        return max(0.0, time.time() - self.start_epoch) / 60.0

    @property
    def rss_mb(self) -> float:
        return self.rss_bytes / (1024.0 * 1024.0)


def read_proc(pid: int) -> Proc | None:
    try:
        raw = (PROC / str(pid) / "stat").read_text(encoding="utf-8", errors="replace")
        cmdline = (PROC / str(pid) / "cmdline").read_bytes()
    except (OSError, ValueError):
        return None
    argv = [
        part.decode("utf-8", errors="replace")
        for part in cmdline.split(b"\x00")
        if part
    ]
    if not argv:
        return None  # kernel thread
    try:
        tail = raw[raw.rindex(")") + 2 :].split()
        if len(tail) < 22:
            return None
        # tail[i] holds field (i + 3) of proc(5) — state is field 3.
        return Proc(
            pid=pid,
            ppid=int(tail[1]),
            cpu_seconds=(float(tail[11]) + float(tail[12])) / CLK_TCK,
            rss_bytes=int(float(tail[21]) * PAGE_SIZE),
            start_epoch=BOOT_EPOCH + float(tail[19]) / CLK_TCK,
            argv=argv,
            nice=int(float(tail[16])),
        )
    except (ValueError, IndexError):
        return None


def sample() -> dict[int, Proc]:
    procs: dict[int, Proc] = {}
    try:
        entries = os.listdir(PROC)
    except OSError:
        return procs
    for entry in entries:
        if not entry.isdigit():
            continue
        info = read_proc(int(entry))
        if info is not None:
            procs[info.pid] = info
    return procs


def descendants(root: int, procs: dict[int, Proc]) -> list[int]:
    children: dict[int, list[int]] = {}
    for pid, info in procs.items():
        children.setdefault(info.ppid, []).append(pid)
    seen: set[int] = set()
    stack = [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, ()))
    return sorted(seen)


# ── actions ─────────────────────────────────────────────────────────────────


def signal_pid(pid: int, sig: int) -> bool:
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError) as e:
        log(f"could not signal pid {pid} ({sig}): {e}")
        return False


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def kill_tree(pids: list[int], grace_seconds: float = 5.0) -> None:
    """SIGTERM, wait, then SIGKILL. Per-PID only — never killpg(): the browser
    shares the container's main process group."""
    for pid in pids:
        signal_pid(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if not any(alive(pid) for pid in pids):
            return
        time.sleep(0.25)
    for pid in pids:
        if alive(pid):
            signal_pid(pid, signal.SIGKILL)


def renice(info: Proc, level: int) -> None:
    if level <= 0 or info.nice >= level:
        return
    prio_process = getattr(os, "PRIO_PROCESS", None)
    if prio_process is None:
        return
    try:
        os.setpriority(prio_process, info.pid, level)
        log(
            f"reniced pid={info.pid} ({info.helper_type}) to +{level} so it "
            f"cannot starve the agent server / bridges"
        )
    except (OSError, ValueError) as e:
        log(f"could not renice pid={info.pid}: {e}")


def sweep_orphans(procs: dict[int, Proc], *, dry_run: bool = False) -> list[dict]:
    """Kill automation browsers whose parent process no longer exists."""
    own_pid = os.getpid()
    swept: list[dict] = []
    handled: set[int] = set()
    for pid, info in procs.items():
        if pid in handled or pid == own_pid or info.ppid == own_pid:
            continue
        if not info.is_browser or not info.is_automation:
            continue
        if info.ppid != 1 and info.ppid in procs:
            continue  # parent alive → not an orphan
        tree = descendants(pid, procs)
        handled.update(tree)
        record = {
            "pid": pid,
            "type": info.helper_type,
            "cpu_minutes": round(info.cpu_minutes, 1),
            "age_minutes": round(info.age_minutes, 1),
            "tree": tree,
        }
        swept.append(record)
        if dry_run:
            continue
        log(
            "orphaned browser process pid={pid} type={type} "
            "cpu_minutes={cpu} age_minutes={age} — killing tree {tree}".format(
                pid=pid,
                type=record["type"],
                cpu=record["cpu_minutes"],
                age=record["age_minutes"],
                tree=tree,
            )
        )
        kill_tree(tree, grace_seconds=3.0)
    return swept


# ── main loop ───────────────────────────────────────────────────────────────

_STOP = False


def _handle_stop(signum, _frame) -> None:
    global _STOP
    _STOP = True
    log(f"received signal {signum}, shutting down")


def report(procs: dict[int, Proc]) -> list[dict]:
    return [
        {
            "pid": info.pid,
            "ppid": info.ppid,
            "type": info.helper_type,
            "automation": info.is_automation,
            "cpu_minutes": round(info.cpu_minutes, 1),
            "age_minutes": round(info.age_minutes, 1),
            "rss_mb": round(info.rss_mb, 1),
            "nice": info.nice,
        }
        for info in sorted(procs.values(), key=lambda p: -p.cpu_seconds)
        if info.is_browser
    ]


def watch() -> int:
    interval = max(5.0, env_float("OH_BROWSER_WATCHDOG_INTERVAL_SECONDS", 20.0))
    # 0 disables the individual check.
    cpu_limit = env_float("OH_BROWSER_WATCHDOG_CPU_PERCENT", 90.0, allow_zero=True)
    cpu_seconds = env_float("OH_BROWSER_WATCHDOG_CPU_SECONDS", 600.0)
    max_cpu_minutes = env_float(
        "OH_BROWSER_WATCHDOG_MAX_CPU_MINUTES", 240.0, allow_zero=True
    )
    max_age_minutes = env_float(
        "OH_BROWSER_WATCHDOG_MAX_AGE_MINUTES", 720.0, allow_zero=True
    )
    nice_level = env_int("OH_BROWSER_NICE_LEVEL", 10, allow_zero=True)
    sweep = env_bool("OH_BROWSER_WATCHDOG_SWEEP_ORPHANS", True)

    log(
        "started: interval={interval}s cpu_limit={cpu}%/{window}s "
        "max_cpu={maxcpu}min max_age={maxage}min nice=+{nice} sweep={sweep}".format(
            interval=int(interval),
            cpu=int(cpu_limit),
            window=int(cpu_seconds),
            maxcpu=int(max_cpu_minutes),
            maxage=int(max_age_minutes),
            nice=nice_level,
            sweep=sweep,
        )
    )

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    previous: dict[int, float] = {}
    previous_at: float | None = None
    breach_since: dict[int, float] = {}
    reniced: set[int] = set()
    last_heartbeat = time.monotonic()

    while not _STOP:
        time.sleep(interval)
        now = time.monotonic()
        procs = sample()
        elapsed = now - previous_at if previous_at is not None else 0.0

        browsers = {pid: info for pid, info in procs.items() if info.is_browser}
        for pid, info in browsers.items():
            if pid not in reniced and info.is_automation:
                renice(info, nice_level)
                reniced.add(pid)

        if sweep:
            swept = sweep_orphans(procs)
            if swept:
                # Fresh sample: the killed processes must not influence the
                # CPU-rate bookkeeping below.
                procs = sample()
                browsers = {
                    pid: info for pid, info in procs.items() if info.is_browser
                }

        cpu_percent: dict[int, float] = {}
        if elapsed > 0:
            for pid, info in browsers.items():
                before = previous.get(pid)
                if before is None:
                    continue
                delta = info.cpu_seconds - before
                if delta > 0:
                    cpu_percent[pid] = 100.0 * delta / elapsed
        previous = {pid: info.cpu_seconds for pid, info in browsers.items()}
        previous_at = now

        for pid, info in browsers.items():
            percent = cpu_percent.get(pid, 0.0)
            if cpu_limit > 0 and percent >= cpu_limit:
                breach_since.setdefault(pid, now)
            elif percent < cpu_limit * 0.5:
                breach_since.pop(pid, None)

            reason = None
            breach_for = now - breach_since.get(pid, now)
            if (
                cpu_limit > 0
                and breach_since.get(pid) is not None
                and breach_for >= cpu_seconds
            ):
                reason = (
                    f"used {percent:.0f}% of a core for {breach_for / 60:.1f} min "
                    f"(limit {cpu_limit:.0f}% for {cpu_seconds / 60:.1f} min)"
                )
            elif max_cpu_minutes > 0 and info.cpu_minutes >= max_cpu_minutes:
                reason = (
                    f"burned {info.cpu_minutes:.0f} CPU-minutes "
                    f"(limit {max_cpu_minutes:.0f})"
                )
            elif (
                max_age_minutes > 0
                and info.is_automation
                and info.age_minutes >= max_age_minutes
            ):
                reason = (
                    f"alive for {info.age_minutes / 60:.1f}h "
                    f"(limit {max_age_minutes / 60:.1f}h)"
                )
            if reason is None:
                continue

            tree = descendants(pid, procs)
            log(
                "killing browser pid={pid} type={type} tree={tree}: {reason}".format(
                    pid=pid, type=info.helper_type, tree=tree, reason=reason
                )
            )
            kill_tree(tree, grace_seconds=5.0)
            for dead in tree:
                breach_since.pop(dead, None)
                previous.pop(dead, None)
                reniced.discard(dead)

        if now - last_heartbeat >= 3600.0:
            last_heartbeat = now
            if browsers:
                log(f"heartbeat: {len(browsers)} browser process(es) alive")

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--sweep",
        action="store_true",
        help="kill orphaned automation browsers once and exit",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="with --sweep: only report what would be killed",
    )
    parser.add_argument(
        "--status", action="store_true", help="print a JSON report and exit"
    )
    args = parser.parse_args(argv)

    if not PROC.is_dir():
        log(f"{PROC} not available — nothing to watch")
        return 0

    if args.status:
        print(json.dumps(report(sample()), indent=2))
        return 0
    if args.sweep:
        swept = sweep_orphans(sample(), dry_run=args.dry_run)
        print(json.dumps(swept, indent=2))
        return 0
    return watch()


if __name__ == "__main__":
    sys.exit(main())
