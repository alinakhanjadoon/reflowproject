'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Download,
  KeyRound,
  Play,
  Rocket,
  X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';

const DOWNLOAD_CLICKED_KEY = 'wf_setup_download_clicked';
const DISMISSED_KEY = 'wf_setup_checklist_dismissed';

const WINDOWS_DOWNLOAD_HREF = '/api/v1/runners/download?type=installer&os=windows';
const MAC_DOWNLOAD_HREF = '/api/v1/runners/download?type=dmg&os=mac';

interface SetupChecklistProps {
  workflowCount: number;
  completedRunCount: number;
  isLoading?: boolean;
}

interface SetupStep {
  id: 'download' | 'connect' | 'record' | 'run';
  title: string;
  description: string;
  done: boolean;
  icon: LucideIcon;
  action: { label: string; href: string } | { label: string; download: true };
}

export function SetupChecklist({
  workflowCount,
  completedRunCount,
  isLoading = false
}: SetupChecklistProps) {
  const { orgId, isRunnerOnline } = useDashboard();
  const [mounted, setMounted] = useState(false);
  const [downloadClicked, setDownloadClicked] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Namespace the local flags per workspace so a second workspace still gets guidance.
  const suffix = orgId ? `_${orgId}` : '';

  useEffect(() => {
    try {
      setDownloadClicked(localStorage.getItem(DOWNLOAD_CLICKED_KEY + suffix) === '1');
      setDismissed(localStorage.getItem(DISMISSED_KEY + suffix) === '1');
    } catch {
      // Storage can be unavailable (private mode); fall back to showing the checklist.
    }
    setMounted(true);
  }, [suffix]);

  const handleDownload = useCallback(() => {
    setDownloadClicked(true);
    try {
      localStorage.setItem(DOWNLOAD_CLICKED_KEY + suffix, '1');
    } catch {}
  }, [suffix]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY + suffix, '1');
    } catch {}
  }, [suffix]);

  const steps: SetupStep[] = useMemo(
    () => [
      {
        id: 'download',
        title: 'Get the desktop worker',
        description: 'Install ReFlow Desktop on the PC that should run your tasks.',
        // A connected worker proves the install worked, so it also satisfies this step.
        done: downloadClicked || isRunnerOnline,
        icon: Download,
        action: { label: 'Download for Windows', download: true }
      },
      {
        id: 'connect',
        title: 'Connect it to this workspace',
        description: 'Open ReFlow Desktop and paste your pairing token so we can reach it.',
        done: isRunnerOnline,
        icon: KeyRound,
        action: { label: 'Get pairing token', href: '/dashboard/runners' }
      },
      {
        id: 'record',
        title: 'Record your first workflow',
        description: 'Do the task once in Chrome while ReFlow watches, then save it.',
        done: workflowCount > 0,
        icon: Rocket,
        action: { label: 'Go to workflows', href: '/dashboard/workflows' }
      },
      {
        id: 'run',
        title: 'Run it and collect your files',
        description: 'Run the workflow, then download what it collected from Files & results.',
        done: completedRunCount > 0,
        icon: Play,
        action: { label: 'Open Files & results', href: '/dashboard/artifacts' }
      }
    ],
    [downloadClicked, isRunnerOnline, workflowCount, completedRunCount]
  );

  const doneCount = steps.filter((step) => step.done).length;
  const total = steps.length;
  const allDone = doneCount === total;

  // Hide on its own once every step is genuinely complete. While the dashboard is
  // still loading the counts read as zero, so an established workspace would flash
  // an irrelevant checklist — stay hidden until real numbers exist.
  if (!mounted || isLoading || dismissed || allDone) return null;

  return (
    <section
      aria-labelledby="setup-checklist-heading"
      data-tour="checklist"
      className="rounded-2xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2
            id="setup-checklist-heading"
            className="text-base font-semibold tracking-tight text-[var(--foreground,#f8fafc)]"
          >
            Set up ReFlow in 4 steps
          </h2>
          <p className="text-xs text-slate-400 sm:text-sm">
            Install the worker, connect it, record a task, and collect your first files.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="-mr-1 -mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
          aria-label="Hide the setup checklist"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Your progress</span>
          <span className="font-medium text-[var(--foreground,#f8fafc)]">
            {doneCount} of {total} done
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={doneCount}
          aria-label={`Setup progress: ${doneCount} of ${total} steps complete`}
          className="h-1.5 overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-[var(--primary-color,#00f0ff)] transition-all duration-300"
            style={{ width: `${Math.round((doneCount / total) * 100)}%` }}
          />
        </div>
      </div>

      <ol className="mt-5 space-y-2.5">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const StatusIcon = step.done ? CheckCircle2 : Circle;

          return (
            <li
              key={step.id}
              className={`flex flex-col gap-3 rounded-xl border p-3.5 sm:flex-row sm:items-center sm:gap-4 ${
                step.done
                  ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                  : 'border-[var(--border-color,rgba(255,255,255,0.08))]'
              }`}
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
                    step.done ? 'bg-emerald-500/10' : 'bg-[var(--surface-hover,#11182c)]'
                  }`}
                >
                  <Icon
                    aria-hidden="true"
                    className={`h-4 w-4 ${
                      step.done ? 'text-emerald-400' : 'text-[var(--primary-color,#00f0ff)]'
                    }`}
                  />
                </span>
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--foreground,#f8fafc)]">
                    <span className="text-slate-500">{index + 1}.</span>
                    <span>{step.title}</span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-normal text-slate-500">
                      <StatusIcon
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 ${step.done ? 'text-emerald-400' : 'text-slate-600'}`}
                      />
                      {step.done ? 'Done' : 'Not yet'}
                    </span>
                  </p>
                  <p className="text-xs leading-5 text-slate-400">{step.description}</p>
                </div>
              </div>

              {'download' in step.action ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={WINDOWS_DOWNLOAD_HREF}
                    onClick={handleDownload}
                    className="inline-flex min-h-9 flex-shrink-0 items-center justify-center gap-2 rounded-lg bg-[var(--primary-color,#00d9e8)] px-3 py-2 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
                  >
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                    <span>Download for Windows</span>
                  </a>
                  <a
                    href={MAC_DOWNLOAD_HREF}
                    onClick={handleDownload}
                    className="inline-flex min-h-9 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-color,rgba(255,255,255,0.12))] px-3 py-2 text-xs font-medium text-[var(--foreground,#f8fafc)] transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
                  >
                    <Download aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
                    <span>Mac (.dmg)</span>
                  </a>
                </div>
              ) : (
                <Link
                  href={step.action.href}
                  className="inline-flex min-h-9 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-color,rgba(255,255,255,0.12))] px-3 py-2 text-xs font-medium text-[var(--foreground,#f8fafc)] transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
                >
                  <span>{step.action.label}</span>
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-xs text-slate-500">
        Need more detail?{' '}
        <Link
          href="/dashboard/getting-started"
          className="font-medium text-[var(--primary-color,#00f0ff)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
        >
          Read the full getting-started guide
        </Link>
        .
      </p>
    </section>
  );
}

export default SetupChecklist;
