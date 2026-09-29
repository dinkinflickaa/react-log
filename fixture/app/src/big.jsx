import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Commits bigger than the capture buffer's first size: ?n= rows (default
// 40,000), each two components, so every commit writes twice that many render
// records at once. #tick re-renders every row; ?loop=<seconds> re-renders
// every row on every animation frame for that long (window.__ticks counts
// them, window.__loopDone says it ended), capture's worst case: more records
// than it can take as they come.

const params = new URLSearchParams(location.search);
const n = Number(params.get('n') ?? 40000);
const loopMs = Number(params.get('loop') ?? 0) * 1000;

function Cell({ v }) {
  return <span>{v % 10}</span>;
}

function Row({ i, tick }) {
  return <Cell v={i + tick} />;
}

function Big() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (loopMs === 0) return;
    const end = performance.now() + loopMs;
    let frame = 0;
    const step = () => {
      if (performance.now() >= end) {
        window.__loopDone = true;
        return;
      }
      setTick((t) => t + 1);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);
  window.__ticks = tick;
  return (
    <main>
      <button id="tick" onClick={() => setTick((t) => t + 1)}>
        tick {tick}
      </button>
      <div>
        {Array.from({ length: n }, (_, i) => (
          <Row key={i} i={i} tick={tick} />
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Big />);
