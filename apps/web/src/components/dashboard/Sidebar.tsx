'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  Workflow,
  Activity,
  FileText,
  Cpu,
  Settings,
  HelpCircle,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { RobotAvatar } from './RobotAvatar';

interface SidebarProps {
  isRunnerOnline?: boolean;
}

export function Sidebar({ isRunnerOnline = false }: SidebarProps) {
  const pathname = usePathname();
  // Keep the rail compact by default; preserve an explicit user preference.
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('wf_saas_sidebar_collapsed');
      if (saved === '0') setIsCollapsed(false);
      else setIsCollapsed(true);
    } catch {
      setIsCollapsed(true);
    }
    setMounted(true);
  }, []);

  const toggleCollapse = () => {
    const nextState = !isCollapsed;
    setIsCollapsed(nextState);
    try {
      localStorage.setItem('wf_saas_sidebar_collapsed', nextState ? '1' : '0');
    } catch {}
  };

  const navItems = [
    { label: 'Home', href: '/dashboard', icon: LayoutGrid, exact: true, tour: 'nav-home' },
    { label: 'Workflows', href: '/dashboard/workflows', icon: Workflow, exact: false, tour: 'nav-workflows' },
    { label: 'Run history', href: '/dashboard/runs', icon: Activity, exact: false, tour: 'nav-runs' },
    { label: 'Files & results', href: '/dashboard/artifacts', icon: FileText, exact: false, tour: 'nav-artifacts' },
    { label: 'Desktop connection', href: '/dashboard/runners', icon: Cpu, exact: false, tour: 'nav-runners' },
    { label: 'Getting started', href: '/dashboard/getting-started', icon: HelpCircle, exact: false, tour: 'nav-getting-started' },
    { label: 'Settings', href: '/dashboard/settings', icon: Settings, exact: false, tour: 'nav-settings' }
  ];

  const isActive = (itemHref: string, exact: boolean) => {
    if (!pathname) return false;
    return exact ? pathname === itemHref : pathname.startsWith(itemHref);
  };

  return (
    <aside
      data-tour="sidebar"
      className={`sticky top-0 z-30 flex h-screen flex-shrink-0 select-none flex-col justify-between border-r border-[var(--border-color,rgba(255,255,255,0.07))] bg-[var(--sidebar-bg,#0c101d)] py-4 transition-[width,padding] duration-200 ease-out ${
        isCollapsed ? 'w-14 px-2' : 'w-[230px] px-3.5'
      }`}
      aria-label="Sidebar navigation"
    >
      <div className="flex flex-col gap-5">
        <Link
          href="/dashboard"
          className={`group flex min-h-10 items-center rounded-lg p-1.5 transition-colors hover:bg-white/5 ${
            isCollapsed ? 'justify-center' : 'gap-3'
          }`}
          title="ReFlow"
          aria-label="ReFlow overview"
        >
          <RobotAvatar size={isCollapsed ? 'mini' : 'badge'} state={isRunnerOnline ? 'running' : 'idle'} />
          {!isCollapsed && (
            <span className="truncate text-sm font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">
              ReFlow
            </span>
          )}
        </Link>

        <nav className="flex flex-col gap-1" aria-label="Main navigation">
          {navItems.map((item) => {
            const active = mounted && isActive(item.href, item.exact);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                data-tour={item.tour}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                title={isCollapsed ? item.label : undefined}
                className={`group relative flex h-10 items-center rounded-lg border text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)] ${
                  isCollapsed ? 'justify-center px-0' : 'gap-3 px-3'
                } ${
                  active
                    ? 'border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-hover,#11182c)] text-[var(--foreground,#f8fafc)]'
                    : 'border-transparent text-slate-400 hover:bg-white/5 hover:text-[var(--foreground,#f8fafc)]'
                }`}
              >
                {active && (
                  <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-[var(--primary-color,#00f0ff)]" />
                )}
                <Icon
                  aria-hidden="true"
                  className={`h-4 w-4 flex-shrink-0 ${
                    active ? 'text-[var(--primary-color,#00f0ff)]' : 'text-slate-400 group-hover:text-slate-200'
                  }`}
                />
                {!isCollapsed && <span className="truncate">{item.label}</span>}
                {isCollapsed && (
                  <span
                    role="tooltip"
                    aria-hidden="true"
                    className="pointer-events-none absolute left-full z-50 ml-2 whitespace-nowrap rounded-md border border-[var(--border-color,rgba(255,255,255,0.1))] bg-[var(--surface-bg,#0c101d)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--foreground,#f8fafc)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  >
                    {item.label}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-[var(--border-color,rgba(255,255,255,0.07))] pt-3">
        {!isCollapsed && (
          <div className="mb-3 rounded-xl border border-cyan-500/20 bg-[#171f33]/70 p-3 shadow-[0_0_12px_rgba(6,182,212,0.1)] backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#2d3449] text-cyan-400">
                <RobotAvatar size="mini" />
              </div>
              <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                New
              </span>
            </div>
            <div className="mt-2 text-xs font-semibold text-white">Automate Smarter</div>
            <p className="mt-0.5 text-[11px] text-slate-400 leading-snug">
              Scale agents and task logic with zero latency.
            </p>
            <Link
              href="/dashboard/getting-started"
              className="mt-2.5 inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 py-1 text-[11px] font-semibold text-white shadow-md hover:opacity-90 transition-opacity"
            >
              Get Started
            </Link>
          </div>
        )}
        <button
          type="button"
          onClick={toggleCollapse}
          className={`flex h-9 w-full items-center rounded-lg text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-[var(--foreground,#f8fafc)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)] ${
            isCollapsed ? 'justify-center px-0' : 'gap-3 px-3'
          }`}
          title={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
