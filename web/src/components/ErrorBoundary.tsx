import { Component, type ReactNode } from 'react';

/** A render crash must never put a stack trace in front of a user. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('render failure', err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="state state--error" role="alert" style={{ padding: 48 }}>
        <b>This screen hit a problem and could not be shown.</b>
        <span>Your data is safe. Reload the page; if it happens again, tell an administrator what you were doing.</span>
        <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
