import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CheckMark, Spinner } from "./Spinner";
import { useAsyncAction } from "../lib/useAsyncAction";

type Native = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">;

export interface AsyncButtonProps extends Native {
  /** The action. Its promise is what the button reports on. */
  onClick: () => Promise<unknown> | unknown;
  children: ReactNode;
  /** Show a success tick for a beat when it resolves. Off by default. */
  confirm?: boolean;
  /** Spinner colour: default reads the button's own fill. */
  spinnerTone?: "neutral" | "accent" | "on-accent";
  /**
   * Replace the label with the spinner instead of sitting beside it. Use in
   * cramped rows; the default (label + spinner) is calmer because the button
   * doesn't appear to change identity mid-action.
   */
  replaceLabel?: boolean;
  /** Extra disabling on top of "is it running". */
  disabled?: boolean;
}

/**
 * A button that reports on its own async work: pressed → disabled immediately,
 * spinner once the wait outlives `SPINNER_DELAY`, optional tick when it lands.
 *
 * This exists because the alternative — a `useState` busy flag per call site —
 * was already applied inconsistently across the app: some buttons swapped their
 * label ("Opening…"), some disabled silently, and most did nothing at all, so
 * pressing them looked identical to pressing a dead control. One component
 * makes the behaviour uniform and makes *forgetting* it the exception.
 *
 * The label keeps its own width while a spinner is beside it, so the button
 * never resizes mid-action — a control that changes shape under the cursor is
 * how you get a mis-click on whatever moves into its place.
 */
export const AsyncButton = forwardRef<HTMLButtonElement, AsyncButtonProps>(
  function AsyncButton(
    {
      onClick,
      children,
      confirm = false,
      spinnerTone,
      replaceLabel = false,
      disabled,
      className,
      ...rest
    },
    ref,
  ) {
    // `swallow` because a button is a leaf: there is nobody above it to catch a
    // rejection, and an uncaught one in an event handler is just a console
    // error. Callers that need the error render it from their own state.
    const action = useAsyncAction(onClick, { confirm, swallow: true });
    const tone =
      spinnerTone ?? (className?.includes("primary") ? "on-accent" : "inherit");
    const busy = action.showPending;

    return (
      <button
        {...rest}
        ref={ref}
        className={`${className ?? ""}${busy ? " is-busy" : ""}${
          action.done ? " is-done" : ""
        }`.trim()}
        // `pending`, not `showPending`: the guard has to bite on the first click,
        // not 140ms later.
        disabled={disabled || action.pending}
        aria-busy={action.pending || undefined}
        onClick={() => void action.run()}
      >
        {!(replaceLabel && (busy || action.done)) && (
          <span className="async-btn-label">{children}</span>
        )}
        {busy && <Spinner size="xs" tone={tone} />}
        {action.done && <CheckMark size="xs" />}
      </button>
    );
  },
);
