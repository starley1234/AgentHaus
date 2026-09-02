"""Tests for the runaway / orphaned Chromium process guard.

The guard exists because of a real incident: a Chromium ``--type=gpu-process``
helper stayed alive (and pinned ~99% of a core for 64h of CPU time) after the
agent-server that spawned it was gone, starving every other service in the
container.  These tests pin down the three behaviours that prevent it:

* only *our* automation browsers are ever touched,
* a browser that burns CPU while the agent is not using it gets killed,
* a browser that burns CPU while the agent *is* using it does not (unless it
  blows an absolute budget).
"""

import dataclasses
import os
import time
from pathlib import Path

import pytest

from openhands.tools.browser_use import process_guard as pg


TOKEN = "guardtoken"
CHROMIUM = "/usr/lib/chromium/chromium"
AUTOMATION_PROFILE = "/tmp/browser-use-user-data-dir-abc123"


class FakeSource:
    """A ``ProcSource`` backed by a fixed list of :class:`ProcInfo`."""

    def __init__(self, procs: list[pg.ProcInfo]):
        self.procs = list(procs)

    def processes(self):
        return list(self.procs)


class SpinSource:
    """A source whose processes keep burning CPU between samples.

    The guard compares two samples, so a runaway has to be *observed* burning
    CPU more than once — a static fixture would look idle on the second tick.
    """

    def __init__(self, procs: list[pg.ProcInfo], spin: dict[int, float]):
        self.base = {proc.pid: proc for proc in procs}
        self.spin = spin  # pid -> cpu-seconds per wall-second
        self.started = time.monotonic()

    def processes(self):
        elapsed = time.monotonic() - self.started
        out = []
        for pid, proc in self.base.items():
            rate = self.spin.get(pid, 0.0)
            out.append(
                dataclasses.replace(proc, cpu_seconds=proc.cpu_seconds + rate * elapsed)
            )
        return out


def make_proc(
    pid: int,
    ppid: int = 1,
    argv: list[str] | None = None,
    cpu_seconds: float = 0.0,
    rss_mb: float = 128.0,
    age_seconds: float = 60.0,
    nice: int = 0,
    *,
    helper: str | None = None,
    token: str | None = TOKEN,
    profile: str | None = AUTOMATION_PROFILE,
) -> pg.ProcInfo:
    if argv is None:
        argv = [CHROMIUM]
        if helper:
            argv.append(f"--type={helper}")
        if token:
            argv.append(f"{pg.GUARD_FLAG}={token}")
        if profile:
            argv.append(f"--user-data-dir={profile}")
    return pg.ProcInfo(
        pid=pid,
        ppid=ppid,
        cpu_seconds=cpu_seconds,
        rss_bytes=int(rss_mb * 1024 * 1024),
        start_epoch=time.time() - age_seconds,
        argv=tuple(argv),
        nice=nice,
    )


@pytest.fixture
def no_real_signals(monkeypatch):
    """Record signals instead of sending them; nothing is really alive."""
    sent: list[tuple[int, str]] = []
    monkeypatch.setattr(pg, "_signal", lambda pid, sig: sent.append((pid, sig.name)))
    monkeypatch.setattr(pg, "_pid_alive", lambda pid: False)
    return sent


def browser_tree(**kwargs) -> list[pg.ProcInfo]:
    """A browser root plus a gpu and a renderer helper."""
    return [
        make_proc(100, ppid=7, cpu_seconds=10.0, **kwargs),
        make_proc(101, ppid=100, helper="gpu-process", cpu_seconds=5.0, **kwargs),
        make_proc(102, ppid=100, helper="renderer", cpu_seconds=1.0, **kwargs),
    ]


# ── settings ────────────────────────────────────────────────────────────────


def test_settings_defaults_are_safe():
    settings = pg.GuardSettings.from_env({})
    assert settings.enabled is True
    assert settings.sweep_orphans is True
    assert settings.hardened_args is True
    assert settings.cpu_percent_limit == 90.0
    assert settings.max_total_cpu_seconds == 180 * 60
    assert settings.max_wall_clock_seconds == 360 * 60
    assert settings.nice_level == 10


def test_settings_from_env_overrides():
    settings = pg.GuardSettings.from_env(
        {
            "OH_BROWSER_GUARD": "0",
            "OH_BROWSER_GUARD_CPU_PERCENT": "50",
            "OH_BROWSER_GUARD_MAX_CPU_MINUTES": "30",
            "OH_BROWSER_GUARD_MAX_LIFETIME_MINUTES": "45",
            "OH_BROWSER_NICE_LEVEL": "19",
            "OH_BROWSER_SWEEP_ORPHANS": "false",
            "OH_BROWSER_RENDERER_LIMIT": "2",
            "OH_BROWSER_EXTRA_ARGS": "--proxy-server=http://proxy:3128 --mute-audio",
        }
    )
    assert settings.enabled is False
    assert settings.cpu_percent_limit == 50.0
    assert settings.max_total_cpu_seconds == 30 * 60
    assert settings.max_wall_clock_seconds == 45 * 60
    assert settings.nice_level == 19
    assert settings.sweep_orphans is False
    assert settings.renderer_process_limit == 2
    assert settings.extra_args == ("--proxy-server=http://proxy:3128", "--mute-audio")


def test_settings_zero_disables_knobs():
    """0 is an explicit "off" for budgets, renice and the renderer cap."""
    settings = pg.GuardSettings.from_env(
        {
            "OH_BROWSER_GUARD_MAX_CPU_MINUTES": "0",
            "OH_BROWSER_GUARD_MAX_LIFETIME_MINUTES": "0",
            "OH_BROWSER_GUARD_MAX_RSS_MB": "0",
            "OH_BROWSER_NICE_LEVEL": "0",
            "OH_BROWSER_RENDERER_LIMIT": "0",
        }
    )
    assert settings.max_total_cpu_seconds == 0.0
    assert settings.max_wall_clock_seconds == 0.0
    assert settings.max_tree_rss_mb == 0.0
    assert settings.nice_level == 0
    assert settings.renderer_process_limit == 0
    assert "--renderer-process-limit=0" not in pg.build_launch_args(settings, TOKEN)


def test_guard_skips_disabled_budgets(monkeypatch):
    sent: list[tuple[int, str]] = []
    guard = make_guard(
        FakeSource(browser_tree(age_seconds=99 * 3600, rss_mb=9999.0)),
        sent,
        monkeypatch,
        max_total_cpu_seconds=0.0,
        max_wall_clock_seconds=0.0,
        max_tree_rss_mb=0.0,
    )

    guard._tick()

    assert guard.last_violation is None
    assert sent == []


def test_settings_ignore_garbage_env_values():
    settings = pg.GuardSettings.from_env(
        {
            "OH_BROWSER_GUARD_CPU_PERCENT": "not-a-number",
            "OH_BROWSER_GUARD_MAX_CPU_MINUTES": "-5",
            "OH_BROWSER_EXTRA_ARGS": "--unbalanced='",
        }
    )
    assert settings.cpu_percent_limit == 90.0
    assert settings.max_total_cpu_seconds == 180 * 60
    assert settings.extra_args == ()


# ── launch args ─────────────────────────────────────────────────────────────


def test_build_launch_args_marks_and_hardens():
    args = pg.build_launch_args(pg.GuardSettings(), TOKEN)
    assert args[0] == f"{pg.GUARD_FLAG}={TOKEN}"
    # The GPU process is the single most common source of a wedged, CPU-pinning
    # helper inside a container without a GPU.
    assert "--disable-gpu" in args
    assert "--disable-dev-shm-usage" in args
    assert "--renderer-process-limit=4" in args
    assert all(arg.startswith("--") for arg in args)


def test_build_launch_args_merges_user_args_and_can_disable_hardening():
    settings = pg.GuardSettings(hardened_args=False, extra_args=("--lang=ru",))
    args = pg.build_launch_args(settings, TOKEN, user_args=["--window-size=1280,800"])
    assert f"{pg.GUARD_FLAG}={TOKEN}" in args
    assert "--lang=ru" in args
    assert "--window-size=1280,800" in args
    assert "--disable-gpu" not in args
    assert "--renderer-process-limit=4" not in args


def test_build_launch_args_drops_non_flag_user_args():
    args = pg.build_launch_args(pg.GuardSettings(), TOKEN, user_args=["evil", "--ok=1"])
    assert "evil" not in args
    assert "--ok=1" in args


# ── tree collection ─────────────────────────────────────────────────────────


def test_collect_trees_groups_helpers_under_their_root():
    infos = {p.pid: p for p in browser_tree()}
    trees = pg.collect_browser_trees(infos, token=TOKEN)
    assert len(trees) == 1
    tree = trees[0]
    assert tree.root_pid == 100
    assert tree.pids == (100, 101, 102)
    assert tree.cpu_seconds == pytest.approx(16.0)
    assert tree.rss_mb == pytest.approx(384.0)


def test_collect_trees_ignores_other_tokens_and_other_browsers():
    procs = [
        *browser_tree(),
        make_proc(200, ppid=7, token="someoneelse"),
        make_proc(300, ppid=7, argv=["/usr/bin/firefox"]),
        make_proc(
            400, ppid=7, argv=["/usr/bin/python3", "-m", "openhands.agent_server"]
        ),
    ]
    infos = {p.pid: p for p in procs}
    trees = pg.collect_browser_trees(infos, token=TOKEN)
    assert [t.root_pid for t in trees] == [100]


def test_collect_trees_surfaces_orphaned_helper_as_its_own_tree():
    """The incident shape: gpu-process re-parented to PID 1, root long gone."""
    orphan = make_proc(6703, ppid=1, helper="gpu-process", cpu_seconds=3849 * 60)
    infos = {orphan.pid: orphan}
    trees = pg.collect_browser_trees(infos, token=TOKEN)
    assert len(trees) == 1
    assert trees[0].root_pid == 6703
    assert trees[0].pids == (6703,)


# ── orphan sweep ────────────────────────────────────────────────────────────


def test_sweep_kills_orphaned_automation_browsers(no_real_signals):
    procs = [
        # orphaned helper from a previous run (the reported incident)
        make_proc(
            6703, ppid=1, helper="gpu-process", token=None, age_seconds=70 * 3600
        ),
        # orphaned root marked by a previous guard instance
        make_proc(6800, ppid=1, token="deadbeef"),
        # a human's browser in the VNC desktop: must survive
        make_proc(
            7000,
            ppid=7,
            token=None,
            profile=None,
            argv=["/usr/bin/chromium", "--user-data-dir=/home/user/.config/chromium"],
        ),
        # our own live browser: must survive
        *browser_tree(),
        # unrelated process: must survive
        make_proc(8000, ppid=7, argv=["/usr/bin/node", "server.mjs"]),
    ]
    source = FakeSource(procs)

    swept = pg.sweep_orphaned_browsers(source=source, exclude_token=TOKEN)

    assert {record["pid"] for record in swept} == {6703, 6800}
    killed = {pid for pid, _ in no_real_signals}
    assert killed == {6703, 6800}
    assert all(sig == "SIGTERM" for _, sig in no_real_signals)


def test_sweep_never_touches_browsers_whose_parent_is_alive(no_real_signals):
    procs = browser_tree()  # root 100 has ppid=7 which is *not* in the sample
    infos = {p.pid: p for p in procs}
    infos[7] = make_proc(7, ppid=1, argv=["/opt/venv/bin/python", "-m", "openhands"])
    source = FakeSource(list(infos.values()))

    swept = pg.sweep_orphaned_browsers(source=source, exclude_token="other")

    assert swept == []
    assert no_real_signals == []


def test_sweep_skips_processes_parented_to_us(no_real_signals):
    """Our own browser must never look like an orphan, even without a token."""
    procs = [
        dataclasses.replace(proc, ppid=os.getpid(), argv=tuple(
            arg for arg in proc.argv if not arg.startswith(pg.GUARD_FLAG)
        ))
        for proc in browser_tree()
    ]
    source = FakeSource(procs)

    swept = pg.sweep_orphaned_browsers(source=source, exclude_token="other")

    assert swept == []
    assert no_real_signals == []


def test_sweep_dry_run_reports_without_killing(no_real_signals):
    orphan = make_proc(6703, ppid=1, helper="gpu-process", token=None)
    swept = pg.sweep_orphaned_browsers(
        source=FakeSource([orphan]), exclude_token=TOKEN, dry_run=True
    )
    assert len(swept) == 1
    assert swept[0]["type"] == "gpu-process"
    assert no_real_signals == []


# ── killing ─────────────────────────────────────────────────────────────────


def test_kill_pids_signals_root_before_helpers(monkeypatch):
    sent: list[tuple[int, str]] = []
    monkeypatch.setattr(pg, "_signal", lambda pid, sig: sent.append((pid, sig.name)))
    monkeypatch.setattr(pg, "_pid_alive", lambda pid: False)
    infos = {p.pid: p for p in browser_tree()}

    pg.kill_pids([102, 101, 100], grace_seconds=0.0, infos=infos)

    # The root must be signalled first: while it lives it respawns helpers.
    assert sent[0] == (100, "SIGTERM")
    assert {pid for pid, _ in sent} == {100, 101, 102}


def test_kill_pids_escalates_to_sigkill(monkeypatch):
    sent: list[tuple[int, str]] = []
    monkeypatch.setattr(pg, "_signal", lambda pid, sig: sent.append((pid, sig.name)))
    monkeypatch.setattr(pg, "_pid_alive", lambda pid: True)

    pg.kill_pids([100], grace_seconds=0.2)

    assert [sig for _, sig in sent] == ["SIGTERM", "SIGKILL"]


def test_deprioritize_only_lowers_priority(monkeypatch):
    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(
        pg.os, "setpriority", lambda which, pid, nice: calls.append((pid, nice))
    )
    if not hasattr(pg.os, "PRIO_PROCESS"):  # pragma: no cover - Windows
        pytest.skip("setpriority is POSIX-only")

    assert pg.deprioritize(100, nice_level=10, current_nice=0) is True
    # already nice enough → no syscall
    assert pg.deprioritize(100, nice_level=10, current_nice=15) is False
    assert calls == [(100, 10)]


# ── guard evaluation ────────────────────────────────────────────────────────


def make_guard(
    source: FakeSource,
    sent: list[tuple[int, str]],
    monkeypatch,
    **overrides,
) -> pg.BrowserProcessGuard:
    monkeypatch.setattr(pg, "_signal", lambda pid, sig: sent.append((pid, sig.name)))
    monkeypatch.setattr(pg, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(pg, "deprioritize", lambda *a, **k: False)
    settings = pg.GuardSettings(
        sample_interval_seconds=0.01,
        cpu_breach_seconds=0.2,
        idle_grace_seconds=0.1,
        kill_grace_seconds=0.0,
        nice_level=0,
        **overrides,
    )
    return pg.BrowserProcessGuard(settings=settings, token=TOKEN, source=source)


def test_guard_kills_browser_spinning_while_idle(monkeypatch):
    sent: list[tuple[int, str]] = []
    guard = make_guard(SpinSource(browser_tree(), spin={101: 1.5}), sent, monkeypatch)
    guard._last_activity = time.monotonic() - 30  # agent stopped using it

    guard._tick()  # baseline sample
    time.sleep(0.1)
    guard._tick()  # breach observed, clock starts
    time.sleep(0.25)
    guard._tick()  # breach persisted longer than cpu_breach_seconds

    violation = guard.last_violation
    assert violation is not None
    assert violation.reason == "runaway-cpu"
    assert violation.metrics["hot_pid"] == 101
    assert violation.metrics["hot_type"] == "gpu-process"
    assert {pid for pid, _ in sent} == {100, 101, 102}
    assert guard.kill_count == 1
    # the executor consumes the violation exactly once
    assert guard.consume_violation() is violation
    assert guard.consume_violation() is None


def test_guard_spares_busy_browser_while_an_action_is_in_flight(monkeypatch):
    sent: list[tuple[int, str]] = []
    guard = make_guard(SpinSource(browser_tree(), spin={101: 1.5}), sent, monkeypatch)
    guard._last_activity = time.monotonic() - 30

    guard._tick()
    guard.begin_action()  # the agent is driving the browser right now
    time.sleep(0.3)
    guard._tick()
    guard._tick()

    assert guard.last_violation is None
    assert sent == []
    assert guard.idle_seconds == 0.0
    guard.end_action()
    assert guard.idle_seconds > 0.0


def test_guard_enforces_cpu_budget_even_while_busy(monkeypatch):
    sent: list[tuple[int, str]] = []
    guard = make_guard(
        FakeSource(browser_tree()), sent, monkeypatch, max_total_cpu_seconds=10.0
    )
    guard.begin_action()

    guard._tick()

    violation = guard.last_violation
    assert violation is not None
    assert violation.reason == "cpu-budget"
    assert {pid for pid, _ in sent} == {100, 101, 102}


def test_guard_enforces_memory_budget(monkeypatch):
    sent: list[tuple[int, str]] = []
    procs = browser_tree(rss_mb=2048.0)
    guard = make_guard(FakeSource(procs), sent, monkeypatch, max_tree_rss_mb=4096.0)

    guard._tick()

    violation = guard.last_violation
    assert violation is not None
    assert violation.reason == "memory-budget"
    assert violation.metrics["rss_mb"] == pytest.approx(6144.0)


def test_guard_enforces_max_lifetime(monkeypatch):
    sent: list[tuple[int, str]] = []
    procs = browser_tree(age_seconds=3 * 3600)
    guard = make_guard(
        FakeSource(procs), sent, monkeypatch, max_wall_clock_seconds=3600.0
    )

    guard._tick()

    violation = guard.last_violation
    assert violation is not None
    assert violation.reason == "max-lifetime"


def test_guard_deprioritises_browser_processes(monkeypatch):
    reniced: list[int] = []
    sent: list[tuple[int, str]] = []
    monkeypatch.setattr(pg, "_signal", lambda pid, sig: sent.append((pid, sig.name)))
    monkeypatch.setattr(pg, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(
        pg, "deprioritize", lambda pid, nice, current=0: reniced.append(pid) or True
    )
    guard = pg.BrowserProcessGuard(
        settings=pg.GuardSettings(nice_level=10, sample_interval_seconds=0.01),
        token=TOKEN,
        source=FakeSource(browser_tree()),
    )

    guard._tick()

    assert sorted(reniced) == [100, 101, 102]
    assert sent == []  # deprioritising alone must never kill


def test_guard_thread_starts_and_stops(monkeypatch):
    monkeypatch.setattr(pg, "deprioritize", lambda *a, **k: False)
    guard = pg.BrowserProcessGuard(
        settings=pg.GuardSettings(sample_interval_seconds=0.01, nice_level=0),
        token=TOKEN,
        source=FakeSource(browser_tree()),
    )

    guard.start()
    assert guard.status()["running"] is True
    guard.start()  # idempotent
    time.sleep(0.05)
    guard.stop(timeout=2.0)

    assert guard.status()["running"] is False


def test_disabled_guard_never_starts(monkeypatch):
    guard = pg.BrowserProcessGuard(
        settings=pg.GuardSettings(enabled=False),
        token=TOKEN,
        source=FakeSource(browser_tree()),
    )
    guard.start()
    assert guard.status()["running"] is False


# ── /proc parsing ───────────────────────────────────────────────────────────


def write_fake_proc(root: Path, pid: int, ppid: int, argv: list[str], *, utime=100):
    proc_dir = root / str(pid)
    proc_dir.mkdir(parents=True, exist_ok=True)
    fields = [
        str(pid),
        "(chromium)",
        "S",  # state (field 3)
        str(ppid),  # 4
        str(pid),  # 5 pgrp
        "0",  # 6 session
        "0",  # 7 tty_nr
        "0",  # 8 tpgid
        "0",  # 9 flags
        "0",  # 10 minflt
        "0",  # 11 cminflt
        "0",  # 12 majflt
        "0",  # 13 cmajflt
        str(utime),  # 14 utime
        "50",  # 15 stime
        "0",  # 16 cutime
        "0",  # 17 cstime
        "20",  # 18 priority
        "7",  # 19 nice
        "10",  # 20 num_threads
        "0",  # 21 itrealvalue
        "2000",  # 22 starttime
        "0",  # 23 vsize
        "4096",  # 24 rss (pages)
    ]
    (proc_dir / "stat").write_text(" ".join(fields), encoding="utf-8")
    (proc_dir / "cmdline").write_bytes(
        b"\x00".join(part.encode() for part in argv) + b"\x00"
    )


def test_procfs_source_parses_stat_and_cmdline(tmp_path):
    root = tmp_path / "proc"
    root.mkdir()
    (root / "stat").write_text("cpu  0 0 0\nbtime 1700000000\n", encoding="utf-8")
    write_fake_proc(
        root,
        100,
        7,
        [CHROMIUM, f"{pg.GUARD_FLAG}={TOKEN}", f"--user-data-dir={AUTOMATION_PROFILE}"],
    )
    write_fake_proc(root, 101, 100, [CHROMIUM, "--type=gpu-process"], utime=200)
    (root / "self").mkdir(exist_ok=True)  # non-numeric entries are ignored

    source = pg.ProcfsSource(root)
    infos = {info.pid: info for info in source.processes()}

    assert set(infos) == {100, 101}
    root_info = infos[100]
    clk = float(os.sysconf("SC_CLK_TCK"))
    page = float(os.sysconf("SC_PAGE_SIZE"))
    assert root_info.ppid == 7
    assert root_info.nice == 7  # field 19, *not* priority (field 18)
    assert root_info.cpu_seconds == pytest.approx(150 / clk)
    assert root_info.rss_bytes == pytest.approx(4096 * page)
    assert root_info.start_epoch == pytest.approx(1700000000 + 2000 / clk)
    assert root_info.guard_token == TOKEN
    assert root_info.is_automation_browser is True
    assert root_info.is_helper is False
    assert infos[101].is_helper is True
    assert infos[101].helper_type == "gpu-process"

    trees = pg.collect_browser_trees(infos, token=TOKEN)
    # The helper inherits the marker from its parent in real life; here it does
    # not, but it is still grouped because it is a descendant of the root.
    assert trees and trees[0].pids == (100, 101)


def test_procfs_source_tolerates_vanished_processes(tmp_path):
    root = tmp_path / "proc"
    root.mkdir()
    (root / "stat").write_text("btime 1700000000\n", encoding="utf-8")
    (root / "999").mkdir()  # directory exists but has no stat/cmdline

    source = pg.ProcfsSource(root)
    assert list(source.processes()) == []
