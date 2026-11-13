import { Theme } from '../hooks/useTheme';

export function ThemeToggle({
  theme,
  onSelect,
}: {
  theme: Theme;
  onSelect: (t: Theme) => void;
}) {
  const btn = (t: Theme, label: string) => (
    <button
      onClick={() => onSelect(t)}
      className={`rounded-md px-2 py-0.5 text-xs ${
        theme === t
          ? 'bg-blue-600 text-white'
          : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-1">
      {btn('dark', 'Dark')}
      {btn('light', 'Light')}
    </div>
  );
}
