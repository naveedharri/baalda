// Plan & Billing → People on this account: one card per person (picture,
// name, email, last active), never which vaults they are in.

import { useState } from "react";
import type { MyBillingAccount } from "../lib/api";
import { lastActiveLabel } from "../lib/membersAccess";
import { Avatar } from "./Avatar";

type Person = MyBillingAccount["people"][number];

/** "Active 3 days ago", or nothing known yet (an older server, or never seen). */
function activeText(p: Person, now: number): string {
  const label = lastActiveLabel(false, p.lastSeenAt ?? null, now);
  if (label === "—") return p.lastSeenAt === undefined ? "" : "Not active yet";
  return label === "Now" ? "Active now" : `Active ${label.toLowerCase()}`;
}

export function AccountPeopleGrid({ people, seatTag = false }: { people: readonly Person[]; seatTag?: boolean }) {
  const [now] = useState(() => Date.now());
  return (
    <ul className="account-people-grid">
      {people.map((p) => {
        const active = activeText(p, now);
        return (
          <li key={p.userId} className="account-person">
            <Avatar label={p.name || p.email} image={p.image ?? null} userId={p.userId} />
            <span className="account-person-text">
              <span className="account-person-name">{p.name || p.email}</span>
              {p.name && <span className="account-person-email">{p.email}</span>}
              {active && <span className="account-person-active">{active}</span>}
            </span>
            {seatTag && <span className="account-person-seat">1 seat</span>}
          </li>
        );
      })}
    </ul>
  );
}
