import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OwnerGate } from './components/OwnerGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OwnerGate>
      <App />
    </OwnerGate>
  </StrictMode>,
);
