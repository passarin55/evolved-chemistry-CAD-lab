"""Background jobs for long-running lab work (evolution, campaigns, search).

A small thread pool runs job functions. Each job function receives a
:class:`JobContext` through which it streams events and progress and checks for
cancellation. Job records are guarded by a single lock; finished jobs are kept
in a bounded history so the GUI can show recent results.
"""
from __future__ import annotations

import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable

ACTIVE_STATES = ("queued", "running")
FINISHED_STATES = ("done", "error", "cancelled")


class _JobCancelled(BaseException):
    """Raised inside a running job (e.g. from an ``on_generation`` callback) to stop it.

    Derives from ``BaseException`` so engine code that guards calls with
    ``except Exception`` (search providers, fitness evaluation) cannot swallow
    the cancellation.
    """


class UnknownJob(KeyError):
    """No job with the given id (never existed, or pruned from history)."""


class TooManyJobs(RuntimeError):
    """The manager already holds ``max_active`` queued or running jobs."""


def job_label(kind: str, params: dict[str, Any], limit: int = 80) -> str:
    """A short human label for a job: the search query, campaign title or GA size."""
    label = params.get("query") or params.get("title")
    if not label and params.get("population") is not None:
        label = f"{params.get('population')}\u00d7{params.get('generations')}"
    text = " ".join(str(label or kind).split())
    return text if len(text) <= limit else text[:limit - 1] + "\u2026"


class _Job:
    __slots__ = ("id", "kind", "params", "seq", "status", "created", "started",
                 "finished", "progress", "events", "result", "error", "error_type",
                 "cancel_event", "done_event", "future")

    def __init__(self, job_id: str, kind: str, params: dict[str, Any], seq: int) -> None:
        self.id = job_id
        self.kind = kind
        self.params = params
        self.seq = seq
        self.status = "queued"
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self.progress: dict[str, Any] = {"current": 0, "total": None, "message": "queued"}
        self.events: list[dict[str, Any]] = []
        self.result: Any = None
        self.error: str | None = None
        self.error_type: str | None = None
        self.cancel_event = threading.Event()
        self.done_event = threading.Event()
        self.future: Future | None = None

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "label": job_label(self.kind, self.params),
                "status": self.status,
                "created": self.created, "started": self.started,
                "finished": self.finished, "progress": dict(self.progress)}

    def snapshot(self, since: int = 0) -> dict[str, Any]:
        total = len(self.events)
        since = max(0, min(int(since), total))
        rec = self.summary()
        rec.update({
            "events": list(self.events[since:]),
            "events_total": total,
            "events_since": since,
            "params": self.params,
            "result": self.result,
            "error": self.error,
            "error_type": self.error_type,
            "cancel_requested": self.cancel_event.is_set(),
        })
        return rec


class JobContext:
    """Handle given to a job function: stream events, report progress, honour cancel."""

    def __init__(self, manager: "JobManager", job: _Job) -> None:
        self._mgr = manager
        self._job = job

    @property
    def job_id(self) -> str:
        return self._job.id

    @property
    def cancel_requested(self) -> bool:
        return self._job.cancel_event.is_set()

    def check_cancel(self) -> None:
        """Raise the private cancellation exception if a cancel was requested."""
        if self._job.cancel_event.is_set():
            raise _JobCancelled()

    def emit(self, event: dict[str, Any]) -> None:
        """Append one event (a JSON-able dict) to the job's event stream."""
        with self._mgr._lock:
            self._job.events.append(dict(event))

    def progress(self, current: int | None = None, total: int | None = None,
                 message: str | None = None) -> None:
        """Update any of the progress fields."""
        with self._mgr._lock:
            p = self._job.progress
            if current is not None:
                p["current"] = current
            if total is not None:
                p["total"] = total
            if message is not None:
                p["message"] = message


class JobManager:
    """Runs jobs on a small thread pool and keeps thread-safe job records."""

    def __init__(self, max_workers: int = 2, keep_finished: int = 50,
                 max_active: int | None = None) -> None:
        self.keep_finished = keep_finished
        self.max_active = max_active  # cap on queued + running jobs (None = unbounded)
        self._lock = threading.Lock()
        self._jobs: dict[str, _Job] = {}
        self._seq = 0
        self._executor = ThreadPoolExecutor(max_workers=max_workers,
                                            thread_name_prefix="eccl-job")

    # ---- submission ----
    def submit(self, kind: str, params: dict[str, Any],
               fn: Callable[[JobContext], Any]) -> str:
        """Queue ``fn(ctx)``; its return value becomes the job's ``result``.

        Raises :class:`TooManyJobs` when ``max_active`` jobs are already queued or running.
        """
        with self._lock:
            if self.max_active is not None and sum(
                    1 for j in self._jobs.values() if j.status in ACTIVE_STATES) >= self.max_active:
                raise TooManyJobs(f"{self.max_active} background jobs are already queued or "
                                  "running; wait for one to finish or cancel one")
            self._seq += 1
            job = _Job(f"job-{uuid.uuid4().hex[:8]}", kind, params, self._seq)
            self._jobs[job.id] = job
        try:
            future = self._executor.submit(self._run, job, fn)
        except RuntimeError as e:  # executor shut down
            self._finish(job, "error", error=f"job manager unavailable: {e}",
                         error_type=type(e).__name__)
            return job.id
        with self._lock:
            job.future = future
        return job.id

    def _run(self, job: _Job, fn: Callable[[JobContext], Any]) -> None:
        with self._lock:
            if job.status != "queued":  # cancelled while waiting in the queue
                return
            job.status = "running"
            job.started = time.time()
            job.progress["message"] = "running"
        ctx = JobContext(self, job)
        try:
            ctx.check_cancel()
            result = fn(ctx)
        except _JobCancelled:
            self._finish(job, "cancelled")
        except Exception as e:  # noqa: BLE001 - reported on the job record
            sys.stderr.write(f"[eccl-gui] job {job.id} ({job.kind}) failed:\n")
            traceback.print_exc(file=sys.stderr)
            self._finish(job, "error", error=str(e) or type(e).__name__,
                         error_type=type(e).__name__)
        else:
            self._finish(job, "done", result=result)

    def _finish(self, job: _Job, status: str, *, result: Any = None,
                error: str | None = None, error_type: str | None = None) -> None:
        with self._lock:
            self._finish_locked(job, status, result=result, error=error,
                                error_type=error_type)

    def _finish_locked(self, job: _Job, status: str, *, result: Any = None,
                       error: str | None = None, error_type: str | None = None) -> None:
        job.status = status
        job.finished = time.time()
        job.result = result
        job.error = error
        job.error_type = error_type
        if status == "cancelled":
            job.progress["message"] = "cancelled"
        elif status == "error":
            job.progress["message"] = f"failed: {error}"
        job.done_event.set()
        self._prune_locked()

    def _prune_locked(self) -> None:
        finished = [j for j in self._jobs.values() if j.status in FINISHED_STATES]
        excess = len(finished) - self.keep_finished
        if excess > 0:
            finished.sort(key=lambda j: (j.finished or j.created, j.seq))
            for j in finished[:excess]:
                del self._jobs[j.id]

    # ---- queries ----
    def _get_locked(self, job_id: str) -> _Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise UnknownJob(job_id)
        return job

    def list(self) -> list[dict[str, Any]]:
        """Job summaries (no events / result), newest first."""
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.seq, reverse=True)
            return [j.summary() for j in jobs]

    def get(self, job_id: str, since: int = 0) -> dict[str, Any]:
        """Full job record; ``events`` holds only events with index >= ``since``."""
        with self._lock:
            return self._get_locked(job_id).snapshot(since)

    def wait(self, job_id: str, timeout: float | None = None) -> dict[str, Any]:
        """Block until the job finishes (or ``timeout``) and return its record."""
        with self._lock:
            job = self._get_locked(job_id)
        job.done_event.wait(timeout)
        with self._lock:
            return job.snapshot(0)

    def active_count(self) -> int:
        with self._lock:
            return sum(1 for j in self._jobs.values() if j.status in ACTIVE_STATES)

    # ---- control ----
    def cancel(self, job_id: str) -> dict[str, Any]:
        """Request cooperative cancellation; a queued job is cancelled immediately."""
        future = None
        with self._lock:
            job = self._get_locked(job_id)
            if job.status == "queued":
                job.cancel_event.set()
                future = job.future
                self._finish_locked(job, "cancelled")
            elif job.status == "running":
                job.cancel_event.set()
                job.progress["message"] = "cancelling..."
            status = job.status
            requested = job.cancel_event.is_set()
        if future is not None:
            future.cancel()
        return {"id": job_id, "status": status, "cancel_requested": requested}

    def shutdown(self, wait: bool = False) -> None:
        """Cancel every active job and stop the pool."""
        with self._lock:
            for job in list(self._jobs.values()):
                if job.status == "queued":
                    job.cancel_event.set()
                    self._finish_locked(job, "cancelled")
                elif job.status == "running":
                    job.cancel_event.set()
        self._executor.shutdown(wait=wait, cancel_futures=True)
