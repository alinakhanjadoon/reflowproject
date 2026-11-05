'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Search,
  RotateCw,
  Clock,
  Download,
  AlertCircle,
  X,
  Play,
  Square,
  ChevronRight,
  Copy,
  Check,
  CheckCircle2,
  Layers,
  Sparkles,
  ShieldAlert,
  Loader2,
  FileText
} from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { TwoFactorBanner } from '@/components/dashboard/TwoFactorBanner';
import { RobotAvatar } from '@/components/dashboard/RobotAvatar';
import { DrawerRunItem } from '@/components/dashboard/RunDetailsDrawer';
import { RunStatus, ExecutionRun, Workflow } from '@/lib/types/database';
import { createClient } from '@/lib/supabase/client';

export interface ExecutionRunItem {
  id: string;
  org_id: string;
  workflow_id: string;
  status: RunStatus | string;
  total_items_discovered: number;
  items_processed: number;
  items_downloaded: number;
  started_at: string;
  completed_at?: string | null;
  error_summary?: string | null;
  wf_workflows?: { name?: string } | null;
  workflowName?: string;
}

type FilterPill = 'all' | 'active' | 'requires_action' | 'completed' | 'failed';

function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return '—';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (isNaN(end) || end < start) return '—';

  const diffSec = Math.floor((end - start) / 1000);
  if (diffSec < 0) return '—';
  if (diffSec < 60) return `${diffSec}s`;

  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  if (min < 60) return `${min}m ${sec}s`;

  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hours}h ${remMin}m`;
}

function formatRelativeTime(dateInput?: string | null): string {
  if (!dateInput) return '—';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return '—';

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

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function RunsTelemetryPage() {
  const { orgId, openRunDetails, stopActiveRun, refreshDashboard } = useDashboard();

  const [runs, setRuns] = useState<ExecutionRunItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingLocal, setIsRefreshingLocal] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Filters & Search
  const [statusFilter, setStatusFilter] = useState<FilterPill>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const isFetchingRef = useRef(false);

  // Keyboard shortcut: Ctrl+K / Cmd+K to focus search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Fetch runs with joined workflow name
  const fetchRuns = useCallback(
    async (isSilent = false) => {
      if (!orgId) return;
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (!isSilent) setFetchError(null);

      try {
        const supabase = createClient();

        // Query Supabase directly with joined workflow name
        const { data: supabaseRuns, error: sbError } = await supabase
          .from('wf_execution_runs')
          .select(
            'id, org_id, workflow_id, status, total_items_discovered, items_processed, items_downloaded, started_at, completed_at, error_summary, wf_workflows(name)'
          )
          .eq('org_id', orgId)
          .order('started_at', { ascending: false });

        if (!sbError && Array.isArray(supabaseRuns)) {
          const formatted: ExecutionRunItem[] = supabaseRuns.map((r: unknown) => {
            const row = r as Record<string, unknown>;
            const wf = row.wf_workflows as { name?: string } | null;
            return {
              id: String(row.id),
              org_id: String(row.org_id),
              workflow_id: String(row.workflow_id),
              status: row.status as RunStatus,
              total_items_discovered: Number(row.total_items_discovered ?? 0),
              items_processed: Number(row.items_processed ?? 0),
              items_downloaded: Number(row.items_downloaded ?? 0),
              started_at: String(row.started_at),
              completed_at: row.completed_at ? String(row.completed_at) : null,
              error_summary: row.error_summary ? String(row.error_summary) : null,
              wf_workflows: wf,
              workflowName: wf?.name || undefined,
            };
          });
          setRuns(formatted);
          return;
        }

        // Resilient fallback: API /api/v1/runs with workflows map
        const [runsRes, wfRes] = await Promise.all([
          fetch('/api/v1/runs', { cache: 'no-store' }),
          fetch('/api/v1/workflows', { cache: 'no-store' }).catch(() => null),
        ]);

        if (!runsRes.ok) {
          const errData = await runsRes.json().catch(() => ({}));
          throw new Error(errData.error || `Failed to fetch runs (${runsRes.status})`);
        }

        const runsJson = await runsRes.json();
        const rawRuns: ExecutionRun[] = Array.isArray(runsJson.runs) ? runsJson.runs : [];

        let wfMap: Record<string, string> = {};
        if (wfRes && wfRes.ok) {
          const wfJson = await wfRes.json();
          if (Array.isArray(wfJson.workflows)) {
            wfMap = wfJson.workflows.reduce((acc: Record<string, string>, w: Workflow) => {
              acc[w.id] = w.name;
              return acc;
            }, {});
          }
        }

        const merged: ExecutionRunItem[] = rawRuns.map((r) => ({
          ...r,
          wf_workflows: wfMap[r.workflow_id] ? { name: wfMap[r.workflow_id] } : undefined,
          workflowName: wfMap[r.workflow_id] || undefined,
        }));

        setRuns(merged);
      } catch (err: unknown) {
        if (!isSilent) {
          setFetchError(err instanceof Error ? err.message : 'Failed to load execution runs');
        }
      } finally {
        isFetchingRef.current = false;
        if (!isSilent) {
          setIsLoading(false);
          setIsRefreshingLocal(false);
        }
      }
    },
    [orgId]
  );

  // Initial load
  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) {
        void fetchRuns();
      }
    }, 0);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [fetchRuns]);

  // Supabase Realtime channel subscription on wf_execution_runs with debouncing
  useEffect(() => {
    if (!orgId) return;

    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedFetchRuns = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void fetchRuns(true);
      }, 800);
    };

    const supabase = createClient();
    const channel = supabase
      .channel(`wf_execution_runs_telemetry_${orgId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wf_execution_runs',
          filter: `org_id=eq.${orgId}`,
        },
        () => {
          debouncedFetchRuns();
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
  }, [orgId, fetchRuns]);

  // Fallback 6s interval polling when active runs exist (pending, running, requires_action)
  const hasActiveRuns = useMemo(() => {
    return runs.some(
      (r) => r.status === 'pending' || r.status === 'running' || r.status === 'requires_action'
    );
  }, [runs]);

  useEffect(() => {
    if (!hasActiveRuns || !orgId) return;

    const interval = setInterval(() => {
      void fetchRuns(true);
    }, 6000);

    return () => clearInterval(interval);
  }, [hasActiveRuns, orgId, fetchRuns]);

  // Manual refresh handler
  const handleManualRefresh = async () => {
    setIsRefreshingLocal(true);
    await Promise.all([fetchRuns(false), refreshDashboard()]);
  };

  // Stop active run handler
  const handleStopRun = async (runId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setStoppingRunId(runId);
    try {
      const ok = await stopActiveRun(runId);
      if (ok) {
        // Optimistic local update
        setRuns((prev) =>
          prev.map((r) => (r.id === runId ? { ...r, status: 'cancelled' } : r))
        );
      }
    } finally {
      setStoppingRunId(null);
    }
  };

  // Copy ID to clipboard
  const handleCopyId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator?.clipboard) {
      void navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  // 2FA action required runs
  const actionRuns = useMemo(() => {
    return runs.filter((r) => r.status === 'requires_action');
  }, [runs]);

  // Filtered runs list based on pill and search query
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      // Filter pill logic
      if (statusFilter === 'active') {
        if (!['pending', 'running', 'requires_action'].includes(run.status)) {
          return false;
        }
      } else if (statusFilter === 'requires_action') {
        if (run.status !== 'requires_action') return false;
      } else if (statusFilter === 'completed') {
        if (run.status !== 'completed') return false;
      } else if (statusFilter === 'failed') {
        if (!['failed', 'cancelled'].includes(run.status)) return false;
      }

      // Search query logic
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const wfName = (run.wf_workflows?.name || run.workflowName || '').toLowerCase();
        const wfId = (run.workflow_id || '').toLowerCase();
        const runId = (run.id || '').toLowerCase();
        if (!wfName.includes(q) && !wfId.includes(q) && !runId.includes(q)) {
          return false;
        }
      }

      return true;
    });
  }, [runs, statusFilter, searchQuery]);

  // Aggregate metrics
  const stats = useMemo(() => {
    const total = runs.length;
    const active = runs.filter((r) =>
      ['pending', 'running', 'requires_action'].includes(r.status)
    ).length;
    const needs2fa = runs.filter((r) => r.status === 'requires_action').length;
    const completed = runs.filter((r) => r.status === 'completed').length;
    const failed = runs.filter((r) => ['failed', 'cancelled'].includes(r.status)).length;
    const totalFiles = runs.reduce((acc, r) => acc + (r.items_downloaded || 0), 0);
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, active, needs2fa, completed, failed, totalFiles, successRate };
  }, [runs]);

  // Convert run to DrawerRunItem and open drawer
  const handleOpenRun = (run: ExecutionRunItem) => {
    const drawerItem: DrawerRunItem = {
      id: run.id,
      workflow_id: run.workflow_id,
      workflowName: run.wf_workflows?.name || run.workflowName,
      wf_workflows: run.wf_workflows || undefined,
      status: run.status,
      total_items_discovered: run.total_items_discovered,
      items_discovered: run.total_items_discovered,
      items_processed: run.items_processed,
      items_downloaded: run.items_downloaded,
      started_at: run.started_at,
      completed_at: run.completed_at,
      error_summary: run.error_summary,
      duration: formatDuration(run.started_at, run.completed_at),
    };
    openRunDetails(drawerItem);
  };

  return (
    <div className="min-h-full space-y-7 pb-12 text-slate-100">
      {/* Page Header */}
      <div className="flex items-start gap-5">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="flex items-center gap-3 text-[27px] font-bold tracking-tight text-white">
              <span className="grid h-[43px] w-[43px] place-items-center rounded-[13px] border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300"><Layers className="h-[22px] w-[22px]" /></span>
              <span>Run history</span>
            </h1>
            {hasActiveRuns && (
              <span className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border border-blue-400/20 bg-blue-500/[0.08] px-3 py-2 text-xs text-blue-300">
                <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-blue-400" />
                Live updates
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-slate-400">
            Monitor executions and investigate failures.
          </p>
        </div>


      </div>

      {/* 90-Second Human-in-the-Loop 2FA Challenge Recovery Banner */}
      {actionRuns.length > 0 && (
        <TwoFactorBanner
          activeActionRuns={actionRuns.map((r) => ({
            id: r.id,
            workflowName: r.wf_workflows?.name || r.workflowName || r.workflow_id,
            wf_workflows: r.wf_workflows || undefined,
            error_summary: r.error_summary,
            started_at: r.started_at,
          }))}
          onSelectRun={(selectedActionRun) => {
            const fullRun = runs.find((r) => r.id === selectedActionRun.id);
            if (fullRun) {
              handleOpenRun(fullRun);
            }
          }}
        />
      )}

      {/* KPI overview */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Run statistics">
        <article className="group min-h-[132px] rounded-2xl border border-white/[0.09] bg-gradient-to-br from-slate-900/95 to-[#0a0f1b] p-5 transition hover:-translate-y-0.5 hover:border-cyan-400/25">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[1px] text-slate-400">Total runs</span>
            <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-cyan-400/[0.09] text-cyan-300"><Layers className="h-[17px] w-[17px]" /></span>
          </div>
          <div className="mt-[13px] text-[29px] font-bold leading-none tracking-tight text-white">{isLoading ? '—' : stats.total}</div>
          <p className="mt-2 text-xs text-slate-500">All recorded executions</p>
        </article>

        <article className="group min-h-[132px] rounded-2xl border border-white/[0.09] bg-gradient-to-br from-slate-900/95 to-[#0a0f1b] p-5 transition hover:-translate-y-0.5 hover:border-blue-400/25">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[1px] text-slate-400">In progress</span>
            <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-blue-400/[0.09] text-blue-300"><Loader2 className={'h-[17px] w-[17px] ' + (stats.active > 0 ? 'animate-spin' : '')} /></span>
          </div>
          <div className="mt-[13px] text-[29px] font-bold leading-none tracking-tight text-white">{isLoading ? '—' : stats.active}</div>
          <p className="mt-2 text-xs text-slate-500">Running or awaiting attention</p>
        </article>

        <article className="group min-h-[132px] rounded-2xl border border-white/[0.09] bg-gradient-to-br from-slate-900/95 to-[#0a0f1b] p-5 transition hover:-translate-y-0.5 hover:border-emerald-400/25">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[1px] text-slate-400">Files downloaded</span>
            <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-emerald-400/[0.09] text-emerald-300"><Download className="h-[17px] w-[17px]" /></span>
          </div>
          <div className="mt-[13px] text-[29px] font-bold leading-none tracking-tight text-white">{isLoading ? '—' : stats.totalFiles}</div>
          <p className="mt-2 text-xs text-slate-500">Across all executions</p>
        </article>
      </section>

      {/* Control Bar: Filters & Search */}
      <div className="mb-4 flex flex-col justify-between gap-4 rounded-[15px] border border-white/[0.09] bg-slate-900/70 p-4 backdrop-blur-md xl:flex-row xl:items-center">
        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 xl:pb-0">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
              statusFilter === 'all'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/25'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80 hover:text-white border border-white/5'
            }`}
          >
            All ({runs.length})
          </button>

          <button
            onClick={() => setStatusFilter('active')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
              statusFilter === 'active'
                ? 'bg-blue-500 text-slate-950 shadow-md shadow-blue-500/25'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80 hover:text-white border border-white/5'
            }`}
          >
            {stats.active > 0 && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />}
            Active ({stats.active})
          </button>

          <button
            onClick={() => setStatusFilter('requires_action')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
              statusFilter === 'requires_action'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/25'
                : stats.needs2fa > 0
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80 hover:text-white border border-white/5'
            }`}
          >
            {stats.needs2fa > 0 && <ShieldAlert className="h-3 w-3 text-amber-400" />}
            Needs attention ({stats.needs2fa})
          </button>

          <button
            onClick={() => setStatusFilter('completed')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
              statusFilter === 'completed'
                ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/25'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80 hover:text-white border border-white/5'
            }`}
          >
            Completed ({stats.completed})
          </button>

          <button
            onClick={() => setStatusFilter('failed')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
              statusFilter === 'failed'
                ? 'bg-rose-500 text-slate-950 shadow-md shadow-rose-500/25'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80 hover:text-white border border-white/5'
            }`}
          >
            Failed ({stats.failed})
          </button>
        </div>

        {/* Search Input */}
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search workflow or run ID..."
            className="h-[39px] w-full rounded-[10px] border border-white/[0.10] bg-[#080e1a] py-2 pl-[38px] pr-10 text-xs text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/[0.08]"
          />
          {searchQuery ? (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white rounded-md cursor-pointer"
              title="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 pointer-events-none">
              <kbd className="px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 bg-slate-900 border border-slate-700 rounded shadow-inner">
                ⌘K
              </kbd>
            </div>
          )}
        </div>
      </div>

      {/* Fetch Error Notice */}
      {fetchError && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
            <span>{fetchError}</span>
          </div>
          <button
            onClick={() => fetchRuns(false)}
            className="text-xs font-semibold text-rose-200 hover:underline cursor-pointer"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Telemetry Table Container */}
      <div className="overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0c111e]/95 shadow-xl">
        {isLoading ? (
          <div className="p-16 flex flex-col items-center justify-center gap-4 text-slate-400">
            <RobotAvatar size="medium" state="running" />
            <div className="flex items-center gap-2 text-sm text-cyan-400 font-medium">
              <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
              <span>Loading run history...</span>
            </div>
          </div>
        ) : runs.length === 0 ? (
          /* Empty State: 0 Total Runs */
          <div className="p-16 text-center max-w-md mx-auto flex flex-col items-center">
            <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4 shadow-lg shadow-cyan-500/10">
              <Play className="h-7 w-7 fill-cyan-400/20 stroke-cyan-400" />
            </div>
            <h3 className="text-lg font-bold text-white">No runs yet</h3>
            <p className="text-sm text-slate-400 mt-1.5 mb-6 leading-relaxed">
              Your workflow runs will appear here once an execution starts.
            </p>
            <Link
              href="/dashboard/workflows"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-semibold text-sm shadow-lg shadow-cyan-500/25 transition-all cursor-pointer"
            >
              <Play className="h-4 w-4 fill-slate-950" />
              <span>Go to Workflows</span>
            </Link>
            <Link
              href="/dashboard/getting-started"
              className="mt-3 text-xs font-medium text-slate-400 transition-colors hover:text-cyan-300"
            >
              First time here? Read the getting-started guide
            </Link>
          </div>
        ) : filteredRuns.length === 0 ? (
          /* Empty State: 0 Search / Filter Results */
          <div className="p-16 text-center max-w-md mx-auto flex flex-col items-center">
            <div className="w-14 h-14 rounded-2xl bg-slate-800/80 border border-white/10 flex items-center justify-center text-slate-400 mb-4">
              <Search className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white">No matching runs</h3>
            <p className="text-sm text-slate-400 mt-1 mb-5">
              No runs match this filter: &ldquo;{statusFilter}&rdquo;
              {searchQuery ? ` and search &ldquo;${searchQuery}&rdquo;` : ''}.
            </p>
            <button
              onClick={() => {
                setStatusFilter('all');
                setSearchQuery('');
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-white/10 transition-colors cursor-pointer"
            >
              <RotateCw className="h-3.5 w-3.5 text-cyan-400" />
              <span>Reset Filters</span>
            </button>
          </div>
        ) : (
          /* Main Telemetry Table */
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] border-collapse text-left text-sm text-slate-300">
              <thead className="bg-slate-950/55 text-[10px] uppercase tracking-[0.9px] font-bold text-slate-500 border-b border-white/[0.09] select-none">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-5 py-4">Status</th>
                  <th scope="col" className="whitespace-nowrap px-5 py-4">Workflow</th>
                  <th scope="col" className="whitespace-nowrap px-5 py-4">Progress</th>
                  <th scope="col" className="whitespace-nowrap px-5 py-4">Files downloaded</th>
                  <th scope="col" className="whitespace-nowrap px-5 py-4">Duration / Started</th>
                  <th scope="col" className="whitespace-nowrap px-5 py-4">Result</th>
                  <th scope="col" className="whitespace-nowrap px-5 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {filteredRuns.map((run) => {
                  const isActive =
                    run.status === 'pending' ||
                    run.status === 'running' ||
                    run.status === 'requires_action';
                  const workflowDisplayName =
                    run.wf_workflows?.name || run.workflowName || run.workflow_id;
                  const isStoppingThisRun = stoppingRunId === run.id;
                  const isCopied = copiedId === run.id;

                  // Progress percentage
                  const processedCount = run.items_processed || 0;
                  const discoveredCount = run.total_items_discovered || 0;
                  const progressPct =
                    discoveredCount > 0
                      ? Math.min(100, Math.round((processedCount / discoveredCount) * 100))
                      : 0;

                  return (
                    <tr
                      key={run.id}
                      onClick={() => handleOpenRun(run)}
                      className={`group hover:bg-cyan-500/[0.03] transition-colors cursor-pointer ${
                        isActive ? 'bg-cyan-500/[0.015]' : ''
                      }`}
                    >
                      {/* Column 1: Status */}
                      <td className="px-5 py-[17px] whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={run.status} />
                        </div>
                      </td>

                      {/* Column 2: Workflow Name & Run ID */}
                      <td className="px-5 py-[17px]">
                        <div className="flex flex-col">
                          <span className="font-semibold text-white group-hover:text-cyan-300 transition-colors">
                            {workflowDisplayName}
                          </span>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-xs text-slate-500 font-mono">
                              #{run.id.slice(0, 8)}
                            </span>
                            <button
                              onClick={(e) => handleCopyId(run.id, e)}
                              className="text-slate-500 hover:text-slate-300 p-0.5 rounded transition cursor-pointer"
                              title="Copy full Run UUID"
                            >
                              {isCopied ? (
                                <Check className="h-3 w-3 text-emerald-400" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                            {run.error_summary && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] text-rose-400/90 truncate max-w-[200px]"
                                title={run.error_summary}
                              >
                                • {run.error_summary}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Column 3: Discovered / Processed Items */}
                      <td className="px-5 py-[17px] whitespace-nowrap">
                        <div className="flex flex-col gap-1.5">
                          <span className="text-xs font-mono font-medium text-slate-200">
                            {processedCount} / {discoveredCount} items
                          </span>
                          {discoveredCount > 0 && (
                            <div className="w-28 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${
                                  run.status === 'completed'
                                    ? 'bg-emerald-500'
                                    : run.status === 'failed'
                                    ? 'bg-rose-500'
                                    : 'bg-cyan-400'
                                }`}
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Column 4: Invoices Downloaded */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div
                            className={`p-1.5 rounded-lg border ${
                              (run.items_downloaded || 0) > 0
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : 'bg-slate-800 text-slate-500 border-slate-700/60'
                            }`}
                          >
                            <FileText className="h-3.5 w-3.5" />
                          </div>
                          <span
                            className={`text-xs font-medium font-mono ${
                              (run.items_downloaded || 0) > 0
                                ? 'text-emerald-300 font-semibold'
                                : 'text-slate-400'
                            }`}
                          >
                            {run.items_downloaded || 0} files
                          </span>
                        </div>
                      </td>

                      {/* Column 5: Duration / Started */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-1.5 text-xs font-mono text-slate-200 font-medium">
                            <Clock className="h-3 w-3 text-cyan-400 shrink-0" />
                            <span>
                              {formatDuration(run.started_at, run.completed_at)}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 mt-0.5">
                            {formatRelativeTime(run.started_at)}
                          </span>
                        </div>
                      </td>

                      {/* Result summary */}
                      <td className="px-5 py-[17px]">
                        <span
                          className={`block max-w-[220px] truncate text-[11px] ${
                            run.status === 'completed'
                              ? 'text-emerald-300'
                              : run.status === 'requires_action'
                              ? 'text-amber-300'
                              : run.status === 'failed' || run.status === 'cancelled'
                              ? 'text-rose-300'
                              : 'text-slate-400'
                          }`}
                          title={run.error_summary || undefined}
                        >
                          {run.error_summary ||
                            (run.status === 'completed'
                              ? 'Completed successfully'
                              : run.status === 'requires_action'
                              ? 'Verification required'
                              : run.status === 'failed'
                              ? 'Execution failed'
                              : run.status === 'cancelled'
                              ? 'Run cancelled'
                              : run.status === 'pending'
                              ? 'Queued for execution'
                              : 'Processing items')}
                        </span>
                      </td>

                      {/* Column 7: Actions */}
                      <td className="px-5 py-[17px] whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-2">
                          {isActive ? (
                            <button
                              onClick={(e) => handleStopRun(run.id, e)}
                              disabled={isStoppingThisRun}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-xs font-semibold border border-rose-500/40 transition-colors shadow-sm disabled:opacity-50 cursor-pointer"
                              title="Stop active execution run"
                            >
                              {isStoppingThisRun ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-400" />
                              ) : (
                                <Square className="h-3 w-3 fill-rose-400 stroke-rose-400" />
                              )}
                              <span>Stop Run</span>
                            </button>
                          ) : (
                            <div className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 group-hover:text-cyan-400 transition-colors">
                              <span>Inspect</span>
                              <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Table Footer Telemetry Stats */}
        {!isLoading && runs.length > 0 && (
          <div className="flex flex-col justify-between gap-2 border-t border-white/[0.06] bg-slate-950/25 px-5 py-3 text-[11px] text-slate-400 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <span>
                Showing <strong className="text-white">{filteredRuns.length}</strong> of{' '}
                <strong className="text-white">{runs.length}</strong> runs
              </span>
              {hasActiveRuns && (
                <span className="text-cyan-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                  Auto-syncing every 3s
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 text-slate-500 font-mono text-[11px]">
              <span className="flex items-center gap-1">
                <Sparkles className="h-3 w-3 text-cyan-400" />
                ReFlow CDP Engine
              </span>
              <span>•</span>
              <span>Supabase Realtime Live</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
