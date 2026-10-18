// Light / dark mode. Follows the device setting until the user picks one, then remembers it.
type Theme = 'light' | 'dark';
const KEY = 'tlo-theme';
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

let chosen: Theme | null = stored();

export function currentTheme(): Theme {
  return chosen ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
}

export function toggleTheme() {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  chosen = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not remembered when storage is blocked; still applies for this page.
  }
  document.documentElement.dataset.theme = next;
  listeners.forEach((fn) => fn());
}

export function onThemeChange(fn: () => void) {
  listeners.add(fn);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!chosen) {
      applyTheme();
      fn();
    }
  });
}
