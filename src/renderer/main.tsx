import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api/client';
import { App } from './App';
import { boot } from './boot';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

void boot(
  createRoot(container),
  () => api.catalogGet(),
  <StrictMode>
    <App />
  </StrictMode>,
);
