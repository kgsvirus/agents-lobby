import { Folder, LayoutGrid } from 'lucide-react';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from './ui/sidebar';

interface Props {
  projects: string[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}

// Projects module navigation: the machine-local folders, rendered in the same
// shadcn Sidebar as chat so both modules share one shell.
export function ProjectsNav({ projects, selected, onSelect }: Props) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={selected === null} tooltip="All projects" onClick={() => onSelect(null)}>
          <LayoutGrid />
          <span>ALL</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {projects.map((name) => (
        <SidebarMenuItem key={name}>
          <SidebarMenuButton isActive={selected === name} tooltip={name} onClick={() => onSelect(name)}>
            <Folder />
            <span>{name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
