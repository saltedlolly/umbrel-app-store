import { useState } from "react";

// An image from a profile (avatar or banner), or a dashed box when there's none
function ChangedImage({ src, banner }) {
  const [failed, setFailed] = useState(false);
  const shape = banner ? "w-28 h-10 rounded" : "w-8 h-8 rounded-full";
  if (!src || failed) {
    return (
      <span
        className={`${shape} inline-flex items-center justify-center border border-dashed border-slate-300 dark:border-slate-600 text-[0.6rem] text-slate-400`}
      >
        {src ? "?" : "none"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${shape} object-cover bg-slate-200 dark:bg-slate-700 ring-1 ring-slate-900/5 dark:ring-white/10`}
    />
  );
}

function Arrow() {
  return (
    <span aria-label="changed to" className="text-slate-400">
      &rarr;
    </span>
  );
}

function list(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// What changed in a profile update or relay list update, compared with the
// version before it
export default function ChangeDetail({ kind, changes }) {
  const muted = "text-slate-500 dark:text-slate-400 text-xs";
  if (kind === 10002) {
    const { added, removed } = changes;
    if (!added.length && !removed.length)
      return <p className={`-mt-1 mb-1 ${muted}`}>No change to the relays</p>;
    return (
      <p className={`-mt-1 mb-1 ${muted} break-words`}>
        {added.length ? `Added ${list(added)}. ` : ""}
        {removed.length ? `Removed ${list(removed)}.` : ""}
      </p>
    );
  }
  const { images, texts, others } = changes;
  if (!images.length && !texts.length && !others.length)
    return <p className={`-mt-1 mb-1 ${muted}`}>No visible changes</p>;
  return (
    <div className={`-mt-1 mb-1 space-y-1.5 ${muted}`}>
      {images.map(({ key, label, from, to }) => (
        <div
          key={key}
          className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${
            key === "banner" ? "pt-0.5" : ""
          }`}
        >
          {/* Banners are wide, so their label goes above them */}
          <span className={key === "banner" ? "w-full" : "w-12 flex-none"}>
            {label}
          </span>
          <ChangedImage src={from} banner={key === "banner"} />
          <Arrow />
          <ChangedImage src={to} banner={key === "banner"} />
        </div>
      ))}
      {texts.map(({ label, from, to }) => (
        <div key={label} className="flex gap-2 min-w-0">
          <span className="w-12 flex-none">{label}</span>
          <span className="min-w-0 break-words">
            <span className="line-through decoration-slate-400/70">
              {from || "none"}
            </span>{" "}
            <Arrow />{" "}
            <span className="text-slate-700 dark:text-slate-200">
              {to || "none"}
            </span>
          </span>
        </div>
      ))}
      {others.length ? <p>Updated the {list(others)}</p> : null}
    </div>
  );
}
