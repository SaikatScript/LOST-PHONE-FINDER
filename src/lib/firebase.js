import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeAuth,
  getReactNativePersistence,
  getAuth,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Firebase JS SDK (works in Expo Go + Dev Build + Web).
// Fill these from Firebase Console > Project Settings > Your apps > Web app.
// Use EXPO_PUBLIC_ vars so they are visible to the client (see .env.example).
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? 'api-key',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'project-id.firebaseapp.com',
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL ?? undefined,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? 'project-id',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? 'project-id.appspot.com',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_SENDER_ID ?? 'sender-id',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? 'app-id',
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID ?? undefined,
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Auth with AsyncStorage persistence (required for React Native).
// See https://expo.fyi/firebase-js-auth-setup (Firebase v10+ pattern).
let auth;
try {
  auth = initializeAuth(firebaseApp, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
} catch (e) {
  // initializeAuth throws if already initialized (e.g. Fast Refresh).
  auth = getAuth(firebaseApp);
}

export { auth };
export const db = getFirestore(firebaseApp);

export const isFirebaseConfigured =
  (process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? 'api-key') !== 'api-key';
