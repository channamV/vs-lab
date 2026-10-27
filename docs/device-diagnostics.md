# Device diagnostics (log on the memory card + restart reports)

**Why** (Craig, 2026-10-26): to diagnose problems after a restart. Until now the device's diagnostic messages
("[NET] Logout", "[OBD] ECU OFF", errors) only went out the USB cable and were lost unless a laptop was attached;
the memory card only held the readings (`/DATA/<n>.CSV`).

## Firmware (done 2026-10-27, `feat/cell-beam`; details in `firmware/README.md`)

Built as below, with these differences: the start-up counter is kept in the device's settings memory (NVS), not on
the card, so it keeps counting with a card swapped or missing; the log is written every 3 s (also straight before
any restart the firmware makes itself), not straight away for errors; a log file over 8 MB becomes `<n>.OLD` (an
always-awake device keeps its latest lines); the restart reason isn't written as a separate first line (the
`[BOOT] start-up #n, firmware …, restart reason: …` line is). Reasons are sent with the names VS-lab already
accepts (`power_on`, `software`, `crash`, `watchdog`, `brownout`, `external`, `unknown`). Desk test 2026-10-27:
reports of 3–16 KB delivered and answered 200.

The plan as written:

1. **Log file on the card.** Copy every diagnostic message (what goes to `Serial`) to `/LOG/<start-up number>.TXT`, one
   file per start-up, each line starting with the time (GPS time once known, else uptime in seconds). Write it to the
   card every few seconds (and straight away for errors), so a power cut loses at most the last few lines. Keep the
   total under a cap (e.g. 200 MB): delete the oldest files first. Keep a start-up counter on the card.
2. **Restart reason.** At start-up read `esp_reset_reason()` and write it as the first line of the new log file.
3. **Tell VS-lab on login.** The login notification (`EV=1`) after a start-up adds `&RST=<reason>&BOOT=<n>`, reason as a
   name (`poweron`, `ext`, `sw`, `panic`, `int_wdt`, `task_wdt`, `wdt`, `deepsleep`, `brownout`, `sdio`, `unknown`) or
   the ESP-IDF number. VS-lab also accepts the names our firmware sends since `4d495a4`: `power_on`, `software` (woke
   from sleep or restart command: not tampering), `crash`, `watchdog`, `brownout`, `external`, `unknown`.
4. **Send the restart report.** Right after that login: `POST /hub/api/diag/<DEVID>`, body
   `BOOT=<n>;RST=<reason>` on the first line, then the **last log lines of the previous start-up** (up to 200 lines,
   16 KB; the lines leading up to the restart are the useful ones). Retry on the next login if it doesn't get a 200.

## VS-lab (done 2026-10-26)

- `GET /hub/api/notify/<DEVID>?EV=1&RST=&BOOT=`: the reason is stored with the login event ("Restarted: crashed
  (software fault) (start-up #41)" in the staff device page's connection events) and used by the tamper check
  (`src/lib/tamper.ts`). Restarting without signing off was always called a power cut; now:
  - `poweron`, `ext`, `unknown` or no reason (stock firmware): **power interrupted**, medium concern (as before);
  - `brownout`: **supply voltage dropped too low** (weak or disconnected battery, loose wiring), medium concern;
  - `panic`, the watchdogs, `sw`, `deepsleep`: **the device restarted by itself**, low concern (no alert): a fault to
    fix, not tampering.
- `POST /hub/api/diag/<DEVID>` (`src/lib/diagnostics.ts`, tested): known devices only (else 403); stored in
  `device_diagnostics` (last 30 per device; deleted after 90 days by the nightly clean-up, as log lines can include
  positions). Shown on the staff device page (Platform → Devices → device) under **Restart reports**, newest first,
  with the lines in an expandable box.
- Reasons and wording: `src/lib/restart-reasons.ts`.
