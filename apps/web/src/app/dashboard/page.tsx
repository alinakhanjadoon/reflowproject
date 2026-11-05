'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Workflow as WorkflowIcon,
  Activity,
  FileText,
  Plus,
  ArrowRight,
  Square,
  Play,
  Repeat,
  Calendar,
  Settings,
  Sparkles,
  CheckCircle2,
  Clock,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  Flame,
  ShieldCheck,
  Check,
  RefreshCw,
  Lightbulb
} from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { createClient } from '@/lib/supabase/client';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { TwoFactorBanner, ActionRequiredRunInfo } from '@/components/dashboard/TwoFactorBanner';
import { CreatePortalModal } from '@/components/dashboard/CreatePortalModal';
import { ExecutionPreflightModal } from '@/components/dashboard/ExecutionPreflightModal';
import { SetupChecklist } from '@/components/dashboard/SetupChecklist';
import { DrawerRunItem } from '@/components/dashboard/RunDetailsDrawer';
import { RobotAvatar, REFLOW_MASCOT_URL } from '@/components/dashboard/RobotAvatar';
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

interface DashboardWorkflowItem {
  id: string;
  name: string;
  description?: string | null;
  updated_at?: string;
  workflow_definition?: Record<string, unknown>;
  run_count?: number;
  last_run_at?: string | null;
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
  const [workflowsList, setWorkflowsList] = useState<DashboardWorkflowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [chartRange, setChartRange] = useState<'7d' | '30d'>('7d');

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedWorkflowForRun, setSelectedWorkflowForRun] = useState<WorkflowModel | null>(null);
  const isFetchingRef = useRef(false);

  // Load and calculate overview metrics
  const loadOverviewData = useCallback(async () => {
    if (!orgId) return;
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      setLoadError(null);
      const supabase = createClient();

      // 1. Fetch workflows count and top workflows list
      const { data: wfData, count: wfCount, error: workflowsError } = await supabase
        .from('wf_workflows')
        .select('id, name, description, updated_at, workflow_definition', { count: 'exact' })
        .eq('org_id', orgId)
        .order('updated_at', { ascending: false });
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
      let totalDownloaded = 0;
      let completedCount = 0;
      let totalEndedCount = 0;

      const runCountMap = new Map<string, number>();
      const lastRunMap = new Map<string, string>();

      const mappedAllRuns: DrawerRunItem[] = rawRuns.map((r) => {
        const wfObj = r.wf_workflows as { name?: string } | null;
        const workflowName = wfObj?.name || 'Automated Workflow';
        const st = String(r.status || 'pending').toLowerCase();
        const downloaded = typeof r.items_downloaded === 'number' ? r.items_downloaded : 0;
        const processed = typeof r.items_processed === 'number' ? r.items_processed : 0;
        const discovered = typeof r.total_items_discovered === 'number' ? r.total_items_discovered : 0;

        totalDownloaded += downloaded;

        if (r.workflow_id) {
          const wId = String(r.workflow_id);
          runCountMap.set(wId, (runCountMap.get(wId) || 0) + 1);
          if (!lastRunMap.has(wId) && r.started_at) {
            lastRunMap.set(wId, String(r.started_at));
          }
        }

        if (st === 'completed' || st === 'success') {
          completedCount += 1;
          totalEndedCount += 1;
        } else if (st === 'failed' || st === 'cancelled') {
          totalEndedCount += 1;
        }

        return {
          id: String(r.id),
          workflowId: r.workflow_id ? String(r.workflow_id) : undefined,
          workflowName,
          wf_workflows: wfObj ? { name: workflowName } : undefined,
          status: st as RunStatus,
          started_at: r.started_at ? String(r.started_at) : undefined,
          completed_at: r.completed_at ? String(r.completed_at) : undefined,
          time: formatRelativeTime(r.started_at ? String(r.started_at) : null),
          duration: formatDuration(r.started_at ? String(r.started_at) : null, r.completed_at ? String(r.completed_at) : null),
          total_items_discovered: discovered,
          items_processed: processed,
          items_downloaded: downloaded,
          error_summary: r.error_summary ? String(r.error_summary) : undefined
        };
      });

      const mappedRecent: ActivityRunItem[] = mappedAllRuns.slice(0, 8).map((r) => {
        let pct: number | undefined;
        if (r.total_items_discovered && r.total_items_discovered > 0 && r.items_processed !== undefined) {
          pct = Math.min(100, Math.round((r.items_processed / r.total_items_discovered) * 100));
        }
        return { ...r, percent: pct };
      });

      const successRate = totalEndedCount > 0 ? Math.round((completedCount / totalEndedCount) * 100) : null;

      setStats({
        totalWorkflows: wfCount || 0,
        totalRuns: runsCount || 0,
        successRate,
        totalInvoices: totalDownloaded
      });

      const populatedWorkflows: DashboardWorkflowItem[] = (wfData || []).map((w: any) => ({
        id: w.id,
        name: w.name || 'Untitled Workflow',
        description: w.description,
        updated_at: w.updated_at,
        workflow_definition: w.workflow_definition,
        run_count: runCountMap.get(w.id) || 0,
        last_run_at: lastRunMap.get(w.id) || null
      }));

      setWorkflowsList(populatedWorkflows);
      setAllRuns(mappedAllRuns);
      setRecentRuns(mappedRecent);
    } catch (err: unknown) {
      console.error('[DashboardOverview] Fetch error:', err);
      setLoadError(err instanceof Error ? err.message : 'Unable to connect to database');
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

  // Activity chart data
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

  // Drives the first-run checklist
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

  const handleQuickRunWorkflow = (wf: DashboardWorkflowItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedWorkflowForRun(wf as unknown as WorkflowModel);
  };

  return (
    <div className="relative space-y-6 pb-12 sm:space-y-8">
      {/* Top Ambient Glow Aura (From Stitch Design) */}
      <div className="pointer-events-none absolute -top-24 -left-20 h-96 w-96 rounded-full bg-cyan-500/10 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -right-24 h-96 w-96 rounded-full bg-purple-500/10 blur-3xl" />

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

      {/* First-run guidance checklist */}
      <SetupChecklist
        workflowCount={stats.totalWorkflows}
        completedRunCount={completedRunCount}
        isLoading={loading}
      />

      {/* HERO BANNER: ReFlow Companion Robot Mascot & Warm Welcome */}
      <section
        aria-labelledby="dashboard-hero-heading"
        data-tour="hero"
        className="relative overflow-hidden rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-[#0c1427]/95 via-[#0f172a]/95 to-[#131b2e]/95 p-6 shadow-2xl backdrop-blur-2xl sm:p-8"
      >
        <div className="pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full bg-cyan-500/15 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-16 -right-16 h-64 w-64 rounded-full bg-purple-500/15 blur-2xl" />

        <div className="relative z-10 flex flex-col items-center justify-between gap-6 md:flex-row md:items-center">
          {/* Mascot Portrait with Beacon */}
          <div className="group relative flex flex-shrink-0 items-center justify-center">
            <div className="absolute inset-0 scale-90 rounded-full bg-cyan-500/25 blur-2xl transition-transform duration-500 group-hover:scale-105" />
            <img
              src={REFLOW_MASCOT_URL}
              alt="ReFlow AI Friendly Companion Robot Assistant"
              className="relative h-40 w-40 object-contain drop-shadow-[0_12px_32px_rgba(6,182,212,0.35)] transition-transform duration-300 hover:-translate-y-1 sm:h-48 sm:w-48"
            />
            <div className="absolute -bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-cyan-500/30 bg-[#171f33]/90 px-3 py-1 shadow-lg backdrop-blur-md">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-[11px] font-semibold text-cyan-300">Assistant Online</span>
            </div>
          </div>

          {/* Welcome Copy & CTAs */}
          <div className="flex flex-1 flex-col items-center text-center md:items-start md:text-left">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-300">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Next-Gen Workflow Orchestration</span>
            </div>

            <h1
              id="dashboard-hero-heading"
              className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl md:text-4xl"
            >
              Welcome to{' '}
              <span className="bg-gradient-to-r from-cyan-400 via-teal-300 to-purple-400 bg-clip-text text-transparent">
                ReFlow!
              </span>
            </h1>

            <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-300 sm:text-base">
              Your smart automation assistant for effortless workflow execution. Scale agents, chain data pipelines, and eliminate repetitive work.
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-3 md:justify-start">
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(true)}
                className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-cyan-500 via-cyan-400 to-blue-500 px-6 py-2.5 text-sm font-bold text-slate-950 shadow-[0_0_24px_rgba(6,182,212,0.45)] transition-all hover:scale-[1.02] hover:shadow-[0_0_32px_rgba(6,182,212,0.7)] active:scale-[0.98]"
              >
                <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
                <span>Create New Workflow</span>
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </button>

              <Link
                href="/dashboard/getting-started"
                className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/80 px-5 py-2.5 text-sm font-semibold text-slate-200 backdrop-blur-md transition-colors hover:bg-slate-700 hover:text-white"
              >
                <span>Quick Tour</span>
                <ChevronRight className="h-4 w-4 text-cyan-400" />
              </Link>
            </div>
          </div>

          {/* Quick Metrics Health Pill */}
          <div className="hidden min-w-[210px] flex-col gap-2 rounded-2xl border border-cyan-500/20 bg-[#171f33]/80 p-4 shadow-xl backdrop-blur-xl xl:flex">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Health Status</span>
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">
                {stats.totalWorkflows} Active {stats.totalWorkflows === 1 ? 'Flow' : 'Flows'}
              </span>
              <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                100% Ok
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-cyan-400 transition-all"
                style={{ width: `${stats.successRate === null ? 100 : Math.max(15, stats.successRate)}%` }}
              />
            </div>
            <div className="flex items-center justify-between pt-1 text-xs text-slate-400">
              <span>Success Rate</span>
              <span className="font-semibold text-cyan-300">
                {stats.successRate === null ? '100%' : `${stats.successRate}%`}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* WORKSPACE METRICS: The four live numbers that matter (with Stitch aesthetic & Tour anchor) */}
      <section aria-label="Workspace metrics" data-tour="metrics" className="grid grid-cols-2 gap-3.5 sm:gap-4 xl:grid-cols-4">
        <Link
          href="/dashboard/workflows"
          className="group relative overflow-hidden rounded-2xl border border-cyan-500/15 bg-[#0e1628]/90 p-4 sm:p-5 shadow-lg backdrop-blur-xl transition-all hover:border-cyan-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(6,182,212,0.3)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-400 group-hover:text-cyan-300 transition-colors">Workflows</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400 group-hover:bg-cyan-500/20">
              <WorkflowIcon aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-white">{loadError || loading ? '—' : stats.totalWorkflows}</p>
          <p className="mt-1 text-xs text-slate-400">Ready to run</p>
        </Link>

        <Link
          href="/dashboard/runs"
          className="group relative overflow-hidden rounded-2xl border border-purple-500/15 bg-[#0e1628]/90 p-4 sm:p-5 shadow-lg backdrop-blur-xl transition-all hover:border-purple-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(168,85,247,0.3)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-400 group-hover:text-purple-300 transition-colors">Total Runs</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10 text-purple-400 group-hover:bg-purple-500/20">
              <Play aria-hidden="true" className="h-4 w-4 fill-current flex-shrink-0" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-white">{loadError || loading ? '—' : stats.totalRuns}</p>
          <p className="mt-1 text-xs text-slate-400">Total executions</p>
        </Link>

        <div className="relative overflow-hidden rounded-2xl border border-emerald-500/15 bg-[#0e1628]/90 p-4 sm:p-5 shadow-lg backdrop-blur-xl transition-all hover:border-emerald-500/40 hover:bg-[#131e36]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-400">Success Rate</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
              <CheckCircle2 aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-white">
            {loadError || loading ? '—' : stats.successRate === null ? '—' : `${stats.successRate}%`}
          </p>
          <p className="mt-1 text-xs text-slate-400">Runs completed cleanly</p>
        </div>

        <Link
          href="/dashboard/artifacts"
          className="group relative overflow-hidden rounded-2xl border border-amber-500/15 bg-[#0e1628]/90 p-4 sm:p-5 shadow-lg backdrop-blur-xl transition-all hover:border-amber-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(245,158,11,0.3)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-400 group-hover:text-amber-300 transition-colors">Files Collected</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 group-hover:bg-amber-500/20">
              <FileText aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-white">{loadError || loading ? '—' : stats.totalInvoices}</p>
          <p className="mt-1 text-xs text-slate-400">Invoices and outputs</p>
        </Link>
      </section>

      {/* QUICK ACTIONS GRID: 4 Modern Cards (From Stitch Design) */}
      <section aria-label="Quick Actions" className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Flame className="h-5 w-5 text-cyan-400" />
            <h2 className="text-lg font-bold text-white">Quick Actions</h2>
          </div>
          <Link
            href="/dashboard/workflows"
            className="flex items-center gap-1 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            <span>Explore all actions</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Action 1: Run Workflow Once */}
          <Link
            href="/dashboard/workflows"
            className="group relative flex h-36 flex-col justify-between overflow-hidden rounded-2xl border border-cyan-500/15 bg-[#0e1628]/90 p-5 shadow-lg transition-all hover:border-cyan-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(6,182,212,0.35)]"
          >
            <div className="pointer-events-none absolute top-0 right-0 h-24 w-24 rounded-full bg-cyan-500/5 blur-xl group-hover:bg-cyan-500/10 transition-colors" />
            <div className="flex items-start justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 shadow-sm transition-colors group-hover:bg-cyan-500 group-hover:text-black">
                <Play className="h-5 w-5 fill-current" />
              </div>
              <ArrowRight className="h-4 w-4 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div>
              <span className="block text-sm font-bold text-white transition-colors group-hover:text-cyan-300">
                Run Workflow
              </span>
              <span className="text-xs text-slate-400">Execute a single run on demand</span>
            </div>
          </Link>

          {/* Action 2: Repeat Tasks (Multiple Records) */}
          <Link
            href="/dashboard/workflows"
            className="group relative flex h-36 flex-col justify-between overflow-hidden rounded-2xl border border-purple-500/15 bg-[#0e1628]/90 p-5 shadow-lg transition-all hover:border-purple-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(168,85,247,0.35)]"
          >
            <div className="pointer-events-none absolute top-0 right-0 h-24 w-24 rounded-full bg-purple-500/5 blur-xl group-hover:bg-purple-500/10 transition-colors" />
            <div className="flex items-start justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 shadow-sm transition-colors group-hover:bg-purple-500 group-hover:text-black">
                <Repeat className="h-5 w-5" />
              </div>
              <ArrowRight className="h-4 w-4 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div>
              <span className="block text-sm font-bold text-white transition-colors group-hover:text-purple-300">
                Repeat Tasks
              </span>
              <span className="text-xs text-slate-400">Batch cycle across multiple records</span>
            </div>
          </Link>

          {/* Action 3: Schedule Execution */}
          <Link
            href="/dashboard/workflows"
            className="group relative flex h-36 flex-col justify-between overflow-hidden rounded-2xl border border-blue-500/15 bg-[#0e1628]/90 p-5 shadow-lg transition-all hover:border-blue-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(59,130,246,0.35)]"
          >
            <div className="pointer-events-none absolute top-0 right-0 h-24 w-24 rounded-full bg-blue-500/5 blur-xl group-hover:bg-blue-500/10 transition-colors" />
            <div className="flex items-start justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 shadow-sm transition-colors group-hover:bg-blue-500 group-hover:text-black">
                <Calendar className="h-5 w-5" />
              </div>
              <ArrowRight className="h-4 w-4 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div>
              <span className="block text-sm font-bold text-white transition-colors group-hover:text-blue-300">
                Schedule Execution
              </span>
              <span className="text-xs text-slate-400">Set recurring triggers and intervals</span>
            </div>
          </Link>

          {/* Action 4: View Settings */}
          <Link
            href="/dashboard/settings"
            className="group relative flex h-36 flex-col justify-between overflow-hidden rounded-2xl border border-teal-500/15 bg-[#0e1628]/90 p-5 shadow-lg transition-all hover:border-teal-500/40 hover:bg-[#131e36] hover:shadow-[0_0_20px_-4px_rgba(20,184,166,0.35)]"
          >
            <div className="pointer-events-none absolute top-0 right-0 h-24 w-24 rounded-full bg-teal-500/5 blur-xl group-hover:bg-teal-500/10 transition-colors" />
            <div className="flex items-start justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-500/10 text-teal-400 shadow-sm transition-colors group-hover:bg-teal-500 group-hover:text-black">
                <Settings className="h-5 w-5" />
              </div>
              <ArrowRight className="h-4 w-4 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div>
              <span className="block text-sm font-bold text-white transition-colors group-hover:text-teal-300">
                View Settings
              </span>
              <span className="text-xs text-slate-400">Manage credentials, webhooks & AI</span>
            </div>
          </Link>
        </div>
      </section>

      {/* ASYMMETRIC BENTO GRID: Workflows (7 cols) + Activity Feed (5 cols) */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* LEFT COLUMN: My Workflows & Weekly Throughput */}
        <section className="flex flex-col gap-6 lg:col-span-7">
          {/* Workflows List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <WorkflowIcon className="h-5 w-5 text-cyan-400" />
                <h2 className="text-lg font-bold text-white">My Workflows</h2>
                <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-300">
                  {stats.totalWorkflows} Configured
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(true)}
                className="flex items-center gap-1 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New Workflow</span>
              </button>
            </div>

            <div className="space-y-3">
              {loading && workflowsList.length === 0 ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-900/60 border border-slate-800" />
                  ))}
                </div>
              ) : workflowsList.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-800 bg-[#0e1628]/50 p-8 text-center">
                  <WorkflowIcon className="mx-auto h-8 w-8 text-slate-500" />
                  <p className="mt-2 text-sm font-semibold text-white">No workflows configured yet</p>
                  <p className="mt-1 text-xs text-slate-400">Create your first automated workflow to get started.</p>
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(true)}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-cyan-500 px-4 py-1.5 text-xs font-bold text-black hover:bg-cyan-400 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Create Workflow</span>
                  </button>
                </div>
              ) : (
                workflowsList.slice(0, 4).map((wf) => (
                  <div
                    key={wf.id}
                    className="group relative flex flex-col justify-between gap-4 rounded-2xl border border-cyan-500/10 bg-[#0e1628]/90 p-4 shadow-md transition-all hover:border-cyan-500/30 hover:bg-[#131e36] sm:flex-row sm:items-center"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 group-hover:bg-cyan-500 group-hover:text-black transition-colors shadow-sm">
                        <FileText className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/dashboard/workflows/${wf.id}/edit`}
                            className="truncate text-sm font-bold text-white hover:text-cyan-300 transition-colors"
                          >
                            {wf.name}
                          </Link>
                          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
                            Active
                          </span>
                        </div>
                        <p className="truncate text-xs text-slate-400 mt-0.5">
                          {wf.description || 'Automated browser extraction and workflow replay'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-4 flex-shrink-0">
                      <div className="text-right">
                        <span className="block text-xs font-semibold text-white">
                          {wf.run_count} {wf.run_count === 1 ? 'run' : 'runs'}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {wf.last_run_at ? formatRelativeTime(wf.last_run_at) : 'Not run yet'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => handleQuickRunWorkflow(wf, e)}
                        className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500 text-black shadow-md hover:bg-cyan-400 hover:scale-105 active:scale-95 transition-all"
                        title="Run workflow wizard"
                        aria-label={`Run ${wf.name}`}
                      >
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Weekly Throughput / Activity Sparkline Chart */}
          <div className="rounded-2xl border border-cyan-500/15 bg-[#0e1628]/90 p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-cyan-400" />
                <span className="text-sm font-bold text-white">Weekly Throughput</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">
                  {stats.totalRuns} total executions
                </span>
                <div className="inline-flex rounded-lg border border-slate-800 bg-black/20 p-0.5">
                  <button
                    type="button"
                    onClick={() => setChartRange('7d')}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      chartRange === '7d' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    7d
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartRange('30d')}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      chartRange === '30d' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    30d
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 h-24 w-full">
              <svg
                viewBox="0 0 600 145"
                role="img"
                aria-label="Daily throughput"
                className="h-full w-full overflow-visible"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="chartGlowGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#00f0ff" stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                {[24, 52, 80, 108].map((y) => (
                  <line key={y} x1="30" y1={y} x2="570" y2={y} stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 5" />
                ))}
                {chartData.some((day) => day.successful > 0) && (
                  <polygon points={'30,112 ' + successfulPath + ' 570,112'} fill="url(#chartGlowGradient)" />
                )}
                <polyline
                  points={successfulPath}
                  fill="none"
                  stroke="#00f0ff"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                <polyline
                  points={failedPath}
                  fill="none"
                  stroke="#f43f5e"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {chartData.map((day, index) => (
                  <g key={day.date.toISOString()}>
                    {chartRange === '7d' && day.successful > 0 && (
                      <circle cx={chartX(index)} cy={chartY(day.successful)} r="3.5" fill="#00f0ff" />
                    )}
                    {chartRange === '7d' && day.failed > 0 && (
                      <circle cx={chartX(index)} cy={chartY(day.failed)} r="3" fill="#f43f5e" />
                    )}
                    {(chartRange === '7d' || index % 5 === 0 || index === chartData.length - 1) && (
                      <text x={chartX(index)} y="137" fill="#94a3b8" fontSize="10" textAnchor="middle">
                        {day.label}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-cyan-400" />
                  Successful
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  Failed
                </span>
              </div>
              <span className="font-semibold text-cyan-300">Peak Performance</span>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Recent Executions Feed & Assistant Callout Tip */}
        <section className="flex flex-col gap-6 lg:col-span-5" data-tour="recent-runs">
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-purple-400" />
                <h2 className="text-lg font-bold text-white">Recent Executions</h2>
              </div>
              <Link
                href="/dashboard/runs"
                className="flex items-center gap-1 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                <span>View all</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            <div className="divide-y divide-slate-800/80 rounded-2xl border border-cyan-500/10 bg-[#0e1628]/90 p-3 shadow-lg">
              {loading && recentRuns.length === 0 ? (
                <div className="space-y-3 p-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-900" />
                  ))}
                </div>
              ) : recentRuns.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  No executions recorded yet. Run a workflow to start tracking live telemetry.
                </div>
              ) : (
                recentRuns.slice(0, 5).map((run) => {
                  const status = String(run.status).toLowerCase();
                  const isActive = ['pending', 'running', 'requires_action'].includes(status);

                  return (
                    <div
                      key={run.id}
                      onClick={() => openRunDetails(run)}
                      className="group flex cursor-pointer items-center justify-between p-3 rounded-xl transition-all hover:bg-white/5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-slate-800 text-cyan-400 group-hover:bg-cyan-500 group-hover:text-black transition-colors">
                          {isActive ? (
                            <RefreshCw className="h-4 w-4 animate-spin text-cyan-400" />
                          ) : status === 'completed' || status === 'success' ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          ) : (
                            <WorkflowIcon className="h-4 w-4 text-slate-400" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-white group-hover:text-cyan-300 transition-colors">
                            {run.workflowName}
                          </span>
                          <span className="block text-[11px] text-slate-400">
                            {run.items_downloaded && run.items_downloaded > 0
                              ? `${run.items_downloaded} files downloaded • ${run.duration}`
                              : `${run.items_processed || 0} items • ${run.duration}`}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-[11px] text-slate-400">
                          {run.time || 'Recently'}
                        </span>
                        {isActive && (
                          <button
                            type="button"
                            onClick={(e) => void handleStopRun(run.id, e)}
                            disabled={stoppingRunId === run.id}
                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-white transition-colors"
                            title="Stop execution"
                          >
                            <Square className="h-3 w-3 fill-current" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* ASSISTANT CALLOUT TIP BOX (From Stitch Screen 1) */}
          <div className="relative overflow-hidden rounded-2xl border border-purple-500/20 bg-gradient-to-r from-[#171f33]/90 to-[#222a3d]/90 p-4 shadow-xl backdrop-blur-md">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-purple-500/20 text-purple-300 shadow-md">
                <Lightbulb className="h-4 w-4 text-purple-300" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white">Assistant Tip</span>
                  <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[9px] font-bold text-purple-300">
                    Pro Tip
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-slate-300">
                  Choose <strong className="font-semibold text-white">Repeat Tasks</strong> mode when downloading bulk attachments. ReFlow optimizes memory consumption by batching up to 100 items per cycle automatically.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

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

      {/* Redesigned Execution Setup Wizard Modal */}
      {selectedWorkflowForRun && (
        <ExecutionPreflightModal
          isOpen={Boolean(selectedWorkflowForRun)}
          onClose={() => setSelectedWorkflowForRun(null)}
          workflow={selectedWorkflowForRun}
          onRunDispatched={async (run) => {
            await loadOverviewData();
            openRunDetails(run);
          }}
        />
      )}
    </div>
  );
}
