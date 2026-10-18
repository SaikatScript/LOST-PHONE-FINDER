# Lost Phone Finder

Android anti-theft & lost-phone recovery app. Two operating modes:

- **Online mode** — phone has data: GPS fixes stream to Firestore, owner watches live.
- **Offline mesh mode** — no SIM/internet: the stolen phone broadcasts its sealed
  location over BLE; nearby phones running the app relay it to the cloud.

Built with **Expo (React Native, SDK 57)** + **Firebase serverless** (Auth, Firestore).

## Features

- Email/password auth, multiple devices per account (`FEATURES.txt` has the full list of 28).
- Background location tracking (10 min / 50 m) with battery + history + live maps.
- SIM-swap heuristics (carrier/MCC-MNC), LOST/emergency flag, on-device alerts, SMS fallback.
- Offline mesh: NaCl-sealed packets, SQLite store-and-forward, gateway relays,
  BLE helper scan + phone-as-beacon (custom native module `modules/mesh-advertiser`).

## Tech stack

| Layer | Choice |
|---|---|
| App | Expo SDK 57, Expo Router (`src/app/`), JavaScript (ES6+) |
| Backend | Firebase JS SDK: Auth, Firestore (no custom server) |
| Location | `expo-location` + `expo-task-manager`, `expo-battery` |
| Maps | Leaflet + Esri tiles (keyless; Google upgrade documented in `.env.example`) |
| Mesh | `tweetnacl`, `expo-sqlite`, `react-native-ble-plx`, `expo-crypto`, custom `MeshAdvertiser` module |
| Builds | EAS development builds (`eas.json`), CNG (no `android/` dir in repo) |

## Quick start

**Prerequisites:** Node 22+, a Firebase project, Expo account + EAS CLI. See `REQUIREMENTS.md`.

```bash
npm install
copy .env.example .env   # fill Firebase web-app config
npx expo start --clear
```

Open in Expo Go (JS-only features) or a dev build (location/BLE/SIM features):

```bash
npx eas build --profile development --platform android
```

Publish Firestore rules (needs `firebase-tools` login once):

```bash
npx firebase-tools deploy --only firestore:rules --project <your-id>
# or paste firestore.rules into console.firebase.google.com > Firestore > Rules
```

## Repo layout

- `src/app/` — Expo Router screens (`devices`, `device/[id]`, `map`, `mesh`, auth).
- `src/lib/` — Firebase, devices, locations, tracking, SIM, alerts, mesh (crypto/queue/relay/BLE).
- `src/components/DeviceMap.js` — keyless map (tile grid / Leaflet WebView switch).
- `modules/mesh-advertiser/` — local Expo native module (BLE advertiser + GATT server).
- `firestore.rules`, `firebase.json`, `eas.json`, `app.config.js` (+ `app.json` base).
- `FEATURES.txt` / `PROJECT_PROGRESS.txt` — detailed status logs.

## Status & limits (honest)

- Phases 1–3 tested on real devices; Phase 4a cloud relay proven (`decrypted 1`); **Phase 4b BLE radio verified on 2 phones (Samsung A50 ↔ OPPO, 19 Oct 2026): beacon → helper read → relay → harvest `checked 5, decrypted 5`**.
- True IMSI reads are impossible for store apps (system privilege) — SIM detection is heuristic.
- `expo-sms` opens the composer (one user tap); silent SMS needs a future native module.
- Mesh needs nearby app users to matter; background BLE obeys Android/Doze limits.

## License

Private project — all rights reserved (add a LICENSE file to change this).
