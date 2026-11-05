'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Workflow as WorkflowIcon,
  Activity,
  FileText,
  Plus,
  ArrowRight,
  Square
} from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { createClient } from '@/lib/supabase/client';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { TwoFactorBanner, ActionRequiredRunInfo } from '@/components/dashboard/TwoFactorBanner';
import { CreatePortalModal } from '@/components/dashboard/CreatePortalModal';
import { SetupChecklist } from '@/components/dashboard/SetupChecklist';
import { DrawerRunItem } from '@/components/dashboard/RunDetailsDrawer';
import { Workflow as WorkflowModel, RunStatus } from '@/lib/types/database';

interface DashboardStats {
  totalWorkflows: number;
  totalRuns: number;
  successRate: number | null;
  totalInvoices: number;
}

interface ActivityRunItem extends DrawerRunItem {
  percent?: number;
}

function formatRelativeTime(dateInput?: string | null): string {
  if (!dateInput) return 'Recently';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return 'Recently';

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 45) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return '—';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (isNaN(end) || end < start) return '—';

  const diffSec = Math.floor((end - start) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return `${min}m ${sec}s`;
}

export default function DashboardOverviewPage() {
  const {
    orgId,
    openRunDetails,
    stopActiveRun
  } = useDashboard();

  const [stats, setStats] = useState<DashboardStats>({
    totalWorkflows: 0,
    totalRuns: 0,
    successRate: null,
    totalInvoices: 0
  });

  const [recentRuns, setRecentRuns] = useState<ActivityRunItem[]>([]);
  const [allRuns, setAllRuns] = useState<DrawerRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [chartRange, setChartRange] = useState<'7d' | '30d'>('7d');

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const isFetchingRef = useRef(false);

  // Load and calculate overview metrics
  const loadOverviewData = useCallback(async () => {
    if (!orgId) return;
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      setLoadError(null);
      const supabase = createClient();

      // 1. Fetch workflows count (using head query to avoid downloading large workflow definitions)
      const { count: wfCount, error: workflowsError } = await supabase
        .from('wf_workflows')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId);
      if (workflowsError) throw workflowsError;

      // 2. Fetch execution runs with exact count and joined workflow name
      const { data: runsData, count: runsCount, error: runsError } = await supabase
        .from('wf_execution_runs')
        .select(
          'id, org_id, workflow_id, status, total_items_discovered, items_processed, items_downloaded, started_at, completed_at, error_summary, wf_workflows(name)',
          { count: 'exact' }
        )
        .eq('org_id', orgId)
        .order('started_at', { ascending: false });
      if (runsError) throw runsError;

      const rawRuns = (runsData || []) as Array<Record<string, unknown>>;

      // 3. Calculate Invoices Downloaded & Artifacts
      const sumItemsDownloaded = rawRuns.reduce(
        (acc, r) => acc + (Number(r.items_downloaded) || 0),
        0
      );

      const runIds = rawRuns.map((r) => String(r.id));
      let artifactsCount = 0;
      if (runIds.length > 0) {
        const { count: artCount, error: artifactsError } = await supabase
          .from('wf_run_artifacts')
          .select('id', { count: 'exact', head: true })
          .in('run_id', runIds);
        if (artifactsError) throw artifactsError;
        artifactsCount = artCount ?? 0;
      }
      const totalInvoices = Math.max(sumItemsDownloaded, artifactsCount);

      // 4. Compute Success Rate using case-insensitive status matching
      const totalR = runsCount ?? rawRuns.length;
      const completedCount = rawRuns.filter((r) => {
        const st = String(r.status || '').toLowerCase();
        return st === 'completed' || st === 'success';
      }).length;
      const rate = totalR > 0 ? Math.round((completedCount / totalR) * 100) : null;

      setStats({
        totalWorkflows: wfCount ?? 0,
        totalRuns: totalR,
        successRate: rate,
        totalInvoices
      });

      // 5. Parse runs for live activity stream and global drawer compatibility
      const parsedAllRuns: DrawerRunItem[] = rawRuns.map((r) => {
        const wf = r.wf_workflows as { name?: string } | null;
        const totalItems = Number(r.total_items_discovered || 0);
        const processed = Number(r.items_processed || 0);

        return {
          id: String(r.id),
          workflow_id: r.workflow_id ? String(r.workflow_id) : undefined,
          workflowName: wf?.name || 'Automated Workflow',
          wf_workflows: wf || undefined,
          status: (r.status as RunStatus) || 'pending',
          total_items_discovered: totalItems,
          items_processed: processed,
          items_downloaded: Number(r.items_downloaded || 0),
          started_at: r.started_at ? String(r.started_at) : undefined,
          completed_at: r.completed_at ? String(r.completed_at) : null,
          error_summary: r.error_summary ? String(r.error_summary) : null,
          time: r.started_at ? formatRelativeTime(String(r.started_at)) : undefined,
          duration: formatDuration(
            r.started_at ? String(r.started_at) : null,
            r.completed_at ? String(r.completed_at) : null
          )
        };
      });

      const parsedRecentRuns: ActivityRunItem[] = parsedAllRuns.slice(0, 6).map((run) => {
        const totalItems = run.total_items_discovered || 0;
        const processed = run.items_processed || 0;
        const percent =
          totalItems > 0 ? Math.min(100, Math.round((processed / totalItems) * 100)) : undefined;

        return {
          ...run,
          percent
        };
      });

      setAllRuns(parsedAllRuns);
      setRecentRuns(parsedRecentRuns);
    } catch (err) {
      console.error('Error loading dashboard overview data:', err);
      setLoadError('We couldn’t load your dashboard data. Please try again.');
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  }, [orgId]);

  // Initial load
  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) {
        void loadOverviewData();
      }
    }, 0);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [loadOverviewData]);

  // Realtime subscription on wf_execution_runs with debouncing
  useEffect(() => {
    if (!orgId) return;

    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedLoadOverview = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void loadOverviewData();
      }, 1000);
    };

    const supabase = createClient();
    const channel = supabase
      .channel(`wf_dashboard_overview_${orgId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wf_execution_runs',
          filter: `org_id=eq.${orgId}`
        },
        () => {
          debouncedLoadOverview();
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
  }, [orgId, loadOverviewData]);

  // Fallback 6s polling when active runs are executing
  const hasActiveRuns = useMemo(() => {
    return recentRuns.some((r) => {
      const st = String(r.status).toLowerCase();
      return st === 'pending' || st === 'running' || st === 'requires_action';
    });
  }, [recentRuns]);

  useEffect(() => {
    if (!hasActiveRuns || !orgId) return;

    const interval = setInterval(() => {
      void loadOverviewData();
    }, 6000);

    return () => clearInterval(interval);
  }, [hasActiveRuns, orgId, loadOverviewData]);


  // Aggregate the loaded execution history into daily counts for the activity chart.
  const chartData = useMemo(() => {
    const dayCount = chartRange === '7d' ? 7 : 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: dayCount }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (dayCount - index - 1));
      return {
        date,
        label: chartRange === '7d'
          ? date.toLocaleDateString(undefined, { weekday: 'short' })
          : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        successful: 0,
        failed: 0
      };
    });
    const dayIndexes = new Map<string, number>(days.map((day, index): [string, number] => [
      [day.date.getFullYear(), day.date.getMonth(), day.date.getDate()].join('-'),
      index
    ]));
    allRuns.forEach((run) => {
      if (!run.started_at) return;
      const startedAt = new Date(run.started_at);
      if (Number.isNaN(startedAt.getTime())) return;
      const index = dayIndexes.get([startedAt.getFullYear(), startedAt.getMonth(), startedAt.getDate()].join('-'));
      if (index === undefined) return;
      const status = String(run.status).toLowerCase();
      if (status === 'completed' || status === 'success') days[index].successful += 1;
      if (status === 'failed') days[index].failed += 1;
    });
    return days;
  }, [allRuns, chartRange]);

  const chartMax = Math.max(1, ...chartData.map((day) => Math.max(day.successful, day.failed)));
  const chartX = (index: number) => 30 + index * (540 / Math.max(1, chartData.length - 1));
  const chartY = (value: number) => 112 - (value / chartMax) * 88;
  const successfulPath = chartData.map((day, index) => chartX(index) + ',' + chartY(day.successful)).join(' ');
  const failedPath = chartData.map((day, index) => chartX(index) + ',' + chartY(day.failed)).join(' ');

  // Drives the first-run checklist: a completed run is the last thing a new user needs.
  const completedRunCount = useMemo(() => {
    return allRuns.filter((run) => {
      const st = String(run.status).toLowerCase();
      return st === 'completed' || st === 'success';
    }).length;
  }, [allRuns]);

  // Identify runs requiring 2FA intervention
  const activeActionRuns: ActionRequiredRunInfo[] = useMemo(() => {
    return allRuns
      .filter((r) => String(r.status).toLowerCase() === 'requires_action')
      .map((r) => ({
        id: r.id,
        workflowName: r.workflowName,
        wf_workflows: r.wf_workflows,
        error_summary: r.error_summary,
        started_at: r.started_at
      }));
  }, [allRuns]);

  // Handlers
  const handleStopRun = async (runId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setStoppingRunId(runId);
    try {
      const ok = await stopActiveRun(runId);
      if (ok) {
        setRecentRuns((prev) =>
          prev.map((r) => (r.id === runId ? { ...r, status: 'cancelled' } : r))
        );
        setAllRuns((prev) =>
          prev.map((r) => (r.id === runId ? { ...r, status: 'cancelled' } : r))
        );
      }
    } finally {
      setStoppingRunId(null);
    }
  };

  return (
    <div className="space-y-6 pb-10 sm:space-y-8">
      {/* 2FA Challenge Human-in-the-Loop Banner */}
      <TwoFactorBanner
        activeActionRuns={activeActionRuns}
        onSelectRun={(run) => {
          const matched = allRuns.find((r) => r.id === run.id) || recentRuns.find((r) => r.id === run.id);
          if (matched) {
            openRunDetails(matched);
          } else {
            openRunDetails({
              id: run.id,
              workflowName: run.workflowName || run.wf_workflows?.name || 'Automated Workflow',
              wf_workflows: run.wf_workflows,
              status: 'requires_action',
              started_at: run.started_at,
              error_summary: run.error_summary
            });
          }
        }}
      />

      {/* First-run guidance: self-hides once every step is complete. */}
      <SetupChecklist
        workflowCount={stats.totalWorkflows}
        completedRunCount={completedRunCount}
        isLoading={loading}
      />

      {/* Task-first entry point; existing workflow creation behavior is preserved. */}
      <section
        aria-labelledby="dashboard-task-heading"
        data-tour="hero"
        className="rounded-2xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-5 sm:p-7"
      >
        <div className="max-w-2xl space-y-2">
          <h1
            id="dashboard-task-heading"
            className="text-2xl font-semibold tracking-tight text-[var(--foreground,#f8fafc)] sm:text-3xl"
          >
            What do you want to automate?
          </h1>
          <p className="text-sm leading-6 text-slate-400 sm:text-base">
            Create a workflow to repeat browser tasks and collect the files or information you need.
          </p>
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[var(--primary-color,#00d9e8)] px-4 py-2 text-sm font-semibold text-slate-950 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--canvas-bg,#060913)]"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            <span>Create a workflow</span>
          </button>
          <Link
            href="/dashboard/workflows"
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--border-color,rgba(255,255,255,0.12))] px-4 py-2 text-sm font-medium text-[var(--foreground,#f8fafc)] transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
          >
            View workflows
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </section>


      {/* Compact metrics retain the existing live values and navigation. */}
      <section aria-label="Workspace metrics" data-tour="metrics" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Link href="/dashboard/workflows" className="group rounded-xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-4 transition-colors hover:border-[var(--primary-color,#00f0ff)] sm:p-5">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-400 sm:text-sm">Workflows</span><WorkflowIcon aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-[var(--primary-color,#00f0ff)]" /></div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">{loadError || loading ? '—' : stats.totalWorkflows}</p>
          <p className="mt-1 text-xs text-slate-500">Ready to run</p>
        </Link>
        <Link href="/dashboard/runs" className="group rounded-xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-4 transition-colors hover:border-[var(--primary-color,#00f0ff)] sm:p-5">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-400 sm:text-sm">Total runs</span><Activity aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-[var(--primary-color,#00f0ff)]" /></div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">{loadError || loading ? '—' : stats.totalRuns}</p>
          <div className="mt-2 flex h-5 items-end gap-1" aria-hidden="true">
            {chartData.map((day) => {
              const count = day.successful + day.failed;
              const maxCount = Math.max(1, ...chartData.map((item) => item.successful + item.failed));
              return <span key={day.date.toISOString()} className="min-w-0 flex-1 rounded-t-sm bg-[var(--primary-color,#00d9e8)] transition-all" style={{ height: Math.max(3, (count / maxCount) * 20) + 'px', opacity: count ? 0.8 : 0.2 }} title={day.label + ': ' + count + ' completed or failed runs'} />;
            })}
          </div>
        </Link>
        <div className="rounded-xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-400 sm:text-sm">Success rate</span><span aria-hidden="true" className="text-sm text-emerald-400">%</span></div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">{loadError || loading || stats.successRate === null ? '—' : stats.successRate + '%'}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800" aria-label={stats.successRate === null ? 'No completed runs yet' : stats.successRate + '% success rate'}>
            <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: (loadError || loading || stats.successRate === null ? 0 : stats.successRate) + '%' }} />
          </div>
        </div>
        <Link href="/dashboard/artifacts" className="group rounded-xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-4 transition-colors hover:border-[var(--primary-color,#00f0ff)] sm:p-5">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-400 sm:text-sm">Files collected</span><FileText aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-[var(--primary-color,#00f0ff)]" /></div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">{loadError || loading ? '—' : stats.totalInvoices}</p>
          <p className="mt-1 text-xs text-slate-500">Across your runs</p>
        </Link>
      </section>

      {/* A single focused chart adds context without crowding the overview. */}
      <section className="rounded-xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] p-4 sm:p-5" aria-labelledby="run-activity-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1"><h2 id="run-activity-heading" className="text-base font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">Run activity</h2><p className="text-xs text-slate-400">Successful and failed runs over time.</p></div>
          <div className="inline-flex self-start rounded-lg border border-[var(--border-color,rgba(255,255,255,0.08))] bg-black/10 p-1" role="group" aria-label="Chart time range">
            <button type="button" onClick={() => setChartRange('7d')} aria-pressed={chartRange === '7d'} className={'rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)] ' + (chartRange === '7d' ? 'bg-[var(--surface-hover,#172033)] text-[var(--foreground,#f8fafc)]' : 'text-slate-400 hover:text-slate-200')}>7 days</button>
            <button type="button" onClick={() => setChartRange('30d')} aria-pressed={chartRange === '30d'} className={'rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)] ' + (chartRange === '30d' ? 'bg-[var(--surface-hover,#172033)] text-[var(--foreground,#f8fafc)]' : 'text-slate-400 hover:text-slate-200')}>30 days</button>
          </div>
        </div>
        <div className="mt-4">
          <svg viewBox="0 0 600 145" role="img" aria-label={'Daily successful and failed run counts for the last ' + (chartRange === '7d' ? '7' : '30') + ' days'} className="h-44 w-full overflow-visible sm:h-52" preserveAspectRatio="none">
            {[24, 52, 80, 108].map((y) => <line key={y} x1="30" y1={y} x2="570" y2={y} stroke="currentColor" strokeOpacity="0.1" strokeDasharray="3 5" />)}
            {chartData.some((day) => day.successful > 0) && <polygon points={'30,112 ' + successfulPath + ' 570,112'} fill="#82abff" fillOpacity="0.10" />}
            <polyline points={successfulPath} fill="none" stroke="#82abff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <polyline points={failedPath} fill="none" stroke="#e6a16f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {chartData.map((day, index) => <g key={day.date.toISOString()}>
              {chartRange === '7d' && day.successful > 0 && <circle cx={chartX(index)} cy={chartY(day.successful)} r="3" fill="#82abff" />}
              {chartRange === '7d' && day.failed > 0 && <circle cx={chartX(index)} cy={chartY(day.failed)} r="3" fill="#e6a16f" />}
              {(chartRange === '7d' || index % 5 === 0 || index === chartData.length - 1) && <text x={chartX(index)} y="137" fill="currentColor" fillOpacity="0.6" fontSize="10" textAnchor="middle">{day.label}</text>}
            </g>)}
          </svg>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400"><span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#82abff]" />Successful</span><span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#e6a16f]" />Failed</span></div>
          {!loading && !loadError && allRuns.length === 0 && <p className="mt-4 text-center text-xs text-slate-500">Run a workflow to start building your activity history.</p>}
          {loadError && <p className="mt-4 text-xs text-slate-500">Activity data will appear when your dashboard data is available.</p>}
        </div>
      </section>

      {/* Recent executions remain the primary operational content */}
      <section className="space-y-3" data-tour="recent-runs">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-[var(--foreground,#f8fafc)]">Recent runs</h2>
            <p className="text-xs text-slate-400">The latest activity across your workflows.</p>
          </div>
          <Link
            href="/dashboard/runs"
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-[var(--primary-color,#00f0ff)] transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
          >
            <span>View all</span>
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="rounded-xl border border-[var(--border-color,rgba(255,255,255,0.08))] bg-[var(--surface-bg,#0c101d)] px-4 sm:px-5">
          {loadError ? (
            <div className="flex flex-col items-start gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-[var(--foreground,#f8fafc)]">Dashboard data is unavailable</p>
                <p className="text-xs text-slate-400">{loadError}</p>
              </div>
              <button
                type="button"
                onClick={() => void loadOverviewData()}
                className="rounded-lg border border-[var(--border-color,rgba(255,255,255,0.1))] px-3 py-2 text-xs font-medium text-[var(--foreground,#f8fafc)] transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
              >
                Try again
              </button>
            </div>
          ) : loading && recentRuns.length === 0 ? (
            <div className="space-y-4 py-5" aria-label="Loading recent executions">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex animate-pulse items-center gap-3 py-2">
                  <div className="h-9 w-9 rounded-lg bg-slate-800" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 rounded bg-slate-800" />
                    <div className="h-2.5 w-1/4 rounded bg-slate-800" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentRuns.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-[var(--foreground,#f8fafc)]">No executions yet</p>
                <p className="text-xs text-slate-400">Create a workflow to start automating your work.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(true)}
                className="rounded-lg border border-[var(--border-color,rgba(255,255,255,0.1))] px-3 py-2 text-xs font-medium text-[var(--foreground,#f8fafc)] transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
              >
                Create workflow
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-color,rgba(255,255,255,0.07))]">
              {recentRuns.map((run) => {
                const status = String(run.status).toLowerCase();
                const isActive = ['pending', 'running', 'requires_action'].includes(status);

                return (
                  <div key={run.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-4">
                    <button
                      type="button"
                      onClick={() => openRunDetails(run)}
                      className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color,#00f0ff)]"
                      aria-label={`View execution details for ${run.workflowName}`}
                    >
                      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--surface-hover,#11182c)]">
                        <WorkflowIcon aria-hidden="true" className="h-4 w-4 text-[var(--primary-color,#00f0ff)]" />
                      </span>
                      <span className="min-w-0 flex-1 space-y-1.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-[var(--foreground,#f8fafc)]">{run.workflowName}</span>
                          <StatusBadge status={run.status} />
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                          <span>{run.time || 'Recently'}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>{run.duration}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>{run.items_downloaded && run.items_downloaded > 0
                            ? `${run.items_downloaded} files downloaded`
                            : `${run.items_processed || 0} items processed`}</span>
                        </span>
                        {isActive && run.percent !== undefined && (
                          <span className="block max-w-md space-y-1 pt-1">
                            <span className="flex items-center justify-between text-[10px] text-slate-400">
                              <span>Progress</span>
                              <span>{run.items_processed} / {run.total_items_discovered} ({run.percent}%)</span>
                            </span>
                            <span className="block h-1.5 overflow-hidden rounded-full bg-slate-800">
                              <span className="block h-full rounded-full bg-[var(--primary-color,#00f0ff)] transition-all duration-300" style={{ width: `${run.percent}%` }} />
                            </span>
                          </span>
                        )}
                        {isActive && run.percent === undefined && status === 'running' && (
                          <span className="block pt-1 text-[10px] text-slate-400">
                            Executing steps · {run.items_processed || 0} processed
                          </span>
                        )}
                      </span>
                    </button>

                    {isActive && (
                      <button
                        type="button"
                        onClick={(e) => void handleStopRun(run.id, e)}
                        disabled={stoppingRunId === run.id}
                        className="inline-flex min-h-8 items-center justify-center gap-1.5 self-start rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 sm:self-auto"
                        title="Stop execution"
                        aria-label={`Stop execution for ${run.workflowName}`}
                      >
                        <Square aria-hidden="true" className="h-3 w-3 fill-current" />
                        <span>Stop</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Global Modals */}
      <CreatePortalModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        orgId={orgId || ''}
        onWorkflowCreated={async () => {
          setIsCreateModalOpen(false);
          await loadOverviewData();
        }}
      />
    </div>
  );
}
