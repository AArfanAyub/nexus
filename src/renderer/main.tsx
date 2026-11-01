/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Renderer entry point.
 *
 * T02 ships a placeholder on purpose: it proves the three things that can break
 * silently — the window loads, the CSP allows our own bundle, and the preload
 * bridge answers `app.bootstrap`. T03 replaces `App` with the real shell.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('The root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
