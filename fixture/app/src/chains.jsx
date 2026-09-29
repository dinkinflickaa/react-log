import { memo, startTransition, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
//   #pulse       two Pulses whose layout effects have slow cleanups: on an
//                update each logs two effect spans on 19.2+ (the cleanup in
//                the mutation pass, the effect in the layout pass)
//   #prune       removes the middle of three Leaves while the other two re-run
//                their effects, and re-runs two nested Nests: on 19.2+ the
//                spans must find the deleted Leaf, and the inner Nest before
//                the outer (React logs a fiber after its subtree)
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

// React names a memo component's effect spans after the inner function
// (PulseBody), and the capture after the wrapper's displayName (Pulse).
const Pulse = memo(function PulseBody({ ms, tick }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    spin(ms);
    ref.current.dataset.tick = String(tick);
    return () => spin(0.3);
  }, [ms, tick]);
  return <span ref={ref}>pulse {tick}</span>;
});
Pulse.displayName = 'Pulse';

function Pulses() {
  const [tick, setTick] = useState(0);
  return (
    <section>
      <button id="pulse" onClick={() => setTick((t) => t + 1)}>
        pulse {tick}
      </button>
      <Pulse key="short" ms={1} tick={tick} />
      <Pulse key="long" ms={6} tick={tick} />
    </section>
  );
}

// Each Leaf's cleanups take their own time, so its spans tell them apart.
const LEAF_MS = [1, 12, 5];

function Leaf({ id, count }) {
  useLayoutEffect(() => {
    spin(0.2);
    return () => spin(LEAF_MS[id]);
  }, [id, count]);
  useEffect(() => {
    spin(0.2);
    return () => spin(LEAF_MS[id]);
  }, [id, count]);
  return <li>leaf {id}</li>;
}

// One name, nested: the outer Nest's effect takes 6 ms, the inner's 1 ms.
function Nest({ depth, count }) {
  useLayoutEffect(() => {
    spin(depth === 0 ? 1 : 6);
  }, [depth, count]);
  return depth === 0 ? <span>nest {count}</span> : <Nest depth={depth - 1} count={count} />;
}

function Leaves() {
  const [ids, setIds] = useState([0, 1, 2]);
  return (
    <section>
      <button id="prune" onClick={() => setIds((list) => list.filter((id) => id !== 1))}>
        prune {ids.length}
      </button>
      <ul>
        {ids.map((id) => (
          <Leaf key={id} id={id} count={ids.length} />
        ))}
      </ul>
      <Nest depth={1} count={ids.length} />
    </section>
  );
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
      <Pulses />
      <Leaves />
      {ticker && <Ticker />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Chains />);
