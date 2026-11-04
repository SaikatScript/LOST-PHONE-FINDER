package expo.modules.meshadvertiser

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/**
 * Lost Phone Finder mesh beacon (stolen-phone role).
 *
 * Advertises the mesh service UUID and serves ONE sealed location packet over
 * a GATT characteristic that helpers read. ble-plx is central-only, so this
 * native module closes the gap. Runtime Bluetooth grants are requested from
 * JS (PermissionsAndroid) before startBeacon is called.
 */
class MeshAdvertiserModule : Module() {
  private var advertiser: BluetoothLeAdvertiser? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var gattServer: BluetoothGattServer? = null
  private var advertising = false
  private var lastError: String? = null

  override fun definition() = ModuleDefinition {
    Name("MeshAdvertiser")

    Events("onBeaconEvent")

    Function("isAdvertising") {
      return@Function advertising
    }

    Function("getLastError") {
      return@Function lastError ?: ""
    }

    Function("startBeacon") { serviceUuidStr: String, charUuidStr: String, packetBase64: String ->
      return@Function startBeaconInternal(serviceUuidStr, charUuidStr, packetBase64)
    }

    // Airplane mode switches Bluetooth off on many phones. The stolen phone has
    // nobody to tap a switch, so JS asks the stack to turn the radio back on
    // before advertising/scanning. Async so the 8 s wait never blocks the JS
    // thread (the UI keeps rendering while the radio comes up).
    AsyncFunction("ensureBluetoothEnabled") {
      ensureBluetoothEnabled()
    }

    Function("stopBeacon") {
      stopBeaconInternal()
      return@Function true
    }
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private fun fail(message: String): Boolean {
    lastError = message
    try {
      sendEvent("onBeaconEvent", bundleOf("type" to "error", "message" to message))
    } catch (_: Exception) {
      // ignore event-delivery failures
    }
    return false
  }

  /**
   * Turns Bluetooth back on when airplane mode (or the user) switched it off.
   * Returns "" on success, otherwise a human-readable reason. Android 13+ only
   * allows the user to flip this switch, so there we report the real cause
   * instead of pretending the beacon failed for an unknown reason.
   */
  @SuppressLint("MissingPermission")
  @Suppress("DEPRECATION")
  private fun ensureBluetoothEnabled(): String {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      ?: return "Bluetooth unavailable on this device"
    val adapter: BluetoothAdapter = manager.adapter ?: return "Bluetooth adapter missing"
    if (adapter.isEnabled) return ""
    if (Build.VERSION.SDK_INT >= 33) {
      return "Bluetooth is off — Android 13+ needs one tap to turn it on"
    }
    try {
      val requested = adapter.enable()
      if (!requested) return "Bluetooth is off and the system refused to enable it"
    } catch (e: SecurityException) {
      return "Bluetooth is off — enable permission missing: ${e.message}"
    } catch (e: Exception) {
      return "Bluetooth is off — enable failed: ${e.message}"
    }
    val deadline = System.currentTimeMillis() + 8000
    while (System.currentTimeMillis() < deadline) {
      if (adapter.isEnabled) {
        // The adapter reports enabled slightly before the LE advertiser is
        // published — give the stack a beat so startAdvertising does not race it.
        try {
          Thread.sleep(500)
        } catch (_: InterruptedException) {
          // keep going; the radio is already on
        }
        return ""
      }
      try {
        Thread.sleep(200)
      } catch (_: InterruptedException) {
        break
      }
    }
    return "Bluetooth did not turn on within 8 s"
  }

  @SuppressLint("MissingPermission")
  private fun startBeaconInternal(
    serviceUuidStr: String,
    charUuidStr: String,
    packetBase64: String
  ): Boolean {
    stopBeaconInternal()
    lastError = null

    val serviceUuid: UUID
    val charUuid: UUID
    val packet: ByteArray
    try {
      serviceUuid = UUID.fromString(serviceUuidStr)
      charUuid = UUID.fromString(charUuidStr)
      packet = Base64.decode(packetBase64, Base64.DEFAULT)
    } catch (e: Exception) {
      return fail("Bad arguments: ${e.message}")
    }
    if (packet.isEmpty()) return fail("Empty packet")
    if (packet.size > 512) return fail("Packet too large (${packet.size}B, max 512B)")

    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      ?: return fail("Bluetooth unavailable on this device")
    val adapter: BluetoothAdapter = manager.adapter ?: return fail("Bluetooth adapter missing")
    if (!adapter.isEnabled) return fail("Bluetooth is turned off")
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      return fail("BLE not supported on this device")
    }
    if (Build.VERSION.SDK_INT >= 31) {
      val adv = context.checkSelfPermission("android.permission.BLUETOOTH_ADVERTISE")
      val conn = context.checkSelfPermission("android.permission.BLUETOOTH_CONNECT")
      if (adv != PackageManager.PERMISSION_GRANTED || conn != PackageManager.PERMISSION_GRANTED) {
        return fail("Need BLUETOOTH_ADVERTISE + BLUETOOTH_CONNECT grants")
      }
    }

    val server = manager.openGattServer(context, gattCallback)
      ?: return fail("GATT server failed to open")
    val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    val characteristic = BluetoothGattCharacteristic(
      charUuid,
      BluetoothGattCharacteristic.PROPERTY_READ,
      BluetoothGattCharacteristic.PERMISSION_READ
    )
    characteristic.value = packet
    service.addCharacteristic(characteristic)
    if (!server.addService(service)) {
      try { server.close() } catch (_: Exception) {}
      return fail("GATT service rejected by stack")
    }
    gattServer = server

    val bleAdvertiser = adapter.bluetoothLeAdvertiser
    if (bleAdvertiser == null) {
      try { server.close() } catch (_: Exception) {}
      gattServer = null
      return fail("BLE advertising unsupported on this device")
    }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceUuid(ParcelUuid(serviceUuid))
      .build()
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
        advertising = true
        try {
          sendEvent("onBeaconEvent", bundleOf("type" to "started"))
        } catch (_: Exception) {
          // ignore event-delivery failures
        }
      }

      override fun onStartFailure(errorCode: Int) {
        advertising = false
        fail("Advertise failed (code $errorCode)")
      }
    }
    advertiser = bleAdvertiser
    advertiseCallback = callback
    try {
      bleAdvertiser.startAdvertising(settings, data, callback)
    } catch (e: Exception) {
      advertiser = null
      advertiseCallback = null
      try { server.close() } catch (_: Exception) {}
      gattServer = null
      return fail("startAdvertising threw: ${e.message}")
    }
    advertising = true
    try {
      sendEvent("onBeaconEvent", bundleOf("type" to "started"))
    } catch (_: Exception) {
      // ignore event-delivery failures
    }
    return true
  }

  private val gattCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        try {
          sendEvent(
            "onBeaconEvent",
            bundleOf("type" to "helper-connected", "device" to (device.address ?: "?"))
          )
        } catch (_: Exception) {
          // ignore event-delivery failures
        }
      }
    }

    @SuppressLint("MissingPermission")
    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic
    ) {
      val server = gattServer ?: return
      val full = characteristic.value ?: ByteArray(0)
      // Long-read support: helpers fetch >MTU values in offset chunks.
      val chunk = if (offset >= full.size) ByteArray(0) else full.copyOfRange(offset, full.size)
      try {
        server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
        sendEvent(
          "onBeaconEvent",
          bundleOf("type" to "packet-read", "device" to (device.address ?: "?"))
        )
      } catch (_: Exception) {
        // ignore event-delivery failures
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopBeaconInternal() {
    try {
      val adv = advertiser
      val cb = advertiseCallback
      if (adv != null && cb != null) adv.stopAdvertising(cb)
    } catch (_: Exception) {
      // ignore shutdown failures
    }
    advertiser = null
    advertiseCallback = null
    try {
      gattServer?.close()
    } catch (_: Exception) {
      // ignore shutdown failures
    }
    gattServer = null
    advertising = false
  }
}
