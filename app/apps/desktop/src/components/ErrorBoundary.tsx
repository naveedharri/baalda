import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches render/runtime errors from its subtree so one broken view (e.g. the
 * graph canvas) shows a recoverable fallback instead of unmounting the whole app
 * to a blank screen. `resetKeys` lets a parent clear the error when the relevant
 * inputs change (e.g. closing and reopening the panel).
 */
interface Props {
  children: ReactNode;
  /** What broke, for the fallback copy (e.g. "Graph view"). */
  label?: string;
  /** Optional custom fallback; receives the error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** When any value here changes, the boundary clears its error state. */
  resetKeys?: ReadonlyArray<unknown>;
  /** Called after an error is caught (e.g. to close the offending panel). */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    // Clear the error when the parent bumps resetKeys (shallow compare).
    if (
      this.state.error &&
      prev.resetKeys &&
      this.props.resetKeys &&
      (prev.resetKeys.length !== this.props.resetKeys.length ||
        prev.resetKeys.some((k, i) => k !== this.props.resetKeys![i]))
    ) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error, info);
    this.props.onError?.(error);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <strong>{this.props.label ?? "Something"} hit an error</strong>
          <p className="muted">{error.message}</p>
          <button className="primary sm" onClick={this.reset}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
