/* Mounts the active virtual tab in the editor area and supplies the review tab. */
import { ErrorBoundary } from "./ErrorBoundary";
import { VirtualTabView } from "./CompareTab";
import { ReviewTab } from "./ReviewTab";
import type { VirtualTab } from "./virtualTabs";

export function VirtualTabHost({ tab }: { tab: VirtualTab }) {
  return (
    <ErrorBoundary label="Compare" resetKeys={[tab.id]}>
      <VirtualTabView tab={tab} renderReview={() => <ReviewTab />} />
    </ErrorBoundary>
  );
}
