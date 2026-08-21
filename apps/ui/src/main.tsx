import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { makeQueryClient } from './api/queries';
import { ThemeModeProvider } from './theme-mode';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');

const queryClient = makeQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeModeProvider>
        <App />
      </ThemeModeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
