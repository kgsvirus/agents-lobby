interface Props {
  projects: string[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}

// Projects module sidebar: ALL + the real \projects folder list
// (fetchLocalProjects), selectable — the module's main view is a
// placeholder for now.
export function ProjectsSidebar({ projects, selected, onSelect }: Props) {
  const active = (name: string | null) =>
    selected === name ? 'bg-blue-700/40' : 'hover:bg-gray-200 dark:hover:bg-gray-700';

  return (
    <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-300 bg-gray-100 p-2.5 dark:border-gray-700 dark:bg-[#181818]">
      <div className="mb-2.5 flex items-center justify-between">
        <h1 className="text-sm font-bold text-gray-900 dark:text-white">Projects</h1>
      </div>
      <button
        onClick={() => onSelect(null)}
        aria-current={selected === null || undefined}
        className={`row w-full cursor-pointer rounded-md px-2 py-1.5 text-left ${active(null)}`}
      >
        <b>ALL</b>
      </button>
      {projects.map((name) => (
        <button
          key={name}
          onClick={() => onSelect(name)}
          aria-current={selected === name || undefined}
          className={`row w-full cursor-pointer rounded-md px-2 py-1.5 text-left ${active(name)}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
