# OpenClaw laptop node one-click scripts

This folder configures the current laptop as a controllable OpenClaw node host and creates an SSH tunnel to your server gateway.

## Scripts

- `start-openclaw-node.cmd` one-click start
- `stop-openclaw-node.cmd` one-click stop
- `status-openclaw-node.cmd` check status

## Default connection values

- server: `47.254.195.180`
- user: `root`
- ssh key: `%USERPROFILE%\.ssh\fast-english_ed25519_20260204_220739`
- local forward port: `18790`
- remote gateway port: `18789`

## What start does

1. read `gateway.auth.token` from server
2. start SSH tunnel `127.0.0.1:18790 -> 47.254.195.180:18789`
3. start local `openclaw node run`
4. auto-approve pending node requests from server side
5. print latest server node status

## Logs

- `tools/openclaw-node/logs/ssh.stdout.log`
- `tools/openclaw-node/logs/ssh.stderr.log`
- `tools/openclaw-node/logs/node.stdout.log`
- `tools/openclaw-node/logs/node.stderr.log`

## Optional parameters

`start-openclaw-node.ps1` supports:

- `-DisplayName "Lenovo-Laptop"`
- `-Restart`
- `-ServerHost`
- `-ServerUser`
- `-SshKeyPath`
- `-LocalForwardPort`
- `-RemoteGatewayPort`

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\openclaw-node\start-openclaw-node.ps1 -DisplayName "Lenovo-Laptop" -Restart
```

## Validation command on server

If you want to verify remote command execution from the server side, use this form:

```bash
docker exec lobster-openclaw-openclaw-gateway-1 openclaw nodes invoke --node Lenovo-Laptop --command system.run --params '{"command":["whoami"]}' --json
```

