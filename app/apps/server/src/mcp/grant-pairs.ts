// SPDX-License-Identifier: Apache-2.0

/**
 * SQL twin of `grantOrg` (oauth-grant-keys.ts): the (client_id, user_id) pairs
 * whose OAuth grants act on the org `org` (a SQL expression). A grant from
 * before consent recorded a binding acts on its user's sole vault, so
 * allow-listing and the conversion gate must see it too, or the vault keys
 * without it and the connector loses access.
 */
export function grantPairsSql(org: string): string {
  return `(SELECT b.client_id, b.user_id FROM mcp_oauth_vault b WHERE b.organization_id = ${org}
           UNION
           SELECT DISTINCT t."clientId", t."userId"
             FROM member mm JOIN "oauthAccessToken" t ON t."userId" = mm."userId"
            WHERE mm."organizationId" = ${org}
              AND NOT EXISTS (SELECT 1 FROM member o WHERE o."userId" = mm."userId" AND o."organizationId" <> ${org})
              AND NOT EXISTS (SELECT 1 FROM mcp_oauth_vault b WHERE b.client_id = t."clientId" AND b.user_id = t."userId"))`;
}
