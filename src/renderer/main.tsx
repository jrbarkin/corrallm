import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api/client';
import { App } from './App';
import { boot } from './boot';
import { answerDraftFlushes } from './useDraft';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

// From the page's start: a quit asked before the app mounts finds nothing composed, at once.
answerDraftFlushes(window.api);

void boot(
  createRoot(container),
  () => api.catalogGet(),
  <StrictMode>
    <App />
  </StrictMode>,
);
