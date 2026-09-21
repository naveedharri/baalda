// SPDX-License-Identifier: Apache-2.0
/** Deployment policy is independent of whether a payment provider is configured.
 * Default to Cloud restrictions so an omitted setting cannot expose paid features
 * on an existing managed deployment. Self-hosting templates explicitly opt in. */
export function requiresCloudPlan(): boolean {
  const deployment = process.env.BAALDA_DEPLOYMENT ?? "cloud";
  if (deployment !== "cloud" && deployment !== "self-hosted") {
    throw new Error("BAALDA_DEPLOYMENT must be cloud or self-hosted");
  }
  return deployment === "cloud";
}
