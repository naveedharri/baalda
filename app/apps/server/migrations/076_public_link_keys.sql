-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3) for public links. Additive and non-destructive:
-- the plaintext `token` column is kept and every existing value stays; only
-- its NOT NULL is relaxed so a link minted in a KEYED vault can store the
-- token sealed (`token_enc`, under VK, so members can still copy the URL) and
-- its sha256 (`token_hash`, how `/p/:token` finds the row) instead. Nulling
-- the plaintext of existing links is a later, separate, verified step.
--
-- wrapped_vk: VK wrapped under HKDF(token, "link|<vaultId>") (token-wrap.ts),
-- so a viewer's request opens the note with no member device online.
-- allow_mac: HMAC(VK, link_id || token_hash) from a member's device, for a
-- link that predates the vault's key; upgraded to a wrap on its next view.
-- last_viewed_at / view_tracking_since: the conversion gate counts a link
-- viewed in the last 30 days. Views before this migration are unknown, so
-- existing rows count as recently viewed for 30 days (view_tracking_since).
SET LOCAL lock_timeout = '10s';

ALTER TABLE public_links
  ALTER COLUMN token DROP NOT NULL,
  ADD COLUMN token_hash TEXT,
  ADD COLUMN token_enc BYTEA,
  ADD COLUMN wrapped_vk BYTEA,
  ADD COLUMN wrap_generation INT,
  ADD COLUMN allow_mac BYTEA,
  ADD COLUMN last_viewed_at TIMESTAMPTZ,
  ADD COLUMN view_tracking_since TIMESTAMPTZ DEFAULT now();

-- New rows know their views exactly; only pre-existing rows get the window.
ALTER TABLE public_links ALTER COLUMN view_tracking_since DROP DEFAULT;

UPDATE public_links
   SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token IS NOT NULL AND token_hash IS NULL;

CREATE UNIQUE INDEX public_links_token_hash_idx ON public_links (token_hash);

-- A link must stay findable: a hash, or (legacy) the plaintext token.
ALTER TABLE public_links
  ADD CONSTRAINT public_links_token_present CHECK (token_hash IS NOT NULL OR token IS NOT NULL);
