// Local alerts (on-device) + SMS composer fallback.
// Lazy requires: native modules postdate the installed dev binary.
const getNotifications = () => require('expo-notifications');
const getSMS = () => require('expo-sms');

export async function ensureNotificationPermission() {
  const Notifications = getNotifications();
  const res = await Notifications.requestPermissionsAsync();
  if (res.status !== 'granted') throw new Error('Notification permission denied.');
  return true;
}

export async function sendLocalAlert(title, body) {
  const Notifications = getNotifications();
  await Notifications.scheduleNotificationAsync({
    content: { title, body, priority: 'max' },
    trigger: null,
  });
}

// Blueprint §5.6 SMS fallback: expo-sms opens the system composer with the
// message prefilled — the user taps send. (Silent sending needs SEND_SMS +
// a custom native module; follow-up, not this phase.)
export async function sendLocationSms(ownerPhone, lat, lng, battery) {
  if (!ownerPhone) throw new Error('No owner phone saved for this device.');
  const SMS = getSMS();
  const available = await SMS.isAvailableAsync();
  if (!available) throw new Error('SMS not available on this device.');
  const text =
    `Lost Phone Finder alert! Device at https://maps.google.com/?q=${lat},${lng}` +
    (battery != null ? ` (battery ${battery}%)` : '');
  return SMS.sendSMSAsync([ownerPhone], text);
}
