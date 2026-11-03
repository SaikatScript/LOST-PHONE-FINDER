package expo.modules.deviceguard

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Device admin gate: uninstall requires switching this off first. */
class DeviceGuardAdminReceiver : DeviceAdminReceiver() {

  override fun onEnabled(context: Context, intent: Intent) {
    Log.i(TAG, "device admin enabled")
  }

  override fun onDisabled(context: Context, intent: Intent) {
    Log.w(TAG, "device admin disabled — anti-uninstall protection is off")
  }

  override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
    return "Lost Phone Finder uses device admin so a thief cannot simply uninstall it. " +
      "If you continue, background tracking, SIM alerts and the offline Bluetooth relay will be easier to disable."
  }

  companion object {
    private const val TAG = "DeviceGuard"
  }
}
