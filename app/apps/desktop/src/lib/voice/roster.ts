// Who is talking right now, and what to call them.
//
// Split out of the session layer because this is the data behind a
// micro-interaction people actually rely on: when audio starts arriving you
// need to know *immediately* that someone is speaking and *who*, or the sound
// is just a disembodied voice in the room. Keeping it pure means that behaviour
// is unit-tested rather than only observable by holding a button.
//
// Purely transient, like everything else in this feature — the roster is the
// only trace a broadcast leaves, and it empties itself as each transmission
// finishes playing.

/** A teammate currently transmitting. */
export interface VoiceSpeaker {
  userId: string;
  name: string;
  color: string;
}

export class VoiceRoster {
  private readonly speaking = new Set<string>();
  /** Display info, cached per user: name/colour ride the opening chunk only,
   *  so it has to outlive that first frame to label the rest of the stream. */
  private readonly known = new Map<string, { name: string; color: string }>();

  constructor(
    /** Fallback colour for a speaker we've never seen labelled. */
    private readonly colorFor: (userId: string) => string = () => "",
  ) {}

  /** Record the display info carried on a chunk (present on the first only). */
  learn(userId: string, name?: string, color?: string): void {
    if (!name && !color) return;
    const prev = this.known.get(userId);
    this.known.set(userId, {
      name: name ?? prev?.name ?? "",
      color: color ?? prev?.color ?? "",
    });
  }

  /** Mark a user as started/stopped talking. Returns true if the set changed,
   *  so callers can skip re-rendering on the ~10 chunks a second that don't. */
  setSpeaking(userId: string, speaking: boolean): boolean {
    const had = this.speaking.has(userId);
    if (speaking === had) return false;
    if (speaking) this.speaking.add(userId);
    else this.speaking.delete(userId);
    return true;
  }

  /** Everyone currently talking, each with the best label we have. */
  list(): VoiceSpeaker[] {
    return [...this.speaking].map((userId) => {
      const known = this.known.get(userId);
      return {
        userId,
        // "Someone" rather than a raw id: an opaque id is worse than an honest
        // placeholder when this is the only thing telling you who you're hearing.
        name: known?.name || "Someone",
        color: known?.color || this.colorFor(userId),
      };
    });
  }

  /** True while anyone is talking — drives the receiving animation. */
  get active(): boolean {
    return this.speaking.size > 0;
  }

  /** Drop everything (vault switch, sign-out, disconnect). */
  clear(): void {
    this.speaking.clear();
    this.known.clear();
  }
}
