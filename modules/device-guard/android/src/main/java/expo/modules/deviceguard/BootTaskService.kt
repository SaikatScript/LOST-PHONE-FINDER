package expo.modules.deviceguard

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Runs the "lostphone-boot" JS task without showing any UI. */
class BootTaskService : HeadlessJsTaskService() {

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    return HeadlessJsTaskConfig(
      "lostphone-boot",
      Arguments.createMap(),
      120_000L, // GPS fix + upload attempt + beacon start can take ~45 s
      true // allowed while the app is in the foreground too
    )
  }
}
