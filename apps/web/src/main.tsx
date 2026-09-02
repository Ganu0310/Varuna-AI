import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, readTheme } from './lib/theme.ts';
import { App } from './app/App.tsx';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

applyTheme(readTheme());

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
