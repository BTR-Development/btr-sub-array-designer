import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './index.css';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { BRANDING } from './branding';
import { useStore } from './state/store';
import { installAutosave } from './state/autosave';
import { tutorialSeen } from './state/tutorial';

document.title = BRANDING.productName;

// Before the first render, so the marker from a session that never closed is
// read while it is still there.
installAutosave();

// The first run ever opens on the guided tour. Decided here and not in App, which
// also mounts in tests and has no business looking at this machine's history.
if (!tutorialSeen()) useStore.getState().setTutorialOpen(true);

// Dev-only escape hatch: lets the store be inspected/driven from the console.
if (import.meta.env.DEV) {
  (window as unknown as { __btr: typeof useStore }).__btr = useStore;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
