# Private browser access

Biologue can run on a server while you use its workbench from another computer.
Project files, Pi authentication, the database, and R/Python sessions stay on the
server. Connected browsers share that workspace; this is still a single-user app.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) makes the
interface available over HTTPS according to your tailnet's access policy. Connect
the remote computer to the same tailnet (or use appropriate device sharing and
access), then open the HTTPS URL. No Tauri installation is needed there.

## Normal Linux host

Build once, then start the built workbench and managed Jupyter runtime:

```bash
npm run build
BIOLOGUE_EXTERNAL_ORIGIN=https://machine.your-tailnet.ts.net npm run serve
```

Replace the example origin with the machine's Tailscale HTTPS address. From another
terminal on that host:

```bash
tailscale serve --bg http://127.0.0.1:4317
```

`npm run serve` uses the development launcher's project/state settings and orderly
shutdown, but serves the built frontend without Vite or hot reload. It starts
authenticated Jupyter internally unless `JUPYTER_URL` is supplied. Restarting the
launcher restarts its managed kernels: history persists, but live objects do not.

`BIOLOGUE_EXTERNAL_ORIGIN` accepts one exact HTTPS origin, without a trailing slash or
path. The default remains local-only. Foreign browser origins, other remote Host
values, and mutations missing the workbench header remain rejected. This setting
does not provide authentication; access must remain behind the private proxy.
Jupyter and model credentials are never sent to the browser.

## Supplied Docker workspace

Application commands run in `codex-universal`, while Tailscale runs on the host.
`BIOLOGUE_SOCKET` makes the application listen on a Unix socket in the shared workspace
instead of a TCP port. Its parent directory must exist; the socket is restricted
to its owner. Give Tailscale the host-side path:

```bash
tailscale serve --bg unix:/root/workspace/biologue/.biologue/serve/http.sock
```

The configured deployment runs as `biologue.service`, enabled at host startup.
It uses `examples/sandbox` and its saved Pi configuration. Machine-specific
settings, launcher scripts, and the process ID live in ignored `.biologue/serve/`;
the unit is `/etc/systemd/system/biologue.service`.

Host administration:

```bash
systemctl status biologue
journalctl -u biologue --since '10 minutes ago'
systemctl restart biologue
```

After changing code, build inside `codex-universal` before restarting the service.
The service stops the application before Jupyter and restarts after process
failure. Tailscale Serve's background configuration persists separately. To
remove browser access:

```bash
tailscale serve --https=443 off
```

The frontend and `/api` use the same HTTPS origin, including the event stream.
Only the application socket is proxied; Jupyter remains internal.
