/* Eager-safe avatar wrappers. `./Avatar` carries DiceBear (~300 KB), so the
   first-screen call sites — sidebar presence faces, the identity bar, the
   version list — render an initials monogram and swap the illustrated face in
   when the chunk lands (usually within a frame, since `lib/prefetch.ts` warms
   it right after the first paint). Only `import type` may cross into
   `./Avatar` from here, so nothing pulls it into the startup graph. */
import { lazy, Suspense } from "react";
import type { FaceProps } from "./Avatar";

const FaceSvg = lazy(() => import("./Avatar").then((m) => ({ default: m.FaceSvg })));
const AvatarImpl = lazy(() => import("./Avatar").then((m) => ({ default: m.Avatar })));

function initial(seed: string): string {
  return (seed.trim()[0] ?? "?").toUpperCase();
}

/** Same span the caller used to render, with the face swapped in when the chunk lands. */
export function Face({ seed, className, style, title, ariaHidden }: FaceProps) {
  return (
    <Suspense
      fallback={
        <span
          className={`${className ?? ""} face-loading`}
          style={style}
          title={title}
          aria-hidden={ariaHidden || undefined}
        >
          {initial(seed)}
        </span>
      }
    >
      <FaceSvg
        seed={seed}
        className={className}
        style={style}
        title={title}
        ariaHidden={ariaHidden}
      />
    </Suspense>
  );
}

/** Photo-or-face avatar for eager call sites (the sidebar identity bar). */
export function LazyAvatar({ label, image }: { label: string; image?: string | null }) {
  return (
    <Suspense fallback={<span className="avatar face-loading">{initial(label)}</span>}>
      <AvatarImpl label={label} image={image} />
    </Suspense>
  );
}
