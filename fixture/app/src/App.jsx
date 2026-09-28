import {
  Component,
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  version,
} from 'react';

// Ten composite components, one instance each. Between them they cover
// props, function state, class state, context, memo, both effect kinds and
// an external store, the inputs the shim's reason codes distinguish.

const ThemeContext = createContext('light');
ThemeContext.displayName = 'ThemeContext';

function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const store = createStore(0);

export function App() {
  const [count, setCount] = useState(0);
  const [theme, setTheme] = useState('light');
  return (
    <ThemeContext.Provider value={theme}>
      <Layout
        count={count}
        onIncrement={() => setCount((c) => c + 1)}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      />
    </ThemeContext.Provider>
  );
}

function Layout({ count, onIncrement, onToggleTheme }) {
  return (
    <div className="layout">
      <Header onToggleTheme={onToggleTheme} />
      <Main count={count} onIncrement={onIncrement} />
      <Footer />
    </div>
  );
}

function Header({ onToggleTheme }) {
  const theme = useContext(ThemeContext);
  return (
    <header data-theme={theme}>
      <button id="theme" onClick={onToggleTheme}>
        theme: {theme}
      </button>
    </header>
  );
}

function Main({ count, onIncrement }) {
  return (
    <main>
      <Counter count={count} onIncrement={onIncrement} />
      <Details label="details" />
      <Clock />
      <EffectPanel count={count} />
      <StoreView />
    </main>
  );
}

function Counter({ count, onIncrement }) {
  return (
    <button id="inc" onClick={onIncrement}>
      count: {count}
    </button>
  );
}

const Details = memo(function Details({ label }) {
  return <p className="details">{label}</p>;
});

class Clock extends Component {
  state = { ticks: 0 };

  render() {
    return (
      <button id="tick" onClick={() => this.setState((s) => ({ ticks: s.ticks + 1 }))}>
        ticks: {this.state.ticks}
      </button>
    );
  }
}

// Busy-waits so effect times clear React 19.2's 0.05 ms logging threshold
// and the 100 µs timer step.
function spin(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

function EffectPanel({ count }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    spin(0.3);
    ref.current.dataset.layout = String(count);
  }, [count]);
  useEffect(() => {
    spin(0.3);
    ref.current.dataset.passive = String(count);
  }, [count]);
  return (
    <section ref={ref} className="effects">
      effects for {count}
    </section>
  );
}

function StoreView() {
  const value = useSyncExternalStore(store.subscribe, store.get);
  return (
    <button id="store" onClick={() => store.set(value + 1)}>
      store: {value}
    </button>
  );
}

function Footer() {
  const text = useMemo(() => `React ${version}`, []);
  return <footer id="version">{text}</footer>;
}
