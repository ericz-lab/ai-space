# Roadmap: what a space still owes an operating system

Status: a standing comparison, not a commitment. ai-space is the system a set of apps and agents
live in, so the useful question is not "what feature is next" but "what does an operating system
give the programs on it that a space does not give its apps yet". This document holds that
comparison and the order the gaps are worth closing in. It is rewritten when a row changes, and
the reasoning in each row matters more than its verdict.

The analogy is a tool, not a goal. A space is not a kernel and does not want to be one: apps are
ordinary processes, storage is SQLite and object storage, and the network is HTTP on loopback.
What the comparison is good for is noticing when two apps have solved something privately that
the system should have solved once — the way three hand-written point-to-point contracts turned
out to be an event bus.

## The comparison

| Concept | In a space today | What is missing |
| --- | --- | --- |
| **init, process management** | Yes, opt-in per machine: under `SPACE_SUPERVISOR=space` the space writes a user unit per app and starts, restarts, stops and removes it with the manifest ([supervision.md](supervision.md)). Under `operator` (the default), the operator's units as before. | Memory and CPU limits, ordering between apps, a guided hand-over of an app from the operator's unit, and the machines still on `operator`. |
| **Process lifecycle, graceful stop** | The space drains its own work on SIGTERM ([scheduler.md](scheduler.md#stopping-and-restarting)); a supervised app gets SIGTERM and 30 seconds from its unit. | An app's own drain: what the app does with the SIGTERM is still up to the app. |
| **cron, scheduling** | Yes: interval, cron and one-shot schedules, event triggers, http/command/agent targets, run history, backoff ([scheduler.md](scheduler.md)). | A global queue: priorities, a per-app concurrency limit, backpressure. Today one global limit decides who runs, in due-time order. |
| **IPC, message bus** | Yes: events with persisted, retried http and stream deliveries, calls between apps, mirroring across peers ([events.md](events.md)). | Finer permissions on a delivery, versioned contracts. |
| **System calls, intents** | Yes: an app declares `events:` and `provides:` in its manifest, the catalogue reaches agents and the panel ([events.md](events.md#catalogue)). | System-wide verbs a person or an agent can invoke anywhere ("save this", "send it to X"), rather than per-app endpoints. |
| **File system, storage** | Yes: per-app databases and blob stores, provisioned and handed over as environment variables ([storage.md](storage.md)), snapshots and restore ([backup.md](backup.md)). | A managed blob API; a shared area apps can read from each other without an HTTP round trip. |
| **Device drivers** | Yes, and it works well: the runtime adapter layer, one registry, several backends ([runtimes.md](runtimes.md)). | Routing and budgets across runtimes; `skills:` and `memory:` are parsed but not mounted. |
| **Virtual memory → an agent's memory** | Nothing. | A shared memory and knowledge layer. Notes, documents, graphs and clippings each sit in their own app, so an agent in one of them cannot see the others. |
| **Global search** | Nothing. | One search across every app's content. This is the clearest line between a system and a pile of separate sites. |
| **Users, permissions, audit** | At the edge, the access layer; inside, one shared token, with a capability's `callers:` as the first fine-grained rule. | Per-app capability permissions, an audit log (which agent did what, when), a secrets service of its own — secrets live outside the system today, and `${VAR}` substitution is the only bridge. |
| **Package management** | A start: install from a link, default apps, an installer, uninstall ([panel.md](panel.md)). | Versions, updates, rollback, declared dependencies between apps, a health check after an upgrade. |
| **Logs, metrics, tracing** | Partial: the log routes and `space logs` wrap the operator's log command; model calls have a ledger. | Per-app request rate, error rate and latency; a trace from a click through an app, the model service and a runtime, with what it cost. Diagnosing an incident today means reading the journal and querying the database by hand. |
| **Quotas** | The ledger records spend. | Budgets and throttling: a daily token or money cap per app, and what happens when it is reached. Nothing currently stops a failing call from being retried at full price. |
| **Network, service discovery** | Yes: one wildcard tunnel rule and a proxy whose configuration the space writes, so a new app needs no registration ([router.md](router.md), [ingress.md](ingress.md)); peers merge machines into one panel ([peers.md](peers.md)). | An app on one machine reaching an app on another still goes through a hand-made forward. |
| **Notification centre** | Outbound only: the notify service sends to chat channels ([notify.md](notify.md)). | An inbox in the panel — what every app produced, read and unread — and a way back, so a reply reaches an agent. |
| **Shell** | Yes: one `space` command over every operation ([cli.md](cli.md)), and a web terminal ([terminal.md](terminal.md)). | — |
| **Locale, time** | Yes ([i18n.md](i18n.md)). | — |
| **Backup, disaster recovery** | Yes, per app: snapshots, retention, verification, restore ([backup.md](backup.md)). | Rebuilding a whole machine from a bucket and one `.env`. The install documents are written for a person to follow; there is no single path back. |

## The order

1. **Service supervision.** The space starts, restarts and limits an app's process instead of
   probing something the operator installed. It is the prerequisite for upgrades with rollback,
   for resource limits, and for an uninstall that stops the app's work before moving its
   directory. The supervisor itself is in ([supervision.md](supervision.md)); what remains is
   `setup` offering it, fresh installs defaulting to it, and handing the running machines over
   app by app.
2. **Metrics and tracing.** With tens of apps, "what was running when that restart happened, and
   what did it cost" has to be answerable from one place. The log routes are the start; per-app rates and a trace with cost are the rest.
3. **Budgets.** The ledger without a limit only tells you afterwards what a loop cost.
4. **Shared memory and global search.** The difference between a system and a pile of sites.
5. **Package management and an inbox.** Versions, dependencies and rollback; and one place where
   what the apps produced is waiting.

## Not on this list

Not everything an operating system has belongs here. A space does not want its own scheduler for
threads, its own memory allocator, its own file formats, or a sandbox around each app: apps are
ordinary processes with ordinary permissions, and the machine already has all of that. The rows
above are about what several apps would otherwise each build for themselves.
