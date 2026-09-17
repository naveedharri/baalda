// The last net under the viewer leaves.
//
// Every leaf already catches its own failures (a bad decode, a refused read, a
// parser that threw) and renders `FileCard` with a reason. This exists for the
// ones nothing can catch: a render-time throw inside a leaf, or a `React.lazy`
// chunk that fails to load at all — both of which would otherwise take the
// whole app's tree down, because an uncaught render error unmounts everything
// above it too. React has no hook form of this, so it is a class.
//
// It is mounted with `key={path}`: a boundary that has caught stays caught, and
// keying it by path means opening another file gets a fresh, un-failed one.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** What to show instead — the caller passes a `FileCard` with a reason. */
  fallback: (error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ViewerErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Worth a console line: the card the user sees says "couldn't open this",
    // which is the right message for them and useless for a bug report.
    console.error("viewer failed", error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
