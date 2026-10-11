# Requirements — Lost Phone Finder

## System
- Node.js 22+ (`node --version`) and npm (`npm --version`)
- Git
- (Only for local native builds) Java 17 + Android Studio. Otherwise use EAS cloud builds — no local toolchain needed.

## Accounts & services
- Expo account (EAS builds): `npx expo login`, project links via `npx eas init`
- Firebase project with **Authentication > Email/Password** enabled and a **Firestore Database**; a Web app registered for the `.env` values
- Google account for Firebase console access

## Install (dependencies are pinned in package.json + package-lock.json)
```bash
npm install            # exact pinned tree via package-lock.json
npx expo install       # always use this (not npm add) for new Expo packages
npx expo-doctor        # must report 21/21 before building
```

## Configure
```bash
copy .env.example .env   # fill EXPO_PUBLIC_FIREBASE_* (+ optional MAP_RENDERER)
npx firebase-tools deploy --only firestore:rules --project <id>
```

## Run / build
```bash
npx expo start --clear                                   # dev server (same Wi-Fi as phone)
npx eas build --profile development --platform android   # dev APK (native features)
```

## On-device testing helpers
- Enable USB debugging + `adb install -r <apk>` for reliable sideloads
- Keep the phone on the same Wi-Fi as `expo start` (dev builds load JS remotely)
