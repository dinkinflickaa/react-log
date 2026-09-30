import { useState } from 'react';
import { createRoot } from 'react-dom/client';

// One click, many updates. #fan's handler computes for 20 ms, so Event Timing
// reports the click, then calls every Cell's setter (?n= of them, default
// 24) from one line, then its own: one commit, n + 1 updates from two call
// sites. window.__fanMs: how long the setters' loop took.

const params = new URLSearchParams(location.search);
const n = Number(params.get('n') ?? 24);
const setters = [];

function Cell({ i }) {
  const [v, setV] = useState(0);
  setters[i] = setV;
  return <span>{v % 10}</span>;
}

function Fanout() {
  const [clicks, setClicks] = useState(0);
  const onClick = () => {
    const end = performance.now() + 20;
    while (performance.now() < end);
    const t = performance.now();
    for (const set of setters) set((v) => v + 1);
    window.__fanMs = performance.now() - t;
    setClicks((c) => c + 1);
  };
  return (
    <>
      <button id="fan" onClick={onClick}>
        fan {clicks}
      </button>
      {Array.from({ length: n }, (_, i) => (
        <Cell key={i} i={i} />
      ))}
    </>
  );
}

createRoot(document.getElementById('root')).render(<Fanout />);
