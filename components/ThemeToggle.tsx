"use client";

/**
 * Light/dark switch. Light is the default; the choice persists in
 * localStorage("xor_theme") and is applied before first paint by the inline
 * script in app/layout.tsx. Which icon is visible is pure CSS driven by
 * [data-theme], so there is nothing to get wrong at hydration time.
 */
export default function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("xor_theme", next);
    } catch {
      // private mode — the toggle still works for this page view
    }
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Switch theme">
      <svg
        className="i-moon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      <svg
        className="i-sun"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
      </svg>
    </button>
  );
}
