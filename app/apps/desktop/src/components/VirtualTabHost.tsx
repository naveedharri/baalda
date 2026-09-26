/* Mounts the active virtual tab in the editor area and supplies the review tab.
   Inside the editor's own `.editor-column` with the same measure style, so the
   read-only panes resolve the editor's width and inset variables exactly as a
   note does. */
import { useStore } from "../store";
import { editorMeasureStyle } from "../lib/editorMeasure";
import { ErrorBoundary } from "./ErrorBoundary";
import { VirtualTabView } from "./CompareTab";
import { ReviewTab } from "./ReviewTab";
import type { VirtualTab } from "./virtualTabs";

export function VirtualTabHost({ tab }: { tab: VirtualTab }) {
  const measure = useStore((s) => s.editorMeasure);
  return (
    <div className="editor-column" style={editorMeasureStyle(measure)}>
      <ErrorBoundary label="Compare" resetKeys={[tab.id]}>
        <VirtualTabView tab={tab} renderReview={() => <ReviewTab />} />
      </ErrorBoundary>
    </div>
  );
}
