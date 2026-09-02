"""Runaway / orphaned Chromium guard for the browser tool.

The incident this module exists for
-----------------------------------
Inside the all-in-one container a Chromium ``--type=gpu-process`` helper
wedged and burned ~99% of one core for 64 hours of CPU time *after* the
agent-server that had spawned it was gone.  Nothing in the stack noticed:

* browser-use launches Chromium with ``asyncio.create_subprocess_exec`` and
  only ever terminates the *parent* process, so helper processes (gpu,
  renderer, utility) can be re-parented to PID 1 and keep spinning;
* the container entrypoint is a bash script acting as PID 1 which never reaps
  those orphans;
* the spinning helper starved every neighbouring event loop, which surfaced as
  ``[telegram-bridge] poll error: ETIMEDOUT`` spam and bash requests that never
  returned.

What the guard does
-------------------
1. **Prevent** — launch Chromium with container-hardened flags (GPU process
   off, renderer cap, …) and *deprioritise* every browser process
   (``nice +N``) so that even a spinning browser can never starve the agent
   server, the automation server or the Telegram bridge.
2. **Detect** — sample the whole browser process tree from ``/proc`` and flag
   it when it burns CPU while the agent is *not* using the browser, or when it
   blows an absolute CPU-time / wall-clock / RSS budget.
3. **Recover** — SIGTERM → SIGKILL the offending tree and let the executor
   transparently start a fresh session on the next action.  Orphans left behind
   by *previous* runs are swept before a new browser is launched.

Killing is always per-PID and never ``os.killpg()``: browser-use does not put
Chromium in its own session, so the browser shares the agent-server's process
group and a group kill would take the server down with it.

Everything here is standard library only (``psutil`` is used as an optional
fallback outside Linux) so the guard keeps working when the browser stack
around it is already broken.
"""

from __future__ import annotations

import os
import shlex
import signal
import threading
import time
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Protocol

from openhands.sdk.logger import get_logger


logger = get_logger(__name__)

# Marker appended to the Chromium command line.  Chromium ignores unknown
# switches, but they stay visible in /proc/<pid>/cmdline (and are inherited by
# every child process), which gives us an unambiguous way to recognise *our*
# browser — and, more importantly, browsers left behind by previous runs.
GUARD_FLAG: Final[str] = "--oh-browser-guard"

HELPER_TYPE_FLAG: Final[str] = "--type="
USER_DATA_DIR_FLAG: Final[str] = "--user-data-dir="

BROWSER_BINARY_HINTS: Final[tuple[str, ...]] = (
    "chrome",
    "chromium",
    "headless_shell",
    "msedge",
    "brave",
)

# Profile directories browser-use creates for automation runs.  A Chromium
# using one of these is never a browser a human opened in the VNC desktop.
AUTOMATION_PROFILE_HINTS: Final[tuple[str, ...]] = (
    "browser-use-user-data-dir-",
    "browseruse-tmp-",
    ".config/browseruse",
)

# Container-friendly Chromium switches.  ``--disable-gpu`` is the important
# one: without a real GPU (and with the default 64 MiB /dev/shm) the GPU
# process is both useless and the single most common source of a wedged,
# CPU-pinning helper.  Software rendering is enough for screenshots and DOM
# work, which is all the agent does.
HARDENED_ARGS: Final[tuple[str, ...]] = (
    "--disable-gpu",
    "--disable-gpu-sandbox",
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--mute-audio",
)

_MB: Final[float] = 1024.0 * 1024.0


def _env_bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(
    env: Mapping[str, str], name: str, default: float, *, allow_zero: bool = False
) -> float:
    """Read a positive float from the environment.

    ``allow_zero`` is for knobs where 0 means "off" (nice level, renderer
    limit, budgets); any other non-positive or non-numeric value falls back to
    the default instead of silently disabling a safety net.
    """
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("Ignoring non-numeric %s=%r (using %s)", name, raw, default)
        return default
    if value > 0:
        return value
    if value == 0 and allow_zero:
        return 0.0
    logger.warning("Ignoring non-positive %s=%r (using %s)", name, raw, default)
    return default


@dataclass(frozen=True)
class GuardSettings:
    """Tunables for :class:`BrowserProcessGuard` (env-overridable)."""

    enabled: bool = True
    sample_interval_seconds: float = 10.0
    # A single browser process using at least this much of one core counts as
    # a CPU breach candidate.
    cpu_percent_limit: float = 90.0
    # ... and it has to keep doing it for this long before we act.
    cpu_breach_seconds: float = 180.0
    # Breaches are only acted upon when the agent has not touched the browser
    # for this long — a page that is legitimately rendering must not be killed.
    idle_grace_seconds: float = 120.0
    # Absolute budgets (apply even while the agent is actively browsing).
    max_total_cpu_seconds: float = 3 * 3600.0
    max_wall_clock_seconds: float = 6 * 3600.0
    max_tree_rss_mb: float = 4096.0
    # SIGTERM → wait → SIGKILL.
    kill_grace_seconds: float = 5.0
    # Re-nice browser processes so a spin can never starve the Python/Node
    # event loops sharing the container.
    nice_level: int = 10
    sweep_orphans: bool = True
    # How often the guard itself re-sweeps orphans left by *other* runs (the
    # entrypoint sweep only happens at start-up / restart).
    sweep_interval_seconds: float = 300.0
    hardened_args: bool = True
    renderer_process_limit: int = 4
    extra_args: tuple[str, ...] = ()

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> GuardSettings:
        """Build settings from ``OH_BROWSER_*`` environment variables."""
        source: Mapping[str, str] = os.environ if env is None else env
        extra_raw = source.get("OH_BROWSER_EXTRA_ARGS", "")
        try:
            extra = tuple(shlex.split(extra_raw)) if extra_raw.strip() else ()
        except ValueError as e:
            logger.warning("Ignoring OH_BROWSER_EXTRA_ARGS (%s): %r", e, extra_raw)
            extra = ()

        return cls(
            enabled=_env_bool(source, "OH_BROWSER_GUARD", True),
            sample_interval_seconds=_env_float(
                source, "OH_BROWSER_GUARD_INTERVAL_SECONDS", 10.0
            ),
            cpu_percent_limit=_env_float(
                source, "OH_BROWSER_GUARD_CPU_PERCENT", 90.0
            ),
            cpu_breach_seconds=_env_float(
                source, "OH_BROWSER_GUARD_CPU_SECONDS", 180.0
            ),
            idle_grace_seconds=_env_float(
                source, "OH_BROWSER_GUARD_IDLE_GRACE_SECONDS", 120.0
            ),
            # 0 disables the individual budget / knob.
            max_total_cpu_seconds=_env_float(
                source, "OH_BROWSER_GUARD_MAX_CPU_MINUTES", 180.0, allow_zero=True
            )
            * 60.0,
            max_wall_clock_seconds=_env_float(
                source,
                "OH_BROWSER_GUARD_MAX_LIFETIME_MINUTES",
                360.0,
                allow_zero=True,
            )
            * 60.0,
            max_tree_rss_mb=_env_float(
                source, "OH_BROWSER_GUARD_MAX_RSS_MB", 4096.0, allow_zero=True
            ),
            kill_grace_seconds=_env_float(
                source, "OH_BROWSER_GUARD_KILL_GRACE_SECONDS", 5.0
            ),
            nice_level=int(
                _env_float(source, "OH_BROWSER_NICE_LEVEL", 10.0, allow_zero=True)
            ),
            sweep_orphans=_env_bool(source, "OH_BROWSER_SWEEP_ORPHANS", True),
            sweep_interval_seconds=_env_float(
                source, "OH_BROWSER_GUARD_SWEEP_INTERVAL_SECONDS", 300.0
            ),
            hardened_args=_env_bool(source, "OH_BROWSER_HARDENED_ARGS", True),
            renderer_process_limit=int(
                _env_float(
                    source, "OH_BROWSER_RENDERER_LIMIT", 4.0, allow_zero=True
                )
            ),
            extra_args=extra,
        )


@dataclass(frozen=True)
class ProcInfo:
    """A point-in-time sample of one process."""

    pid: int
    ppid: int
    cpu_seconds: float
    rss_bytes: int
    start_epoch: float
    argv: tuple[str, ...]
    nice: int = 0

    @property
    def name(self) -> str:
        if not self.argv:
            return ""
        return Path(self.argv[0]).name.lower()

    @property
    def is_helper(self) -> bool:
        """True for Chromium sub-processes (gpu, renderer, utility, …)."""
        return any(arg.startswith(HELPER_TYPE_FLAG) for arg in self.argv)

    @property
    def helper_type(self) -> str | None:
        for arg in self.argv:
            if arg.startswith(HELPER_TYPE_FLAG):
                return arg[len(HELPER_TYPE_FLAG) :] or "unknown"
        return None

    @property
    def guard_token(self) -> str | None:
        prefix = f"{GUARD_FLAG}="
        for arg in self.argv:
            if arg.startswith(prefix):
                return arg[len(prefix) :]
        return None

    @property
    def user_data_dir(self) -> str | None:
        for arg in self.argv:
            if arg.startswith(USER_DATA_DIR_FLAG):
                return arg[len(USER_DATA_DIR_FLAG) :]
        return None

    @property
    def is_browser(self) -> bool:
        if self.guard_token is not None:
            return True
        return any(hint in self.name for hint in BROWSER_BINARY_HINTS)

    @property
    def is_automation_browser(self) -> bool:
        """A browser that belongs to automation, not to a human desktop."""
        if self.guard_token is not None:
            return True
        data_dir = (self.user_data_dir or "").lower()
        return any(hint in data_dir for hint in AUTOMATION_PROFILE_HINTS)


class ProcSource(Protocol):
    """Where process samples come from (real ``/proc``, psutil, or a fake)."""

    def processes(self) -> Iterable[ProcInfo]: ...


class ProcfsSource:
    """``/proc`` reader — the normal path on Linux containers."""

    def __init__(self, root: str | os.PathLike[str] = "/proc"):
        self._root = Path(root)
        self._clk_tck = float(os.sysconf("SC_CLK_TCK"))
        self._page_size = float(os.sysconf("SC_PAGE_SIZE"))
        self._boot_epoch = self._read_boot_epoch()

    def _read_boot_epoch(self) -> float:
        try:
            with (self._root / "stat").open(
                encoding="utf-8", errors="replace"
            ) as handle:
                for line in handle:
                    if line.startswith("btime "):
                        return float(line.split()[1])
        except (OSError, ValueError, IndexError):
            pass
        # Fall back to "now"; only used to compute process age.
        return time.time()

    @staticmethod
    def available(root: str | os.PathLike[str] = "/proc") -> bool:
        return Path(root).is_dir()

    def processes(self) -> Iterable[ProcInfo]:
        try:
            entries = os.listdir(self._root)
        except OSError:
            return []
        for entry in entries:
            if not entry.isdigit():
                continue
            info = self.process(int(entry))
            if info is not None:
                yield info

    def process(self, pid: int) -> ProcInfo | None:
        stat = self._read_stat(pid)
        if stat is None:
            return None
        argv = self._read_cmdline(pid)
        if not argv:
            # Kernel threads and processes we may not inspect: not browsers.
            return None
        return ProcInfo(
            pid=pid,
            ppid=stat["ppid"],
            cpu_seconds=(stat["utime"] + stat["stime"]) / self._clk_tck,
            rss_bytes=int(stat["rss_pages"] * self._page_size),
            start_epoch=self._boot_epoch + stat["starttime"] / self._clk_tck,
            argv=tuple(argv),
            nice=stat["nice"],
        )

    def _read_stat(self, pid: int) -> dict[str, float] | None:
        try:
            raw = (self._root / str(pid) / "stat").read_text(
                encoding="utf-8", errors="replace"
            )
        except (OSError, ValueError):
            return None
        # ``comm`` (field 2) may contain spaces and parentheses — everything
        # before the *last* ')' is the name, the rest are fixed fields.
        try:
            tail = raw[raw.rindex(")") + 2 :].split()
        except ValueError:
            return None
        # tail[i] holds field (i + 3) of proc(5): state is field 3.
        if len(tail) < 22:
            return None
        try:
            return {
                "ppid": float(tail[1]),
                "utime": float(tail[11]),
                "stime": float(tail[12]),
                "nice": float(tail[16]),
                "starttime": float(tail[19]),
                "rss_pages": float(tail[21]),
            }
        except (ValueError, IndexError):
            return None

    def _read_cmdline(self, pid: int) -> list[str]:
        try:
            raw = (self._root / str(pid) / "cmdline").read_bytes()
        except (OSError, ValueError):
            return []
        parts = [part for part in raw.split(b"\x00") if part]
        return [part.decode("utf-8", errors="replace") for part in parts]


class PsutilSource:
    """Fallback for platforms without ``/proc`` (macOS / Windows dev boxes)."""

    def __init__(self) -> None:
        import psutil  # noqa: PLC0415 - optional dependency, imported lazily

        self._psutil = psutil

    @staticmethod
    def available() -> bool:
        try:
            import psutil  # noqa: F401, PLC0415
        except ImportError:
            return False
        return True

    def processes(self) -> Iterable[ProcInfo]:
        psutil = self._psutil
        attrs = ["pid", "ppid", "cpu_times", "memory_info", "create_time", "cmdline"]
        for proc in psutil.process_iter(attrs):
            try:
                info = proc.info
                argv = info.get("cmdline") or []
                if not argv:
                    continue
                times = info.get("cpu_times")
                memory = info.get("memory_info")
                yield ProcInfo(
                    pid=int(info["pid"]),
                    ppid=int(info.get("ppid") or 0),
                    cpu_seconds=float(
                        (getattr(times, "user", 0.0) or 0.0)
                        + (getattr(times, "system", 0.0) or 0.0)
                    ),
                    rss_bytes=int(getattr(memory, "rss", 0) or 0),
                    start_epoch=float(info.get("create_time") or 0.0),
                    argv=tuple(str(arg) for arg in argv),
                    nice=int(proc.nice() or 0) if hasattr(proc, "nice") else 0,
                )
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError, ValueError):
                continue


def default_proc_source() -> ProcSource | None:
    """Best available process source, or ``None`` when we cannot observe."""
    if ProcfsSource.available():
        return ProcfsSource()
    if PsutilSource.available():
        try:
            return PsutilSource()
        except Exception as e:  # pragma: no cover - defensive
            logger.debug("psutil process source unavailable: %s", e)
    return None


@dataclass(frozen=True)
class BrowserTree:
    """One browser root plus every helper that belongs to it."""

    root_pid: int
    pids: tuple[int, ...]
    cpu_seconds: float
    rss_bytes: int
    start_epoch: float
    tokens: tuple[str, ...]

    @property
    def rss_mb(self) -> float:
        return self.rss_bytes / _MB


@dataclass(frozen=True)
class Violation:
    """Why the guard decided a browser had to die."""

    reason: str
    detail: str
    pids: tuple[int, ...]
    metrics: Mapping[str, Any] = field(default_factory=dict)

    def message(self) -> str:
        return f"{self.reason}: {self.detail}"


def collect_browser_trees(
    infos: Mapping[int, ProcInfo],
    *,
    token: str | None = None,
    automation_only: bool = False,
) -> list[BrowserTree]:
    """Group browser processes into (root → helpers) trees.

    Args:
        infos: Sampled processes keyed by PID.
        token: When given, only trees carrying this guard token are returned.
        automation_only: When True, only browsers that clearly belong to
            automation (guard marker or browser-use profile dir) are returned.
    """
    children: dict[int, list[int]] = {}
    for pid, info in infos.items():
        children.setdefault(info.ppid, []).append(pid)

    roots: list[int] = []
    for pid, info in infos.items():
        if not info.is_browser or info.is_helper:
            continue
        if token is not None and info.guard_token != token:
            continue
        if automation_only and not info.is_automation_browser:
            continue
        roots.append(pid)

    trees: list[BrowserTree] = []
    for root in roots:
        pids = _descendants(root, children)
        members = [infos[pid] for pid in pids if pid in infos]
        if not members:
            continue
        trees.append(
            BrowserTree(
                root_pid=root,
                pids=tuple(sorted(pids)),
                cpu_seconds=sum(member.cpu_seconds for member in members),
                rss_bytes=sum(member.rss_bytes for member in members),
                start_epoch=min(member.start_epoch for member in members),
                tokens=tuple(
                    sorted({m.guard_token for m in members if m.guard_token})
                ),
            )
        )

    # Helper processes whose root is gone (re-parented to PID 1) are orphans
    # and form their own "tree" — this is exactly the wedged gpu-process case.
    covered = {pid for tree in trees for pid in tree.pids}
    for pid, info in infos.items():
        if pid in covered or not info.is_browser or not info.is_helper:
            continue
        if token is not None and info.guard_token != token:
            continue
        if automation_only and not info.is_automation_browser:
            continue
        if info.ppid in infos:
            continue  # root still alive, just not recognised — leave it alone
        trees.append(
            BrowserTree(
                root_pid=pid,
                pids=(pid,),
                cpu_seconds=info.cpu_seconds,
                rss_bytes=info.rss_bytes,
                start_epoch=info.start_epoch,
                tokens=(info.guard_token,) if info.guard_token else (),
            )
        )
    return trees


def _descendants(root: int, children: Mapping[int, Sequence[int]]) -> list[int]:
    """All PIDs in ``root``'s tree (inclusive), cycle-safe."""
    seen: list[int] = []
    stack = [root]
    known: set[int] = set()
    while stack:
        pid = stack.pop()
        if pid in known:
            continue
        known.add(pid)
        seen.append(pid)
        stack.extend(children.get(pid, ()))
    return seen


def kill_pids(
    pids: Iterable[int],
    *,
    grace_seconds: float = 5.0,
    infos: Mapping[int, ProcInfo] | None = None,
) -> list[int]:
    """SIGTERM → wait → SIGKILL a set of PIDs. Returns the PIDs signalled.

    Never uses ``killpg``: browser-use launches Chromium inside the
    agent-server's own process group, so a group signal would kill the server.
    """
    ordered = list(dict.fromkeys(pids))
    if infos is not None:
        # Signal the browser root first: while it lives it keeps respawning
        # helpers (gpu/renderer), so killing children first is wasted work.
        def is_helper(pid: int) -> bool:
            info = infos.get(pid)
            return bool(info and info.is_helper)

        ordered.sort(key=is_helper)
    for pid in ordered:
        _signal(pid, signal.SIGTERM)

    deadline = time.monotonic() + max(0.0, grace_seconds)
    while time.monotonic() < deadline:
        if not any(_pid_alive(pid) for pid in ordered):
            return ordered
        time.sleep(0.2)

    for pid in ordered:
        if _pid_alive(pid):
            _signal(pid, signal.SIGKILL)
    return ordered


def _signal(pid: int, sig: signal.Signals) -> None:
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError as e:
        logger.debug("Not allowed to signal pid %s (%s): %s", pid, sig.name, e)
    except OSError as e:
        logger.debug("Failed to signal pid %s (%s): %s", pid, sig.name, e)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def deprioritize(pid: int, nice_level: int, current_nice: int = 0) -> bool:
    """Raise a process' nice value so it cannot starve the event loops.

    Increasing niceness (lowering priority) is permitted for processes owned by
    the same user, which is exactly our case: the agent server spawns Chromium.
    """
    if nice_level <= 0 or current_nice >= nice_level:
        return False
    prio_process = getattr(os, "PRIO_PROCESS", None)
    if prio_process is None:  # pragma: no cover - Windows
        return False
    try:
        os.setpriority(prio_process, pid, nice_level)
        return True
    except (OSError, ValueError) as e:
        logger.debug("Could not renice pid %s: %s", pid, e)
        return False


def sweep_orphaned_browsers(
    *,
    source: ProcSource | None = None,
    exclude_token: str | None = None,
    dry_run: bool = False,
    grace_seconds: float = 3.0,
) -> list[dict[str, object]]:
    """Kill automation browsers whose parent process is gone.

    Called before launching a new browser and on executor shutdown, so a
    container that outlives an agent-server restart does not accumulate
    CPU-pinning leftovers.  A process is swept only when it is clearly an
    automation browser (guard marker or browser-use profile directory) *and*
    its parent no longer exists — a human's browser in the VNC desktop is never
    touched.
    """
    proc_source = source or default_proc_source()
    if proc_source is None:
        return []

    infos = {info.pid: info for info in proc_source.processes()}
    own_pid = os.getpid()
    live = set(infos)
    swept: list[dict[str, object]] = []

    for pid, info in infos.items():
        if pid == own_pid or info.ppid == own_pid:
            continue
        if not info.is_browser or not info.is_automation_browser:
            continue
        if exclude_token and info.guard_token == exclude_token:
            continue
        # Orphan = re-parented to init (or the parent already vanished).
        if info.ppid not in (0, 1) and info.ppid in live:
            continue

        tree = _descendants(pid, _children_map(infos))
        record = {
            "pid": pid,
            "type": info.helper_type or "browser",
            "cpu_minutes": round(info.cpu_seconds / 60.0, 1),
            "age_minutes": round(max(0.0, time.time() - info.start_epoch) / 60.0, 1),
            "tree": sorted(tree),
            "token": info.guard_token,
        }
        swept.append(record)
        if dry_run:
            continue
        logger.warning(
            "Sweeping orphaned browser process pid=%s type=%s cpu_minutes=%s "
            "age_minutes=%s (parent gone; left over from a previous run)",
            pid,
            record["type"],
            record["cpu_minutes"],
            record["age_minutes"],
        )
        kill_pids(tree, grace_seconds=grace_seconds, infos=infos)

    return swept


def _children_map(infos: Mapping[int, ProcInfo]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    for pid, info in infos.items():
        children.setdefault(info.ppid, []).append(pid)
    return children


def build_launch_args(
    settings: GuardSettings,
    token: str,
    user_args: Sequence[str] | None = None,
) -> list[str]:
    """Chromium switches to hand to browser-use (``BrowserProfile.args``).

    Every entry must start with ``--`` (browser-use validates that) and unknown
    switches are silently ignored by Chromium, which is what makes the guard
    marker possible.
    """
    args: list[str] = [f"{GUARD_FLAG}={token}"]
    if settings.hardened_args:
        args.extend(HARDENED_ARGS)
        if settings.renderer_process_limit > 0:
            args.append(
                f"--renderer-process-limit={int(settings.renderer_process_limit)}"
            )
    args.extend(settings.extra_args)
    for arg in user_args or ():
        if isinstance(arg, str) and arg.startswith("--") and arg not in args:
            args.append(arg)
    return args


class BrowserProcessGuard:
    """Background watchdog over the browser processes of one executor.

    The guard runs on its own daemon thread and only ever touches processes it
    recognises as ours (guard marker) — it never kills unrelated work.
    """

    def __init__(
        self,
        *,
        settings: GuardSettings | None = None,
        token: str | None = None,
        source: ProcSource | None = None,
        on_violation: Callable[[Violation], None] | None = None,
    ) -> None:
        self.settings = settings or GuardSettings()
        self.token = token or uuid.uuid4().hex
        self._source = source
        self._on_violation = on_violation

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

        self._last_activity = time.monotonic()
        self._active_actions = 0
        self._violation: Violation | None = None
        self._kill_count = 0
        self._deprioritized: set[int] = set()
        self._prev_cpu: dict[int, float] = {}
        self._prev_mono: float | None = None
        self._breach_since: dict[int, float] = {}

    # -- lifecycle ---------------------------------------------------------
    @property
    def available(self) -> bool:
        return self._proc_source() is not None

    def start(self) -> None:
        """Start the sampling thread (idempotent, no-op when disabled)."""
        if not self.settings.enabled:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if self._proc_source() is None:
                logger.debug(
                    "Browser process guard disabled: no /proc and no psutil "
                    "available on this platform"
                )
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="browser-process-guard",
                daemon=True,
            )
            self._thread.start()
            logger.info(
                "Browser process guard started (token=%s, cpu_limit=%.0f%% for "
                "%.0fs while idle, cpu_budget=%.0f min, lifetime=%.0f min, "
                "rss_limit=%.0f MiB, nice=+%d)",
                self.token[:8],
                self.settings.cpu_percent_limit,
                self.settings.cpu_breach_seconds,
                self.settings.max_total_cpu_seconds / 60.0,
                self.settings.max_wall_clock_seconds / 60.0,
                self.settings.max_tree_rss_mb,
                self.settings.nice_level,
            )

    def stop(self, timeout: float | None = 2.0) -> None:
        """Stop sampling.  Does *not* kill the browser (see ``kill_tree``)."""
        self._stop.set()
        with self._lock:
            thread = self._thread
            self._thread = None
        if (
            thread is not None
            and thread.is_alive()
            and thread is not threading.current_thread()
        ):
            thread.join(timeout=timeout)

    # -- activity bookkeeping ---------------------------------------------
    def notify_activity(self) -> None:
        """Record that the agent just used the browser (resets idle timer)."""
        self._last_activity = time.monotonic()

    def begin_action(self) -> None:
        """Mark a browser action as in flight — CPU use is expected then."""
        with self._lock:
            self._active_actions += 1
        self.notify_activity()

    def end_action(self) -> None:
        with self._lock:
            self._active_actions = max(0, self._active_actions - 1)
        self.notify_activity()

    @property
    def action_in_flight(self) -> bool:
        with self._lock:
            return self._active_actions > 0

    @property
    def idle_seconds(self) -> float:
        if self.action_in_flight:
            return 0.0
        return max(0.0, time.monotonic() - self._last_activity)

    # -- state ------------------------------------------------------------
    @property
    def last_violation(self) -> Violation | None:
        with self._lock:
            return self._violation

    @property
    def kill_count(self) -> int:
        with self._lock:
            return self._kill_count

    def consume_violation(self) -> Violation | None:
        """Return (and clear) the pending violation for the executor."""
        with self._lock:
            violation = self._violation
            self._violation = None
        return violation

    def status(self) -> dict[str, object]:
        """Small JSON-friendly snapshot for logs / diagnostics endpoints."""
        with self._lock:
            violation = self._violation
            kills = self._kill_count
            running = self._thread is not None and self._thread.is_alive()
        return {
            "enabled": self.settings.enabled,
            "running": running,
            "token": self.token[:8],
            "kills": kills,
            "idle_seconds": round(self.idle_seconds, 1),
            "action_in_flight": self.action_in_flight,
            "last_violation": violation.message() if violation else None,
        }

    # -- killing ----------------------------------------------------------
    def kill_tree(
        self,
        reason: str,
        detail: str = "",
        grace_seconds: float | None = None,
    ) -> list[int]:
        """Kill every process of *our* browser tree. Returns signalled PIDs."""
        source = self._proc_source()
        if source is None:
            return []
        infos = {info.pid: info for info in source.processes()}
        trees = collect_browser_trees(infos, token=self.token)
        pids = sorted({pid for tree in trees for pid in tree.pids})
        if not pids:
            return []
        logger.warning(
            "Killing browser process tree (%d pid(s): %s) — %s%s",
            len(pids),
            ", ".join(str(pid) for pid in pids),
            reason,
            f" ({detail})" if detail else "",
        )
        killed = kill_pids(
            pids,
            grace_seconds=(
                self.settings.kill_grace_seconds
                if grace_seconds is None
                else grace_seconds
            ),
            infos=infos,
        )
        with self._lock:
            self._kill_count += 1
        self._prev_cpu.clear()
        self._breach_since.clear()
        return killed

    # -- sampling loop ----------------------------------------------------
    def _proc_source(self) -> ProcSource | None:
        if self._source is None:
            self._source = default_proc_source()
        return self._source

    def _run(self) -> None:
        interval = max(1.0, self.settings.sample_interval_seconds)
        next_sweep = time.monotonic() + max(
            interval, self.settings.sweep_interval_seconds
        )
        while not self._stop.wait(interval):
            try:
                self._tick()
                if (
                    self.settings.sweep_orphans
                    and self.settings.sweep_interval_seconds > 0
                    and time.monotonic() >= next_sweep
                ):
                    next_sweep = time.monotonic() + self.settings.sweep_interval_seconds
                    swept = sweep_orphaned_browsers(
                        exclude_token=self.token,
                        grace_seconds=self.settings.kill_grace_seconds,
                    )
                    if swept:
                        logger.warning(
                            "Periodic sweep removed %d orphaned browser process "
                            "group(s): %s",
                            len(swept),
                            [item["pid"] for item in swept],
                        )
            except Exception as e:  # pragma: no cover - defensive
                # A watchdog that dies silently is worse than no watchdog.
                logger.warning("Browser process guard tick failed: %s", e)

    def _tick(self) -> None:
        source = self._proc_source()
        if source is None:
            return
        now_mono = time.monotonic()
        infos = {info.pid: info for info in source.processes()}
        trees = collect_browser_trees(infos, token=self.token)
        if not trees:
            self._prev_cpu = {}
            self._prev_mono = None
            self._breach_since = {}
            return

        elapsed = (
            now_mono - self._prev_mono if self._prev_mono is not None else None
        )
        cpu_percent: dict[int, float] = {}
        if elapsed and elapsed > 0:
            for pid, info in infos.items():
                previous = self._prev_cpu.get(pid)
                if previous is None:
                    continue
                delta = info.cpu_seconds - previous
                if delta > 0:
                    cpu_percent[pid] = 100.0 * delta / elapsed

        self._prev_cpu = {pid: info.cpu_seconds for pid, info in infos.items()}
        self._prev_mono = now_mono

        for tree in trees:
            self._deprioritize(tree, infos)
            violation = self._evaluate(tree, infos, cpu_percent, now_mono)
            if violation is None:
                continue
            self._record_violation(violation)
            kill_pids(
                tree.pids,
                grace_seconds=self.settings.kill_grace_seconds,
                infos=infos,
            )
            with self._lock:
                self._kill_count += 1
            self._breach_since = {
                pid: since
                for pid, since in self._breach_since.items()
                if pid not in set(tree.pids)
            }
            return  # re-sample on the next tick with a clean slate

    def _deprioritize(self, tree: BrowserTree, infos: Mapping[int, ProcInfo]) -> None:
        nice_level = self.settings.nice_level
        if nice_level <= 0:
            return
        for pid in tree.pids:
            if pid in self._deprioritized:
                continue
            info = infos.get(pid)
            if info is None:
                continue
            if deprioritize(pid, nice_level, info.nice):
                logger.info(
                    "Deprioritised browser pid=%s type=%s to nice +%d so it "
                    "cannot starve the agent server / bridges",
                    pid,
                    info.helper_type or "browser",
                    nice_level,
                )
            self._deprioritized.add(pid)

    def _evaluate(
        self,
        tree: BrowserTree,
        infos: Mapping[int, ProcInfo],
        cpu_percent: Mapping[int, float],
        now_mono: float,
    ) -> Violation | None:
        settings = self.settings
        age_seconds = max(0.0, time.time() - tree.start_epoch)
        metrics: dict[str, float | int | str] = {
            "pids": len(tree.pids),
            "cpu_minutes": round(tree.cpu_seconds / 60.0, 1),
            "rss_mb": round(tree.rss_mb, 1),
            "age_minutes": round(age_seconds / 60.0, 1),
            "idle_seconds": round(self.idle_seconds, 1),
        }

        # 1) Spinning while the agent is not using the browser → wedged.
        hot_pid = None
        hot_percent = 0.0
        if settings.cpu_percent_limit > 0:
            for pid in tree.pids:
                percent = cpu_percent.get(pid, 0.0)
                if percent >= settings.cpu_percent_limit and percent > hot_percent:
                    hot_pid, hot_percent = pid, percent
        if hot_pid is not None:
            self._breach_since.setdefault(hot_pid, now_mono)
        for pid in list(self._breach_since):
            if pid not in tree.pids or cpu_percent.get(pid, 0.0) < (
                settings.cpu_percent_limit * 0.5
            ):
                self._breach_since.pop(pid, None)

        if hot_pid is not None:
            breach_for = now_mono - self._breach_since[hot_pid]
            idle_for = self.idle_seconds
            if (
                breach_for >= settings.cpu_breach_seconds
                and idle_for >= settings.idle_grace_seconds
            ):
                info = infos.get(hot_pid)
                metrics.update(
                    {
                        "hot_pid": hot_pid,
                        "hot_type": (info.helper_type if info else None) or "browser",
                        "cpu_percent": round(hot_percent, 1),
                        "breach_seconds": round(breach_for, 1),
                    }
                )
                return Violation(
                    reason="runaway-cpu",
                    detail=(
                        f"pid {hot_pid} "
                        f"({metrics['hot_type']}) used {hot_percent:.0f}% of a core "
                        f"for {breach_for:.0f}s while the browser was idle for "
                        f"{idle_for:.0f}s"
                    ),
                    pids=tree.pids,
                    metrics=metrics,
                )

        # 2) Absolute CPU-time budget (catches spins during active use too).
        if (
            settings.max_total_cpu_seconds > 0
            and tree.cpu_seconds >= settings.max_total_cpu_seconds
        ):
            metrics["limit_cpu_minutes"] = round(
                settings.max_total_cpu_seconds / 60.0, 1
            )
            return Violation(
                reason="cpu-budget",
                detail=(
                    f"browser tree burned {tree.cpu_seconds / 60.0:.0f} CPU-minutes "
                    f"(limit {settings.max_total_cpu_seconds / 60.0:.0f})"
                ),
                pids=tree.pids,
                metrics=metrics,
            )

        # 3) Wall-clock lifetime cap.
        if (
            settings.max_wall_clock_seconds > 0
            and age_seconds >= settings.max_wall_clock_seconds
        ):
            metrics["limit_lifetime_minutes"] = round(
                settings.max_wall_clock_seconds / 60.0, 1
            )
            return Violation(
                reason="max-lifetime",
                detail=(
                    f"browser has been alive for {age_seconds / 3600.0:.1f}h "
                    f"(limit {settings.max_wall_clock_seconds / 3600.0:.1f}h)"
                ),
                pids=tree.pids,
                metrics=metrics,
            )

        # 4) Memory cap — a leaking renderer eventually wedges the container.
        if settings.max_tree_rss_mb > 0 and tree.rss_mb >= settings.max_tree_rss_mb:
            metrics["limit_rss_mb"] = settings.max_tree_rss_mb
            return Violation(
                reason="memory-budget",
                detail=(
                    f"browser tree uses {tree.rss_mb:.0f} MiB RSS "
                    f"(limit {settings.max_tree_rss_mb:.0f} MiB)"
                ),
                pids=tree.pids,
                metrics=metrics,
            )
        return None

    def _record_violation(self, violation: Violation) -> None:
        with self._lock:
            self._violation = violation
        logger.warning(
            "Browser process guard tripped (%s) — metrics=%s",
            violation.message(),
            dict(violation.metrics),
        )
        if self._on_violation is None:
            return
        try:
            self._on_violation(violation)
        except Exception as e:  # pragma: no cover - defensive
            logger.debug("on_violation callback failed: %s", e)
