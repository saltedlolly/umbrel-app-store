import { useEffect, useRef } from "react";

// A small centred overlay (help, confirmations). Escape or clicking outside closes it.
export default function Dialog({ title, onClose, children, footer }) {
  const panel = useRef(null);
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-gray-900/5 dark:ring-white/10 outline-none"
      >
        <div className="flex items-center justify-between gap-3 px-6 sm:px-10 pt-6 pb-4 border-b border-slate-200/70 dark:border-white/10">
          <h2 className="text-slate-700 dark:text-slate-50 text-xl font-semibold">
            {title}
          </h2>
          <button
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
        {children}
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 px-6 sm:px-10 pb-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
