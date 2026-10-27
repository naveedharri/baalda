// The "Source" row on an imported skill's page: where it came from and, for
// admins, whether the upstream folder moved on, with Pull update. Checking
// costs two GitHub calls (commit + tree), so it runs once when the page opens
// and again only on Check again.

import { useCallback, useEffect, useState } from "react";
import { skillErrorCode } from "../../lib/api";
import { authManager } from "../../lib/auth/authManager";
import * as ipc from "../../lib/ipc";
import { fetchSkillFolder, loadOriginSkill, originOf, type MarketplaceSkill } from "../../lib/skills/marketplace";
import type { SkillOrigin } from "../../lib/skills/types";
import { skillDisplayName } from "../../lib/skills/display";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { Spinner } from "../Spinner";
import { readerFor } from "./MarketplaceBrowser";
import { BusyButton, GitHubGlyph, Tag } from "./parts";

type Check =
  | { status: "checking" }
  | { status: "current" }
  | { status: "update"; upstream: MarketplaceSkill }
  | { status: "gone" }
  | { status: "error"; message: string };

export function SkillSourceRow({
  orgId,
  skillId,
  skillName,
  source,
  canManage,
  onPulled,
}: {
  orgId: string;
  skillId: string;
  skillName: string;
  source: SkillOrigin;
  canManage: boolean;
  /** The draft now holds the upstream files. */
  onPulled: () => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [check, setCheck] = useState<Check | null>(null);

  const run = useCallback(async () => {
    setCheck({ status: "checking" });
    try {
      const upstream = await loadOriginSkill(await readerFor(serverUrl, orgId), source);
      if (!upstream) setCheck({ status: "gone" });
      else if (upstream.treeSha === source.treeSha) setCheck({ status: "current" });
      else setCheck({ status: "update", upstream });
    } catch (e) {
      setCheck({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [serverUrl, orgId, source]);

  // Re-check only when the recorded origin changes, not on every page reload
  // (each check spends two of GitHub's anonymous 60 requests an hour).
  const originKey = `${source.repo}|${source.ref}|${source.path}|${source.treeSha}`;
  useEffect(() => {
    if (canManage) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, originKey]);

  const pull = async (upstream: MarketplaceSkill) => {
    try {
      const files = await fetchSkillFolder(await readerFor(serverUrl, orgId), upstream);
      const detail = await authManager.api.getSkill(orgId, skillId);
      await authManager.api.putSkillDraft(orgId, skillId, detail.draftRevision, files, originOf(upstream));
      toast(`Pulled ${skillDisplayName(skillName)} into its draft. Review, then publish.`);
      setCheck({ status: "current" });
      onPulled();
    } catch (e) {
      toast(
        skillErrorCode(e) === "stale_draft"
          ? `Someone changed the draft of ${skillName}. Try again.`
          : `Couldn't pull ${skillName}: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  };

  const where = `${source.repo}${source.ref ? `@${source.ref}` : ""}`;
  const url = `https://github.com/${source.repo}/tree/${source.ref ?? source.commitSha}/${source.path}`;

  return (
    <div className="skills-source-strip">
      <span className="skills-source-where">
        <GitHubGlyph />
        <button className="link-btn skills-source-link" onClick={() => void ipc.openExternal(url)} title={url}>
          {where}
        </button>
        <span className="skills-mono"> · {source.path || "/"} · {source.commitSha.slice(0, 7)}</span>
      </span>
      {canManage && (
        <span className="skills-row-side">
          {check?.status === "checking" ? (
            <span className="field-hint skills-inline">
              <Spinner size="xs" /> Checking for updates…
            </span>
          ) : check?.status === "current" ? (
            <span className="field-hint">Up to date</span>
          ) : check?.status === "update" ? (
            <>
              <Tag tone="warn">Update available</Tag>
              <BusyButton className="primary skills-btn-sm" busyLabel="Pulling…" onClick={() => pull(check.upstream)}>Pull update</BusyButton>
            </>
          ) : check?.status === "gone" ? (
            <Tag tone="warn" title="The folder is no longer in the repository">Gone upstream</Tag>
          ) : check?.status === "error" ? (
            <>
              <span className="field-hint skills-hint-bad" title={check.message}>Couldn't check</span>
              <button className="link-btn skills-source-link" onClick={() => void run()}>Retry</button>
            </>
          ) : null}
        </span>
      )}
    </div>
  );
}
