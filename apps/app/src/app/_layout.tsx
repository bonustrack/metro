import { type ReactNode, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Slot } from 'expo-router';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { hideAsync, preventAutoHideAsync } from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import calibreMedium from '../../assets/fonts/Calibre-Medium-Custom.ttf';
import calibreSemibold from '../../assets/fonts/Calibre-Semibold-Custom.ttf';
import { ThemeProvider } from '../lib/theme.js';
import { Screen } from '../components/Screen.js';
import { prepareLocation } from '../lib/location.js';
import { prepareStorage } from '../lib/storage.js';
import { logError } from '../lib/log.js';

const FONTS = { 'Calibre-Medium': calibreMedium, 'Calibre-Semibold': calibreSemibold };

const styles = StyleSheet.create({ fill: { flex: 1 } });

prepareLocation();
preventAutoHideAsync().catch(logError('splash'));

export default function RootLayout(): ReactNode {
  const [fonts, fontError] = useFonts(FONTS);
  const [stored, setStored] = useState(false);
  useEffect(() => {
    prepareStorage()
      .catch(logError('storage'))
      .finally(() => {
        setStored(true);
      });
  }, []);
  const ready = (fonts || fontError !== null) && stored;
  useEffect(() => {
    if (ready) hideAsync().catch(logError('splash'));
  }, [ready]);
  if (!ready) return <Slot />;
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.fill}>
        <ThemeProvider>
          <StatusBar style="light" />
          <Screen />
        </ThemeProvider>
        <Slot />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
