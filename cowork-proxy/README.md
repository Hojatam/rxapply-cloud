# cowork-proxy

A tiny HTTP server that lets n8n run Claude agents via the local `claude` CLI.

## Endpoints

- `GET /health` — `{ ok: true, mode: "cowork" }`
- `POST /run-agent` — `{ agent, prompt, model? }` -> `{ ok, output, model }`
- `POST /run-agents-parallel` — `{ agents: [{agent, prompt, model?}, ...] }` -> `{ results: [...] }`

## Running

```powershell
cd cowork-proxy
npm install
node server.js          # listens on :7777
```

## Smoke test

```powershell
curl http://localhost:7777/health
# {"ok":true,"mode":"cowork","claudeBin":"claude"}

curl.exe -X POST http://localhost:7777/run-agent `
  -H "Content-Type: application/json" `
  -d '{\"agent\":\"smoke\",\"prompt\":\"Say hello in one sentence.\"}'
```

## n8n integration

Inside Docker, n8n reaches the host at `http://host.docker.internal:7777/run-agent`.
Use the HTTP Request node with that URL and a JSON body shaped like the smoke test.

## Logs

Every request appends a line to `proxy.log` in this folder. The file is git-ignored.
