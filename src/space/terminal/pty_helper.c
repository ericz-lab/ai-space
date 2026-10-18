/*
 * pty_helper.py in C, for a machine with no usable python3: a clean Mac without the Command Line
 * Tools, where /usr/bin/python3 only offers to install them. The Local edition ships it built as
 * runtime/space-pty (release/local.ts). Same protocol, same exit status:
 *
 *   space-pty <command> [args...]      PTY_COLS, PTY_ROWS: the first size
 *   stdin   frames: kind (1 byte), length (4 bytes big-endian), payload
 *           kind 0 = keystrokes, kind 1 = resize (cols, rows: two big-endian uint16)
 *   stdout  the raw PTY output
 *   stdin closed -> SIGHUP to the child, SIGKILL two seconds later if it is still there
 *   exit    the child's status, 128 + signal when it was killed
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif

static int env_int(const char *name, int dflt) {
  const char *v = getenv(name);
  if (!v || !*v) return dflt;
  long n = strtol(v, NULL, 10);
  if (n < 1) return 1;
  if (n > 1000) return 1000;
  return (int)n;
}

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void write_all(int fd, const unsigned char *p, size_t n) {
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) {
        struct pollfd pf = {fd, POLLOUT, 0};
        poll(&pf, 1, -1);
        continue;
      }
      return;
    }
    p += w;
    n -= (size_t)w;
  }
}

static pid_t child;
static int master;

static void set_size(int cols, int rows) {
  struct winsize ws = {(unsigned short)rows, (unsigned short)cols, 0, 0};
  if (ioctl(master, TIOCSWINSZ, &ws) == 0) kill(child, SIGWINCH);
}

static int status_code(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("usage: space-pty <command> [args...]\n", stderr);
    return 2;
  }
  struct winsize ws = {(unsigned short)env_int("PTY_ROWS", 24), (unsigned short)env_int("PTY_COLS", 80), 0, 0};
  child = forkpty(&master, NULL, NULL, &ws);
  if (child < 0) {
    perror("forkpty");
    return 1;
  }
  if (child == 0) {
    execvp(argv[1], argv + 1);
    fprintf(stderr, "exec %s failed: %s\n", argv[1], strerror(errno));
    _exit(127);
  }
  signal(SIGPIPE, SIG_IGN);

  unsigned char *buf = NULL;
  size_t len = 0, cap = 0;
  unsigned char chunk[65536];
  int stdin_open = 1, have_status = 0, status = 0;
  double hangup_at = -1;

  for (;;) {
    if (hangup_at >= 0) {
      pid_t done = waitpid(child, &status, WNOHANG);
      if (done == child) {
        have_status = 1;
        break;
      }
      if (now() - hangup_at > 2.0) {
        kill(child, SIGKILL);
        hangup_at = now() + 60; /* do not kill twice */
      }
    }
    struct pollfd fds[2] = {{master, POLLIN, 0}, {0, POLLIN, 0}};
    int nfds = stdin_open ? 2 : 1;
    int r = poll(fds, nfds, hangup_at >= 0 ? 200 : -1);
    if (r < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (stdin_open && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t n = read(0, chunk, sizeof chunk);
      if (n <= 0) {
        stdin_open = 0;
        hangup_at = now();
        kill(child, SIGHUP);
      } else {
        if (len + (size_t)n > cap) {
          cap = (len + (size_t)n) * 2;
          buf = realloc(buf, cap);
          if (!buf) return 1;
        }
        memcpy(buf + len, chunk, (size_t)n);
        len += (size_t)n;
        size_t off = 0;
        while (len - off >= 5) {
          unsigned char kind = buf[off];
          uint32_t plen = ((uint32_t)buf[off + 1] << 24) | ((uint32_t)buf[off + 2] << 16) | ((uint32_t)buf[off + 3] << 8) | buf[off + 4];
          if (len - off < 5 + (size_t)plen) break;
          unsigned char *payload = buf + off + 5;
          if (kind == 0) write_all(master, payload, plen);
          else if (kind == 1 && plen >= 4) set_size((payload[0] << 8) | payload[1], (payload[2] << 8) | payload[3]);
          off += 5 + plen;
        }
        memmove(buf, buf + off, len - off);
        len -= off;
      }
    }
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(master, chunk, sizeof chunk);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) break; /* EIO once the child's side is closed */
      write_all(1, chunk, (size_t)n);
    }
  }
  if (!have_status) {
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  }
  return status_code(status);
}
