import { createEffect, createSignal, onCleanup } from 'solid-js';
import { readSetting, saveSetting } from './tree';

export type ColorTheme = 'light' | 'dark';
export type ThemePreference = 'system' | ColorTheme;

export const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function createTheme() {
  const stored = readSetting('theme');
  const [preference, setPreference] = createSignal<ThemePreference>(
    stored === 'light' || stored === 'dark' ? stored : 'system',
  );
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const [systemDark, setSystemDark] = createSignal(system.matches);
  const changed = () => setSystemDark(system.matches);
  system.addEventListener('change', changed);
  onCleanup(() => system.removeEventListener('change', changed));
  const resolved = (): ColorTheme => {
    const value = preference();
    return value === 'system' ? (systemDark() ? 'dark' : 'light') : value;
  };
  createEffect(() => saveSetting('theme', preference()));
  createEffect(() => {
    const value = resolved();
    document.documentElement.dataset.theme = value;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', value === 'dark' ? '#232329' : '#f7f7f5');
  });
  return { preference, setPreference, resolved };
}
