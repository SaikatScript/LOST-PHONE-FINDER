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
      60_000L, // keep the JS alive long enough for GPS + one upload attempt
      true // allowed while the app is in the foreground too
    )
  }
}
