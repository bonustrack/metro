import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KitThemeProvider, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { semanticPalette } from '@stage-labs/kit/tokens';
import { App } from './App';

function buildPalette(scheme: 'light' | 'dark'): KitPalette {
  const s = semanticPalette(scheme);
  return {
    bg: s.bgColor,
    border: s.borderColor,
    text: s.textColor,
    sub: s.subColor,
    link: s.linkColor,
    primary: s.primaryColor,
    danger: s.dangerColor,
    success: s.successColor,
    inputBg: s.inputBgColor,
    toolbarBg: s.toolbarBgColor,
  };
}

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');

const scheme: 'light' | 'dark' =
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

createRoot(container).render(
  <StrictMode>
    <KitThemeProvider value={buildPalette(scheme)} scheme={scheme}>
      <App />
    </KitThemeProvider>
  </StrictMode>,
);
