# Device commands (cloud to device)

Veristart staff can send commands to a tracking device: **Platform → the device → Commands**. The server side is
built and tested with the simulator; real devices need **our firmware version** (the stock Telelogger ignores
commands, harmlessly).

## How a command gets to the device

The device can't be called from the internet, so commands wait in a queue and ride along with the reply to the
device's next contact:
- while the engine runs, the device reports every few seconds, so a command arrives within seconds;
- while parked, the device checks in every 15 minutes, so a command can take up to 15 minutes.

The device runs it and answers. The page shows each command's progress: *Waiting for the device* → *Sent,
waiting for an answer* → *Done* / *Failed* (with the device's answer), or *Expired* (no answer within 24 hours,
or after 5 tries) / *Cancelled*. Unanswered commands are resent every minute, up to 5 times; the device skips
ones it has already run.

## The commands

| Command | What it does |
|---|---|
| Report now | Send a full report straight away |
| Sound the buzzer | Beep 1–10 times (find the device, or warn the operator) |
| Change reporting interval | Seconds between reports while running (1–60) |
| Set jobsite Wi-Fi | Network name and password for jobsite Wi-Fi such as Starlink ([firmware/README.md](../firmware/README.md)). The password isn't kept once the command is finished |
| Restart the device | Reboot it |
| Update firmware | Sent from **Platform → Firmware**, not this form: download, check and install a new version ([firmware-updates.md](firmware-updates.md)) |

More can be added as the firmware grows (e.g. starter relay lock/unlock for Safety & Access Control).

## Security: signed commands

Commands could change where a device sends its data or, later, stop a machine from starting, so the device must
only obey us:
- Each device has its **own key**, worked out from a server secret (`DEVICE_KEY_SECRET`) and the device ID. Staff
  see it on the device page (*Device key*) and write it into the device when flashing our firmware.
- Every command is **signed** with that key; the device ignores commands with a wrong signature.
- The device **signs its answers** too, so nobody else can mark a command done.
- Command IDs only go up, and the device remembers the last one it ran, so an old command can't be replayed.

**To turn signing on**, add `DEVICE_KEY_SECRET` in Vercel (Settings → Environment Variables; any long random
string, like `CRON_SECRET`; Production + Preview; Sensitive), then redeploy. Without it, commands go out unsigned:
fine for the simulator, not for real machines. Don't change it later without re-flashing devices: their keys
come from it.

## For the firmware (technical)

- Reply to `POST /hub/api/post/<id>`, `GET /hub/api/notify/<id>` and `GET /hub/api/push`: the first line is as
  before (`OK …`); each further line is `CMD <id> <signature> <command>`. The command is the rest of the line,
  e.g. `BEEP=3`, `RATE=10`, `REPORT`, `RESET`, `WIFI=<ssid><TAB><password>`,
  `UPDATE=<version><TAB><bytes><TAB><sha256><TAB><path>` ([firmware-updates.md](firmware-updates.md)). Up to 5 per reply.
- Signature: first 16 hex characters of HMAC-SHA256(device key, `<deviceId>\n<id>\n<command>`); `-` when signing
  is off. Device key: first 32 hex characters of HMAC-SHA256(`DEVICE_KEY_SECRET`, `device-key:<deviceId>`).
- Answer: `GET /hub/api/ack/<deviceId>?id=<id>&ok=1|0&result=<text>&sig=<signature>`, signature = first 16 hex of
  HMAC-SHA256(device key, `ack\n<deviceId>\n<id>\n<1|0>\n<result>`). Bad signature → 403.
- Code: `platform/src/lib/commands.ts` (tested); the simulator (`npm run simulate`) behaves like the firmware
  should, with `--device-secret` (default `$DEVICE_KEY_SECRET`).
