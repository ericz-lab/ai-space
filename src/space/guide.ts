/**
 * The workspace guide: `CLAUDE.md` and `AGENTS.md` written into `<workspace>/`
 * the first time it is created, for a coding agent someone starts by hand in
 * the workspace or in one of its app directories (Claude Code reads the
 * `CLAUDE.md` of every parent directory). It tells the agent where it is, how
 * to talk to the running ai-space and what not to touch. Written once, never
 * overwritten: the operator owns the file after that and edits it freely.
 *
 * Keep it generic (no real app or machine names) and short: the details live
 * in the checkout's `AGENTS.md` and `docs/`, which the guide points at.
 */

export const GUIDE_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

export const WORKSPACE_CLAUDE_MD = `@AGENTS.md
`;

export const WORKSPACE_AGENTS_MD = `# AGENTS.md - ai-space workspace

You are in an ai-space workspace: one directory that holds everything a running ai-space owns on this machine. This file is for an agent operating the space (running apps, tasks, data), not for changing ai-space's own code. Written once by \`init\`; edit it as this workspace needs.

## Layout

- \`core/\` - the ai-space checkout that runs here (when deployed by \`git push\`). Its \`AGENTS.md\` and \`docs/\` are the reference: \`docs/app-spec.md\` (what an app is, \`space.yaml\`), \`docs/scheduler.md\`, \`docs/storage.md\`, \`docs/backup.md\`, \`docs/notify.md\`, \`docs/model.md\`, \`docs/runtimes.md\`, \`docs/panel.md\`, \`docs/peers.md\`, \`docs/terminal.md\`, \`docs/install.md\`.
- \`apps/<app>/\` - one directory per app, each its own git repository with a \`space.yaml\`. Change an app inside its own directory; it usually has its own \`CLAUDE.md\` or \`AGENTS.md\`, which applies on top of this one.
- \`data/\` - runtime state: \`space.db\` (ai-space's own), then one directory per app holding its databases, \`blobs/\` and \`space.env\` (the variables ai-space hands the app).
- \`logs/\` - task run logs.
- \`.env\` - ai-space configuration and the secrets app manifests reference. \`secrets/\`, when present, holds encrypted secrets.
- \`.claude/skills/\` - links to every shared skill and every app's skills; ai-space refreshes them on boot and on each apps sync.
- \`runtimes.yaml\` - the AI runtimes this space can start (\`docs/runtimes.md\`).

## The running service

ai-space listens on the host and port in \`.env\` (\`SPACE_HOST\`, \`SPACE_PORT\`; default \`127.0.0.1:8700\`) as the user unit \`ai-space\`:

\`\`\`sh
curl -s http://127.0.0.1:8700/healthz
journalctl --user -u ai-space -n 50          # logs
systemctl --user restart ai-space             # after editing .env
\`\`\`

Mutating routes take \`Authorization: Bearer $SPACE_API_TOKEN\` (the token is in \`.env\`). The ones an operator reaches for:

- \`POST /api/apps/sync\` after adding, removing or editing an app's \`space.yaml\`; \`POST /api/apps/<app>/sync\` for one app.
- \`GET /api/tasks\`, \`POST /api/tasks/<id>/run\`, \`PATCH /api/tasks/<id>\` (\`{ enabled }\`), \`GET /api/tasks/<id>/runs\`.
- \`GET /api/services\` (every app's health), \`GET /api/apps?all=1\`.
- \`POST /api/notify\` to send a message; \`GET /api/notify/channels\`.
- \`GET /api/backups\`, \`POST /api/apps/<app>/backups\` to snapshot now.
- \`POST /api/model/run\`, \`GET /api/model/usage\` for model calls and their cost.

The same from the shell, run inside \`core/\`: \`bun src/index.ts env <app>\` (an app's provisioned variables), \`bun src/index.ts notify\`, \`backup <app>\`, \`backups\`, \`restore <app>\`.

## Rules

- Do not edit databases under \`data/\` by hand or with sqlite while the service runs; go through the app's own commands or the API. Restores go through \`restore\`.
- \`.env\`, \`data/*/space.env\` and \`secrets/\` hold credentials: never print them in full, paste them into a chat, or commit them anywhere.
- \`core/\` is a deployment checkout, not a place to develop: changes are made in the source repository and arrive by \`git push\`. Read it, do not edit it here.
- An app is changed in its own repository under \`apps/<app>/\` with its own commits; \`git status\` there before you start, and keep the app's \`space.yaml\` valid (\`docs/app-spec.md\`).
- A new app, or an existing project to bring in, follows the \`space-app\` skill; a message to a person goes through the \`notify\` skill.
- Ask before stopping a service, deleting an app or its data, or restarting ai-space while tasks are running.
`;
