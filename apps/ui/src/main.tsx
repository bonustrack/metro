import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@metro-labs/kit';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
