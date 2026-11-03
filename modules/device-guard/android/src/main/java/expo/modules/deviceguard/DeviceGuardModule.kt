package expo.modules.deviceguard

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Phase 5B hardening (Android):
 *  - device admin activation/deactivation (anti-uninstall gate),
 *  - battery optimization exemption request ("Don't kill my app"),
 *  - OEM auto-start settings shortcuts (Xiaomi, OPPO/Realme, vivo, Huawei, Samsung).
 */
class DeviceGuardModule : Module() {

  private fun ctx(): Context = requireNotNull(appContext.reactContext) { "React context lost" }

  private fun admin(): ComponentName = ComponentName(ctx(), DeviceGuardAdminReceiver::class.java)

  private fun start(context: Context, intent: Intent): Boolean {
    return try {
      val activity = appContext.currentActivity
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DeviceGuard")

    Function("isDeviceAdminActive") {
      val dpm = ctx().getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      dpm.isAdminActive(admin())
    }

    AsyncFunction("requestDeviceAdmin") {
      val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
        putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin())
        putExtra(
          DevicePolicyManager.EXTRA_ADD_EXPLANATION,
          "Blocks uninstalling Lost Phone Finder until device admin is switched off. " +
            "The app can also lock the screen remotely. It never wipes data."
        )
      }
      start(ctx(), intent)
    }

    Function("removeDeviceAdmin") {
      val dpm = ctx().getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      try {
        dpm.removeActiveAdmin(admin())
        true
      } catch (_: Exception) {
        false
      }
    }

    Function("isIgnoringBatteryOptimizations") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        true
      } else {
        val pm = ctx().getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.isIgnoringBatteryOptimizations(ctx().packageName)
      }
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        true
      } else {
        val intent = Intent(
          Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
          Uri.parse("package:${ctx().packageName}")
        )
        start(ctx(), intent)
      }
    }

    AsyncFunction("openBatterySettings") {
      start(ctx(), Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    AsyncFunction("openAutoStartSettings") {
      val context = ctx()
      val candidates = listOf(
        ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
        ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
        ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        ComponentName("com.oplus.safecenter", "com.oplus.safecenter.startupapp.StartupAppListActivity"),
        ComponentName("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"),
        ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
        ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
        ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
        ComponentName("com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity")
      )
      var opened = false
      for (component in candidates) {
        val intent = Intent().setComponent(component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          context.startActivity(intent)
          opened = true
          break
        } catch (_: Exception) {
          // not present on this OEM — try the next one
        }
      }
      if (!opened) {
        opened = start(
          context,
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        )
      }
      opened
    }

    Function("isBootPersistenceSupported") { true }
  }
}
