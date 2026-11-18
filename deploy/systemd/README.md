# Compose service environment

`pi-chat.service` starts the Compose project from `/srv/chat`. Both `ExecStart`
and `ExecStop` pass `--env-file /srv/chat/.env` explicitly. Docker Compose reads
the persistent VAPID identity after systemd starts the command. Do not replace
this with a systemd `EnvironmentFile=` under the checkout: SELinux can prevent
systemd from reading that path.

Keep the existing VAPID private key and contact. Replacing the private key
invalidates existing browser subscriptions. Never commit or print the private
environment file or put its values in a unit file.

`scripts/repair-compose-vapid.sh` is an emergency tool for a missing VAPID key,
not a routine updater. Its recreation command removes inherited
`CHAT_VAPID_PRIVATE_KEY` and `CHAT_VAPID_SUBJECT` variables before Compose loads
the explicit environment file. This prevents empty or stale exported values
from overriding the saved identity.

The full repair helper can generate a key, write an environment file, save an
old-file copy, and recreate containers. Do not run it as a test or against a
working identity. Live repair and service installation require separate operator
authorization. These source changes do not install a unit or change a service.

## Safe validation

Run these checks from the repository root:

```sh
bash -n scripts/repair-compose-vapid.sh
python3 scripts/test-vapid-environment.py
systemd-analyze verify deploy/systemd/pi-chat.service
```

The Python tests inspect the unit and execute only the extracted recreation
command with fake `sudo` and Docker programs. They test empty and stale inherited
values and a checkout path with spaces. They never execute key generation, read
private environment files, create environment-file copies, or contact Docker.
CI runs these tests in its cheap validation stage.
