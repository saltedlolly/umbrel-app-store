import { networkLabel } from "../format.js";
import type { ThemeChoice } from "../theme.js";

const THEMES: { value: ThemeChoice; label: string; icon: JSX.Element }[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3" />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System (follows your device)",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" />
        <path d="M5.5 14h5M8 11v3" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3z" />
      </svg>
    ),
  },
];

interface Props {
  network: string | null;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}

export function Header({ network, theme, onTheme }: Props) {
  return (
    <header className="top">
      <a className="brand" href="https://nito.network/" target="_blank" rel="noopener noreferrer" title="nito.network">
        <img className="brand-mark" src="/nito-mark.svg" alt="" width="40" height="40" />
        <span className="brand-words">
          <img className="wordmark wordmark-dark" src="/nito-wordmark-white.png" alt="Nito" width="92" height="24" />
          <img className="wordmark wordmark-light" src="/nito-wordmark-black.png" alt="Nito" width="92" height="24" />
        </span>
      </a>
      {network && (
        <span className={`chain-badge chain-${network}`} title="The Nito network this node is on">
          <span className="chain-dot" />
          {networkLabel(network)}
        </span>
      )}
      <div className="theme-picker" role="group" aria-label="Colour theme">
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={theme === option.value ? "active" : ""}
            title={option.label}
            aria-label={`${option.label} theme`}
            aria-pressed={theme === option.value}
            onClick={() => onTheme(option.value)}
          >
            {option.icon}
          </button>
        ))}
      </div>
    </header>
  );
}
