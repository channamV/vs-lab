# VS Lab operator app (Android and iPhone)

The operator app for vs-lab: sign in with an emailed code, see my machines, do the pre-start checklist, check in,
and unlock Safety & Access Control machines over Bluetooth, with or without signal. What it does and why:
[../docs/operator-app.md](../docs/operator-app.md). Expo (React Native), one code base for both phones.

## Layout

| Path | What |
|---|---|
| `src/app/` | Screens (Expo Router: each file is a screen): `sign-in`, `machines`, `machine/[code]/checklist`, `machine/[code]/problem` |
| `src/lib/api.ts` | vs-lab's app API (`/api/app/*`); server address in `app.json` → `extra.apiUrl` |
| `src/lib/app-state.tsx` | Signed-in operator, machine list, offline queue (sends waiting check-ins when back online) |
| `src/lib/checklist-form.ts` | Checklist rules and the fields sent (tested: `npm test`) |
| `src/lib/ble.ts` | Bluetooth unlock: finds `VS-<device ID>`, writes the pass, reads the answer |
| `src/lib/offline.ts`, `session.ts`, `device.ts` | Saved data, sign-ins (secure storage), camera and location |

## Checks (run before committing)

```
npm run typecheck     # TypeScript
npm test              # checklist rules
npm run bundle        # builds the Android JavaScript bundle (catches import/config problems)
```

## Test builds (EAS, no Mac or Android Studio needed)

Android first: the build is an `.apk` that installs on any Android phone. iPhone needs an Apple developer account
(later). On a computer with Node (Craig's PC; the desktop Claude session can do this):

```
cd mobile
npm install
npx eas-cli@latest login                     # Craig's expo.dev account
npx eas-cli@latest init                      # once: links this folder to the expo.dev project (adds its ID to app.json)
npx eas-cli@latest build --profile preview --platform android
```

The build runs on Expo's servers (about 15 minutes) and ends with a link and QR code: open it on the Android phone
and install. With the GitHub repository connected on expo.dev (base directory `mobile`), builds can also be started
from the expo.dev website.

Later: a development build (`--profile development`) for live reloading while changing the app, and iPhone builds
through TestFlight once there's an Apple developer account.
