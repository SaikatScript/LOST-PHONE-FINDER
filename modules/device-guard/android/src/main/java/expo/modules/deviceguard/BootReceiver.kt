package expo.modules.deviceguard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService

/**
 * Phase 5B: after a reboot (or an app update) Android keeps no location
 * request alive — expo-location does not restore it on its own. Waking the JS
 * headlessly re-arms the foreground service, sends one immediate fix (which
 * re-seals + broadcasts if the phone is offline) and runs a mesh agent pass.
 */
class BootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    val interesting = action == Intent.ACTION_BOOT_COMPLETED ||
      action == Intent.ACTION_MY_PACKAGE_REPLACED ||
      action == "android.intent.action.QUICKBOOT_POWERON"
    if (!interesting) return

    Log.i(TAG, "wake after $action — resuming protection")
    try {
      HeadlessJsTaskService.acquireWakeLockNow(context)
      context.startService(Intent(context, BootTaskService::class.java))
    } catch (e: Exception) {
      // Some OEMs block background service starts; the next app launch still
      // resumes everything, so this is best-effort.
      Log.w(TAG, "headless start failed: ${e.message}")
    }
  }

  companion object {
    private const val TAG = "DeviceGuard"
  }
}
