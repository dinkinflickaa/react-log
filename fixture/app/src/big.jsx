import { useState } from 'react';
import { createRoot } from 'react-dom/client';

// One commit bigger than the capture buffer's first size: ?n= rows (default
// 40,000), each two components, so the first render writes twice that many
// render records at once. #tick re-renders every row.

const n = Number(new URLSearchParams(location.search).get('n') ?? 40000);

function Cell({ v }) {
  return <span>{v % 10}</span>;
}

function Row({ i, tick }) {
  return <Cell v={i + tick} />;
}

function Big() {
  const [tick, setTick] = useState(0);
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
