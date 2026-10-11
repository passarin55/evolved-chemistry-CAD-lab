"""Reliable Ctrl-C / SIGTERM handling for the GUI server (stdlib only).

Two things defeat the usual ``KeyboardInterrupt`` path while a background job
runs:

* RDKit swaps the process-wide SIGINT handler around every substructure match,
  and evolution jobs match almost continuously, so a Ctrl-C lands in RDKit's
  handler instead of Python's and is lost.
* numpy starts OpenBLAS worker threads as soon as it is imported. The kernel
  may deliver a process-directed signal to any thread that does not block it.

So the GUI entry points call :func:`block_early` *before* importing anything
heavy: every thread created afterwards (numpy's, the request threads, the job
workers) inherits a mask with SIGINT/SIGTERM blocked. :class:`SignalWatcher`
then takes the signals synchronously with ``sigwait`` - no handler is
involved, so RDKit's swap no longer matters.

This module must stay free of third-party imports.
"""
from __future__ import annotations

import signal
import threading
from typing import Any

SIGNALS = frozenset({signal.SIGINT, signal.SIGTERM})
_blocked_early = False
_saved_mask: set[int] | None = None


def supported() -> bool:
    """POSIX with pthread signal masks, called from the main thread."""
    return (hasattr(signal, "pthread_sigmask") and hasattr(signal, "sigwait")
            and hasattr(signal, "pthread_kill")
            and threading.current_thread() is threading.main_thread())


def block_early() -> bool:
    """Block SIGINT/SIGTERM in the main thread before other threads exist.

    Only for process entry points (``eccl gui``, ``python -m eccl.gui``) that
    go on to serve until a signal arrives - never call this from library code,
    and pair it with :func:`unblock`. Returns whether blocking took effect.
    """
    global _blocked_early, _saved_mask
    if not supported():
        return False
    old = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    if not _blocked_early:
        _saved_mask = old
    _blocked_early = True
    return True


def unblock() -> None:
    """Restore the mask saved by :func:`block_early` (a pending signal fires now)."""
    global _blocked_early, _saved_mask
    if _blocked_early and _saved_mask is not None:
        signal.pthread_sigmask(signal.SIG_SETMASK, _saved_mask)
    _blocked_early = False
    _saved_mask = None


def blocked_early() -> bool:
    return _blocked_early


class SignalWatcher:
    """Waits for SIGINT/SIGTERM in a daemon thread and stops ``server``.

    ``server`` needs a ``shutdown()`` method (``socketserver`` semantics:
    makes ``serve_forever()`` return in the main thread).
    """

    def __init__(self, server: Any) -> None:
        self._server = server
        self._closing = False
        self.received: int | None = None
        self._old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        self._thread = threading.Thread(target=self._run, name="eccl-gui-signals", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        sig = signal.sigwait(SIGNALS)
        if not self._closing:
            self.received = sig
            self._server.shutdown()

    def close(self) -> None:
        self._closing = True
        if self.received is None and self._thread.is_alive():
            # wake the blocked sigwait() so the thread can exit
            signal.pthread_kill(self._thread.ident, signal.SIGINT)
        self._thread.join(timeout=2.0)
        signal.pthread_sigmask(signal.SIG_SETMASK, self._old_mask)
