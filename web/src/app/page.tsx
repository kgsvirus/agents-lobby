import App from '../App';

// Single-route dashboard: all view/module/theme state is client-side, exactly
// like the legacy Vite app (no URL routing existed there either).
export default function Page() {
  return <App />;
}
