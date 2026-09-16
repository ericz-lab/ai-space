#!/usr/bin/env python3
"""Pseudo-terminal wrapper used when the Bun runtime has no Bun.Terminal.

Runs the command given on the command line inside a new PTY. stdin carries
frames: one byte kind, four bytes big-endian length, payload. Kind 0 is
keystrokes for the PTY, kind 1 is a resize (two big-endian uint16: cols,
rows). stdout is the raw PTY output. When stdin closes the child gets SIGHUP,
then SIGKILL two seconds later if it is still there. The exit status is the
child's (128 + signal when it was killed).
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def env_int(name, default):
    try:
        return max(1, min(1000, int(os.environ.get(name, "") or default)))
    except ValueError:
        return default


cols = env_int("PTY_COLS", 80)
rows = env_int("PTY_ROWS", 24)
cmd = sys.argv[1:]
if not cmd:
    sys.stderr.write("usage: pty_helper.py <command> [args...]\n")
    sys.exit(2)

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        sys.stderr.write("exec %s failed: %s\n" % (cmd[0], e))
        os._exit(127)


def set_size(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass


def write_all(target, data):
    while data:
        try:
            n = os.write(target, data)
        except BlockingIOError:
            select.select([], [target], [])
            continue
        except OSError:
            return
        data = data[n:]


set_size(cols, rows)
buf = b""
stdin_open = True
hangup_at = None
exit_status = None

while True:
    if hangup_at is not None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exit_status = status
            break
        if time.monotonic() - hangup_at > 2.0:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            hangup_at = time.monotonic() + 60  # do not kill twice
    watch = [fd] + ([0] if stdin_open else [])
    try:
        ready, _, _ = select.select(watch, [], [], 0.2 if hangup_at is not None else None)
    except InterruptedError:
        continue
    if 0 in ready:
        try:
            chunk = os.read(0, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            stdin_open = False
            hangup_at = time.monotonic()
            try:
                os.kill(pid, signal.SIGHUP)
            except OSError:
                pass
        else:
            buf += chunk
            while len(buf) >= 5:
                kind = buf[0]
                n = struct.unpack(">I", buf[1:5])[0]
                if len(buf) < 5 + n:
                    break
                payload = buf[5:5 + n]
                buf = buf[5 + n:]
                if kind == 0:
                    write_all(fd, payload)
                elif kind == 1 and n >= 4:
                    c, r = struct.unpack(">HH", payload[:4])
                    set_size(c, r)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        write_all(1, data)

if exit_status is None:
    _, exit_status = os.waitpid(pid, 0)
if os.WIFEXITED(exit_status):
    code = os.WEXITSTATUS(exit_status)
else:
    code = 128 + os.WTERMSIG(exit_status)
sys.exit(code)
