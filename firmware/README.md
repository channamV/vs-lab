# Firmware

## Today: stock firmware

The device runs Freematics' open-source **Telelogger** firmware, unmodified, configured to report
to our platform. Setup steps: [docs/freematics-setup.md](../docs/freematics-setup.md).

- Source: github.com/stanleyhuangyc/Freematics, `firmware_v5/telelogger`
- Device library (modem, GPS, OBD, buzzer): `libraries/FreematicsPlus`
- Build system: PlatformIO (`platformio.ini` is included upstream), Arduino framework on ESP32
- Our device: ONE+ Model H, SIM7670 modem (supported by `FreematicsPlus`; auto-detected)

## Next: our own fork

When Tier 2 needs device changes (see [product tiers](../docs/product-tiers.md)), we'll copy
Telelogger into `firmware/telelogger/`, keep the upstream version noted, and change it in small,
tested steps:

1. Enable SNI for HTTPS on the SIM7670 (if cellular uploads fail against Vercel)
2. Read commands from the server's reply to each upload (buzzer on/off, report interval)
3. BLE beacon scanning, adding nearby beacon IDs to each report
4. Over-the-air firmware updates
5. Device authentication

Each change follows the same loop: Claude edits → builds → flashes over USB → reads the serial log → fixes.
This must run on your PC (Claude Code with the device plugged in), not in a cloud session.
