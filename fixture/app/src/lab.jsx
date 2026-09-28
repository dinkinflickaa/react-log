import { createRoot } from 'react-dom/client';
import { Lab } from './lab/Lab.jsx';

// Interaction timing for the overhead benchmark. React handles a click in its
// root listener and commits the resulting sync-lane update in a microtask
// right after that listener returns. This bubble-phase listener on the
// document runs after both, so end - event.timeStamp covers input delay,
// handler, render, commit and synchronous passive effects.
window.__lab = { last: null };
document.addEventListener('click', (e) => {
  const end = performance.now();
  window.__lab.last = { id: e.target?.id ?? null, ms: end - e.timeStamp, end };
});

createRoot(document.getElementById('root')).render(<Lab />);
