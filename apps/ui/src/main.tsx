import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ThemeModeProvider } from './theme-mode.js';
import { App } from './App.js';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <ThemeModeProvider>
      <App />
    </ThemeModeProvider>
  </StrictMode>,
);
