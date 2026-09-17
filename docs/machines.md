# Machines: which one a session is on, and why nothing else may say

A space runs on one machine, but the sessions that operate it start in several places: an agent chat or a scheduled task on the host, a session someone opens by hand in the workspace, and a session on a development machine that reaches the host over ssh. The same skills and prompts serve all of them. This document is about the one fact those places differ in, which machine the session is on, and about the ways getting it wrong has cost us.

## What ai-space knows about a machine

| Fact | Source | Used for |
| --- | --- | --- |
| name | `SPACE_NAME` in the workspace `.env`; the hostname when unset | the badge on a hub's peer tiles, the machine list of the terminal, the default backup prefix `backups/<name>/`, the "This machine" section of the guide |
| hostname | the operating system | shown next to the name in the guide, so a session can match it against what `hostname` prints |
| user | the account ai-space runs as | shown in the guide; the account whose home holds the workspace |
| workspace | `SPACE_HOME`, default `~/.ai-space` | where `apps/`, `data/`, `.env` and the guide are |

`setup` asks for the name ([install.md](install.md)); pick a short, stable word that says which box this is (`office`, `gpu-box`), not the hostname. Cloud hostnames are opaque (`VM-0-2-ubuntu`, `ip-10-0-0-7`) and change when the machine is rebuilt. The hub refers to a peer by the name in its own `SPACE_PEER_<NAME>` variables; keep the two the same, or the panel shows one word and the peer's guide another.

Renaming a machine has consequences: the default backup target moves to the new prefix (pin `SPACE_BACKUP_URL` before renaming, or accept that old snapshots stay under the old prefix), the peer name on the hub must follow, and the guide is regenerated at the next boot.

## How a session learns where it is

The workspace `AGENTS.md` (`CLAUDE.md` is a link to it) opens with a "This machine" section that names the space, the hostname, the user and the workspace, and states that everything under the workspace is local: read the files, call the API on the loopback, never ssh. ai-space generates it on boot, on `init` and on every apps sync, from `SPACE_NAME` when the `.env` holds one (the guide sync reads the file itself, before the `.env` is loaded into the process) and from the hostname otherwise. Any agent tool started by hand anywhere in the workspace reads it, so the session knows where it is before it runs a command.

Sessions ai-space starts for an app (agent chat, agent tasks, command tasks) also get the app's environment: `SPACE_APP`, `SPACE_APP_DIR`, `SPACE_APP_DATA_DIR`, `SPACE_API_URL`, `SPACE_APP_TOKEN` and the storage hand-over (`DATABASE_URL`, `DATABASE_URL_<NAME>`, `BLOB_URL`) from `data/<app>/space.env`. A hand session gets those from the same file, or from `bun src/index.ts env <app>` run in `core/`.

A development machine has none of this for the host's data. That is the whole difference: on the host the production files exist locally, elsewhere they do not. Test for that, not for a name.

## The rule for skills and prompts

A skill, an agent prompt or a task prompt is written once and runs everywhere the app runs. It therefore never contains:

- a hostname, IP address or ssh alias;
- a home directory or any absolute path outside the workspace;
- a marker of its own that says which machine this is (`PROD=1`, `AGENT_ENV=prod`) and that only one machine sets.

It takes paths from the app's environment, the API from `SPACE_API_URL`, and where it is running from the "This machine" section. When it must reach another machine it takes that host from the operator's notes in `AGENTS.local.md` or the deployment section of the app's own `AGENTS.md`, or it asks; and it says in its text that it does so. The test is that moving the app to another host changes nothing in the skill. The same rule is stated where skills are written: [app-spec.md](app-spec.md) (the `skills` section), the `space-app` skill (step 3.5) and the app template's `AGENTS.md`.

The shape that has worked is a small locator script in the app repository that the skills share. It reads the workspace `space.env` files, reports whether the production data is on this machine and where, and offers one way to run a command that works in both places:

```sh
WS=${SPACE_HOME:-$HOME/.ai-space}
db=${DATABASE_URL_MYAPP#sqlite://}
[ -z "$db" ] && db=$(sed -n 's#^DATABASE_URL_MYAPP=sqlite://##p' "$WS/data/my-app/space.env" 2>/dev/null)
[ -n "$db" ] && [ -f "$db" ] || db=""            # the repository's own data/ copy never counts
if [ -n "$db" ]; then echo "export WHERE=host"; else echo "export WHERE=remote"; fi
echo "export MYAPP_DB=$db"
# run '<cmd>': in place on the host, over ssh to $MYAPP_SSH elsewhere (the remote side re-runs this script first)
echo 'run() { if [ "$WHERE" = host ]; then bash -c "$1"; else ssh "${MYAPP_SSH:?set MYAPP_SSH or ask the operator}" '"'"'eval "$(bash ${SPACE_HOME:-$HOME/.ai-space}/apps/my-app/scripts/locate.sh)"; '"'"'"$1"; fi; }'
```

A skill then starts with `eval "$(bash scripts/locate.sh)"` and writes every command as `run '...'`. The only machine fact left is `MYAPP_SSH`, which lives in the developer's shell or an ignored config file and is documented in the app's deployment section, not in the skill.

## Pitfalls

Each of these has happened.

- **A marker only one place sets.** A skill decided "no `AGENT_ENV=prod`, so this is the development machine, ssh to the server". The variable was set inline in one task command in `space.yaml` and nowhere else, so a session someone opened on the host lacked it, concluded it was elsewhere, and was sent over ssh to the machine it was on. The agent then spent several commands probing the public IP to find out where it was. A marker is a guess dressed as a fact; the guide section and the presence of the data files are the facts.
- **Paths from before the move.** The skill named `~/<project>/data/<db>` from the time the app ran from a home directory. After the app moved into the workspace the database lived under `data/<app>/`, the old path was empty, and the skill kept pointing at it. Paths belong in `space.env`; a skill that spells one out will be wrong after the next move.
- **The hostname as the name.** With `SPACE_NAME` unset the guide, the peer badge and the backup prefix all use the cloud hostname, which tells a reader nothing and changes when the box is rebuilt. Set the name at install time.
- **One skill text, two machines.** The workspace links every app's skills for hand sessions, so a skill written on the development machine with "I am on the dev machine" built in is exactly what runs on the host. There is no separate host copy to fix.
- **The repository's own database.** An app that keeps a development copy of its database in the repository (`data/<db>`, ignored by git) tempts a session into reading it; it is weeks stale and once produced a confident wrong answer. A locator must refuse to fall back to it: no production file on this machine means `remote`, never "use the local copy".
- **Another app's data.** A skill that reads a second app's database guessed that app's path too. Read the other app's `data/<other>/space.env`; that is a workspace convention, not a machine fact, and it follows the data when it moves.
- **Quoting that differs by place.** Commands that were written for `ssh host '...'` and then had the ssh shell stripped for local use broke on quoting each time. One `run` wrapper keeps the rules identical: the command is one single-quoted string in both places.
- **Machine facts spread across files.** Hosts and aliases ended up in four skills, a prompt, two scripts and a README, so each change to the host missed some of them. The deployment section of the app's `AGENTS.md` is the one place; everything else refers to it. ai-space's own repository stays generic and names no real machine at all.
- **Renaming without pinning the backup target.** The default backup prefix follows `SPACE_NAME`; change the name and the next snapshot goes to a new prefix while the old snapshots are no longer seen by retention or verify. Pin `SPACE_BACKUP_URL` first.
