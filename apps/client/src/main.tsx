import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App';
import { registerWebServiceWorker } from './pwa-register';
import { publishServiceWorkerUpdate } from './pwa-update';
import './styles.css';
import './native.css';

document.documentElement.dataset.platform = Capacitor.getPlatform();

if (import.meta.env.PROD && !Capacitor.isNativePlatform()) {
  registerWebServiceWorker((apply) => publishServiceWorkerUpdate(apply));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
