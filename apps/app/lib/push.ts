/** Push-notification registration. Asks permission, obtains the Expo push token,
 * registers it with the metro daemon so messenger inbounds get pushed. */

import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(daemonUrl: string, token: string): Promise<{ pushToken: string } | { error: string }> {
  if (!Device.isDevice) return { error: 'Push only works on a real device.' };

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messenger', {
      name: 'Messenger',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#FFFFFF',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return { error: 'Permission denied' };

  const projectId = '1707f2db-c2b8-4c91-9341-27b1d57d355f';
  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  const pushToken = tokenData.data;

  const res = await fetch(`${daemonUrl.replace(/\/$/, '')}/api/messenger/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pushToken }),
  });
  if (!res.ok) return { error: `daemon ${res.status}` };
  return { pushToken };
}
