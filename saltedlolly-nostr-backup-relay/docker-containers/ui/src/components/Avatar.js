import { useState } from "react";

// An account's profile picture, or a coloured circle with its first letter.
// "Other" (events from accounts that aren't synced) gets a plain circle.
export default function Avatar({ picture, label = "", other = false, size }) {
  const [failed, setFailed] = useState(false);
  const sizeClass = size || "w-9 h-9";
  if (picture && !failed) {
    return (
      <img
        src={picture}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${sizeClass} flex-none rounded-full object-cover bg-slate-200 dark:bg-slate-700 ring-1 ring-slate-900/5 dark:ring-white/10`}
      />
    );
  }
  const letter = label
    .replace(/^[@_]+/, "")
    .charAt(0)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`${sizeClass} flex-none inline-flex items-center justify-center rounded-full text-sm font-semibold ${
        other
          ? "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
          : "bg-gradient-to-br from-pink-500 to-violet-500 text-white"
      }`}
    >
      {other ? "..." : letter || "?"}
    </span>
  );
}
