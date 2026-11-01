// A small error boundary so one broken piece never takes the window down:
// it shows what failed and offers a retry instead.
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { label: string; children: ReactNode; compact?: boolean; onFailure?: () => void };
type State = { error: Error | null };

export class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[navaigate-skin] ${this.props.label} failed`, error, info.componentStack);
    this.props.onFailure?.();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={this.props.compact ? "my-2 rounded-md border border-border px-3 py-2" : "m-3 rounded-md border border-border px-3 py-2.5"}>
        <div className="text-[12px] font-medium text-foreground">{this.props.label} hit an error</div>
        <div className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{error.message || String(error)}</div>
        <button type="button" onClick={() => this.setState({ error: null })} className="mt-2 rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground">
          Try again
        </button>
      </div>
    );
  }
}
