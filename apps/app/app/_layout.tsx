import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

export default function RootLayout(): React.ReactElement {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: dark ? '#0f1115' : '#ffffff' },
          headerTintColor: dark ? '#e8ecf2' : '#1a1f29',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: dark ? '#0f1115' : '#ffffff' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Metro' }} />
        <Stack.Screen name="lines" options={{ title: 'Lines' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="event/[id]" options={{ title: 'Event' }} />
      </Stack>
    </>
  );
}
