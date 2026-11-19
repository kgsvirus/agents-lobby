'use client';

import { Fragment } from 'react';
import { Separator } from './ui/separator';
import { SidebarTrigger } from './ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './ui/breadcrumb';

// The 48px content bar: sidebar trigger + breadcrumb. Modules live in the rail
// and settings moved there too, so nothing else belongs here.
export function ContentBar({ crumbs }: { crumbs: string[] }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, i) => (
            <Fragment key={`${crumb}-${i}`}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {i === crumbs.length - 1 ? (
                  <BreadcrumbPage>{crumb}</BreadcrumbPage>
                ) : (
                  <span className="text-muted-foreground">{crumb}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}
