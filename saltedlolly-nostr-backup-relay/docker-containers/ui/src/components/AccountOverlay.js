import { useEffect, useRef, useState } from "react";
import AccountHeading from "./AccountHeading";
import LatestActions from "./LatestActions";

const PAGE = 300;

// Nearly full-screen list of every loaded action for one account
export default function AccountOverlay({
  column,
  supportedEventKinds,
  nameFor,
  previousOf,
  fetchLimit,
  onClose,
}) {
  const [limit, setLimit] = useState(PAGE);
  const closeButton = useRef(null);

  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const shown = column.events.filter(
    ({ kind }) => !!supportedEventKinds[kind],
  ).length;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={column.other ? "Other accounts" : column.label}
        onClick={(event) => event.stopPropagation()}
        className="absolute inset-2 sm:inset-6 lg:inset-x-[10%] lg:inset-y-8 flex flex-col rounded-xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-gray-900/5 dark:ring-white/10"
      >
        <div className="flex items-start gap-3 px-6 sm:px-10 pt-6 pb-4 border-b border-slate-200/70 dark:border-white/10">
          <h2 className="flex-1 min-w-0 text-slate-700 dark:text-slate-50 text-xl font-semibold">
            <AccountHeading column={column} />
          </h2>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-none rounded-md p-2 text-slate-600 dark:text-slate-300 ring-1 ring-slate-900/10 dark:ring-white/10 hover:bg-[#CEC8F4] dark:hover:bg-[#264D96]"
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto pb-6 !scrollbar-thin !scrollbar-w-1 !scrollbar-thumb-rounded-full !scrollbar-track-transparent !scrollbar-thumb-black/10 dark:!scrollbar-thumb-white/10">
          <div className="max-w-3xl mx-auto">
            <LatestActions
              loading={false}
              events={column.events}
              eventsToRenderLimit={limit}
              supportedEventKinds={supportedEventKinds}
              nameFor={nameFor}
              previousOf={previousOf}
              fullHeight
              emptyMessage="Nothing has been backed up for this account yet."
            />
            {shown > limit ? (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setLimit((previous) => previous + PAGE)}
                  className="rounded-md px-4 py-2 text-sm text-slate-700 dark:text-slate-200 ring-1 ring-slate-900/10 dark:ring-white/10 hover:bg-[#CEC8F4] dark:hover:bg-[#264D96]"
                >
                  Show older actions
                </button>
              </div>
            ) : column.events.length >= fetchLimit ? (
              <p className="px-10 pt-2 text-center text-xs text-slate-500 dark:text-slate-400">
                Showing the newest {fetchLimit.toLocaleString()} actions. Older
                ones are still backed up on your relay.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
