import { useEffect, useState } from "react";
import icon from "../assets/icon.svg";

const THEMES = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3" />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System (follows your device)",
    icon: (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" />
        <path d="M5.5 14h5M8 11v3" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3z" />
      </svg>
    ),
  },
];

function savedTheme() {
  try {
    const theme = localStorage.getItem("theme");
    return ["light", "dark", "system"].includes(theme) ? theme : "system";
  } catch {
    return "system";
  }
}

// Colour theme: light / system / dark, remembered in this browser. The saved
// theme is also applied by a small script in index.html before the page is
// drawn, so it doesn't flash white first.
function ThemePicker() {
  const [theme, setTheme] = useState(savedTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // the choice just isn't remembered
    }
    // "System" follows the device when it changes
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="inline-flex rounded-md ring-1 ring-slate-300 dark:ring-white/20 overflow-hidden"
    >
      {THEMES.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.label}
          aria-label={`${option.label} theme`}
          aria-pressed={theme === option.value}
          onClick={(event) => {
            event.stopPropagation(); // keep the sync panel open
            setTheme(option.value);
          }}
          className={`px-2.5 py-1.5 ${
            theme === option.value
              ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900"
              : "bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

export default function Header({ isConnected, children }) {
  return (
    <div>
      <div className="flex justify-end pt-6">
        <ThemePicker />
      </div>
      <div className="flex flex-col md:flex-row justify-between align-center mb-10 md:mb-14">
        <div className="flex mb-8 md:mb-0">
          <div className="flex items-center mr-6 w-32 h-32 rounded-2xl sm:rounded-3xl">
            <img
              className="object-cover rounded-2xl shadow-xl sm:rounded-3xl ring-1 ring-gray-900/5 dark:ring-white/10"
              src={icon}
              alt="Nostr Backup Relay icon"
            />
          </div>
          <div>
            <div className="flex items-center">
              <div className="relative">
                {isConnected ? (
                  <span className="flex h-3 w-3">
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                  </span>
                ) : (
                  <span className="flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500" />
                  </span>
                )}
              </div>
              {isConnected ? (
                <p className="ml-2 text-green-500 text-md">Running</p>
              ) : (
                <p className="ml-2 text-sky-400 text-md">
                  Connecting to relay...
                </p>
              )}
            </div>
            <h1 className="text-3xl sm:text-4xl font-medium text-slate-900 dark:text-white opacity-90">
              Nostr Backup Relay
            </h1>
            <div className="mt-2">
              <span className="text-black/50 dark:text-white/50 font-medium">
                Private Relay
              </span>
            </div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
