import { Platform } from 'react-native';

// Phase 5B hardening wrapper (Android-only native module "DeviceGuard"):
//   - device admin activation (anti-uninstall gate),
//   - battery optimization whitelist ("don't kill my app"),
//   - OEM auto-start settings shortcuts.
//
// Loaded lazily: dev binaries that predate the native module must keep
// working, so every call fails soft instead of red-screening at import time.

let native = null;
let tried = false;

function guard() {
  if (!tried) {
    tried = true;
    if (Platform.OS === 'android') {
      try {
        native = require('expo').requireNativeModule('DeviceGuard');
      } catch {
        native = null;
      }
    }
  }
  return native;
}

export function isDeviceGuardAvailable() {
  return !!guard();
}

export function isDeviceAdminActive() {
  try {
    return !!guard()?.isDeviceAdminActive();
  } catch {
    return false;
  }
}

export async function requestDeviceAdmin() {
  try {
    const g = guard();
    if (!g) return false;
    await g.requestDeviceAdmin();
    return true;
  } catch {
    return false;
  }
}

export function removeDeviceAdmin() {
  try {
    return !!guard()?.removeDeviceAdmin();
  } catch {
    return false;
  }
}

export function isIgnoringBatteryOptimizations() {
  try {
    const g = guard();
    if (!g) return true; // unknown → don't nag
    return !!g.isIgnoringBatteryOptimizations();
  } catch {
    return true;
  }
}

export async function requestIgnoreBatteryOptimizations() {
  try {
    const g = guard();
    if (!g) return false;
    return !!(await g.requestIgnoreBatteryOptimizations());
  } catch {
    return false;
  }
}

export async function openBatterySettings() {
  try {
    const g = guard();
    if (!g) return false;
    return !!(await g.openBatterySettings());
  } catch {
    return false;
  }
}

export async function openAutoStartSettings() {
  try {
    const g = guard();
    if (!g) return false;
    return !!(await g.openAutoStartSettings());
  } catch {
    return false;
  }
}
