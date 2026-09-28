# My App

One sentence saying what the app does, for the person who will use it.

## Use

- Open the app at its public URL (set as `url:` in `space.yaml`), or on the host at `http://127.0.0.1:8710`.
- The panel shows the `latest` widget and lets you chat with the `assistant` agent.

## Run locally

```bash
bun install
cp .env.example .env      # fill in real values; never commit .env
PORT=8710 bun src/index.ts
curl -s http://127.0.0.1:8710/healthz
```

Inside an ai-space workspace the provisioned variables (`DATABASE_URL`, `BLOB_URL`, ...) come from `<workspace>/data/my-app/space.env`. For local development against the same values: `eval "$(bun <ai-space>/src/index.ts env my-app)"`.

## Deploy

`DEPLOY_HOST=<ssh host> ./deploy.sh` syncs the checkout into `<workspace>/apps/my-app`, installs the user-level systemd unit and checks `/healthz`. The workspace is `SPACE_HOME` when explicitly set, otherwise the target machine's installed ai-space unit's `SPACE_HOME`, otherwise `~/.ai-space` on that machine. `SPACE_HOME=/srv/space` selects a custom workspace; `DEPLOY_PATH` can independently override the app checkout. Relative paths and `~/` resolve under the remote user's home. The app unit reads provisioned variables from the selected workspace's `data/my-app/space.env`. See [AGENTS.md](AGENTS.md) for the host details once it is live.

This is an [ai-space](https://github.com/Zhang-Shubo/ai-space) app; the contract is its `docs/app-spec.md`.
