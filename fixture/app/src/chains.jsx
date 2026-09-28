import { startTransition, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

// Update chains for the capture tests: what the chain linker connects.
//
//   #cascade     the click's commit runs a layout effect that enqueues an
//                update, and that update's commit a passive effect that
//                enqueues another: three commits, one chain
//   #batch       one handler, two updates, one commit
//   #transition  one click, a blocking update and a transition: two commits
//                in two lanes, two chains
//   #store       an external store change, which 18.0 to 19.1 report with no
//                update row
//   #slow        a handler that computes for 40 ms before it sets state, so
//                the click gets an Event Timing entry
//
// With ?ticker, a clock also re-renders every 10 ms from a timer: work inside
// an interaction's window that the interaction did not cause (interference).

function Cascade() {
  const [clicks, setClicks] = useState(0);
  const [laid, setLaid] = useState(0);
  const [seen, setSeen] = useState(0);
  useLayoutEffect(() => {
    if (laid !== clicks) setLaid(clicks);
  }, [clicks, laid]);
  useEffect(() => {
    if (seen !== laid) setSeen(laid);
  }, [laid, seen]);
  return (
    <button id="cascade" onClick={() => setClicks((c) => c + 1)}>
      cascade {clicks} {laid} {seen}
    </button>
  );
}

function Batch() {
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  return (
    <button
      id="batch"
      onClick={() => {
        setA((v) => v + 1);
        setB((v) => v + 1);
      }}
    >
      batch {a} {b}
    </button>
  );
}

function Transition() {
  const [now, setNow] = useState(0);
  const [later, setLater] = useState(0);
  return (
    <button
      id="transition"
      onClick={() => {
        setNow((v) => v + 1);
        startTransition(() => setLater((v) => v + 1));
      }}
    >
      transition {now} {later}
    </button>
  );
}

const store = {
  value: 0,
  listeners: new Set(),
  subscribe(listener) {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
  get() {
    return store.value;
  },
  set(value) {
    store.value = value;
    for (const listener of store.listeners) listener();
  },
};

function Store() {
  const value = useSyncExternalStore(store.subscribe, store.get);
  return (
    <button id="store" onClick={() => store.set(value + 1)}>
      store {value}
    </button>
  );
}

function spin(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

function Slow() {
  const [done, setDone] = useState(0);
  return (
    <button
      id="slow"
      onClick={() => {
        spin(40);
        setDone((v) => v + 1);
      }}
    >
      slow {done}
    </button>
  );
}

function Ticker() {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTicks((v) => v + 1), 10);
    return () => clearInterval(id);
  }, []);
  spin(2);
  return <p id="ticker">ticks {ticks}</p>;
}

const ticker = new URLSearchParams(location.search).has('ticker');

function Chains() {
  return (
    <main>
      <Cascade />
      <Batch />
      <Transition />
      <Store />
      <Slow />
      {ticker && <Ticker />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Chains />);
