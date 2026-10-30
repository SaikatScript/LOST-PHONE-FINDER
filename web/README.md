# Lost Phone Finder — Web Tracker

A standalone, read-only web dashboard for the same Firebase project as the
mobile app. Sign in with the **same email and password** used in the app; the
site reads the devices and location history that the phone writes.

Live URL: **https://saikat-e8982.web.app**

## What it does

- Email/password login (Firebase Auth) + forgot-password email.
- Live device list (`users/{uid}/devices`) with LOST / SIM-swapped / online
  status, battery and last-seen time.
- Device page: satellite map (Esri, keyless) with the latest fix, accuracy
  circle, full location history, mesh-relay fixes, "Open in Google Maps" and
  "Copy coordinates".
- Real-time updates via Firestore `onSnapshot` (no refresh needed).
- Responsive dark UI matching the app's design tokens.

It never writes data and never touches tracking, mesh or SIM logic.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell, CDN links (Leaflet + fonts) |
| `styles.css` | Dark design system, responsive layout |
| `app.js` | Auth, Firestore subscriptions, map, routing |
| `config.js` | Public Firebase web config (not a secret) |
| `icon.png` | Favicon / app icon |

No build step: plain ES modules from the Firebase CDN.

## Data contract

```
users/{uid}/devices/{deviceId}
  deviceName, deviceModel, isLost, simSwapped, lastBattery,
  lastLocation { latitude, longitude }, lastAccuracy,
  lastLocationAt (ms), lastLocationSource, lastUpdate (Timestamp)

users/{uid}/devices/{deviceId}/locations/{id}
  lat, lng, accuracy, battery, source, timestamp (Timestamp)
```

## Deploy

From the repo root:

```bash
npx firebase-tools deploy --only hosting --project saikat-e8982
```

`firebase.json` maps Hosting to this `web/` folder. The Hosting domain
(`saikat-e8982.web.app`) is already in Firebase Auth → Authorized domains, so
login works without extra configuration.

## Local preview

```bash
npx serve web        # or any static server
```

`localhost` is also an authorized Auth domain.
