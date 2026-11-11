import { useState } from "react";
import { colorFor } from "../nostr";
import nostrich from "../assets/nostrich.png";

// The Nostrich (Nostr's running ostrich), used when an account has no picture
// or it won't load. It's white on a see-through background, so the account's
// colour shows around it and the same account looks the same everywhere on
// the dashboard. Icon by SovrynMatt, with the version for small sizes by
// designsats, shared free to use:
// https://github.com/SovrynMatt/Nostr-Website-Button-Design
function Face({ color }) {
  return (
    <span className="block w-full h-full" style={{ backgroundColor: color }}>
      <img
        src={nostrich}
        alt=""
        draggable="false"
        className="w-full h-full object-cover"
      />
    </span>
  );
}

// An account's profile picture, or its placeholder ostrich. "Others" (accounts
// that aren't synced) gets a plain grey circle.
export default function Avatar({
  pubkey,
  picture,
  label = "",
  other = false,
  size = "w-9 h-9",
  title,
}) {
  const [failedPicture, setFailedPicture] = useState(null);
  const common = `${size} flex-none rounded-full`;
  if (other) {
    return (
      <span
        title={title}
        className={`${common} inline-flex items-center justify-center text-sm font-semibold bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300`}
      >
        <span aria-hidden="true">...</span>
        {title ? <span className="sr-only">{title}</span> : null}
      </span>
    );
  }
  if (picture && failedPicture !== picture) {
    return (
      <img
        src={picture}
        alt={title || label}
        title={title}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailedPicture(picture)}
        className={`${common} object-cover bg-slate-200 dark:bg-slate-700 ring-1 ring-slate-900/5 dark:ring-white/10`}
      />
    );
  }
  return (
    <span
      title={title}
      role="img"
      aria-label={title || label}
      className={`${common} inline-block overflow-hidden`}
    >
      <Face color={colorFor(pubkey || label)} />
    </span>
  );
}
