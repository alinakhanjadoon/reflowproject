'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Play,
  Plus,
  Search,
  LayoutGrid,
  List,
  RotateCw,
  Layers,
  Globe,
  Clock,
  Trash2,
  MoreHorizontal,
  Workflow as WorkflowIcon,
  AlertTriangle,
  X,
  Loader2,
  SlidersHorizontal
} from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { ExecutionPreflightModal } from '@/components/dashboard/ExecutionPreflightModal';
import { CreatePortalModal } from '@/components/dashboard/CreatePortalModal';
import { RobotAvatar } from '@/components/dashboard/RobotAvatar';
import { Workflow, ExecutionRun, RunStatus } from '@/lib/types/database';
import { createClient } from '@/lib/supabase/client';

type ViewMode = 'grid' | 'list';
type StatusFilter = 'all' | 'running' | 'idle';
type SortOption = 'recent' | 'name_asc' | 'name_desc' | 'steps_desc';

const VIEW_MODE_STORAGE_KEY = 'wf_saas_workflow_view_mode';

function extractDomain(wf: Workflow): string {
  const urlCandidate =
    wf.portal_url ||
    (typeof wf.workflow_definition?.start_url === 'string'
      ? wf.workflow_definition.start_url
      : '');

  if (!urlCandidate || urlCandidate === 'about:blank') return 'custom-portal';

  try {
    const raw =
      urlCandidate.startsWith('http://') || urlCandidate.startsWith('https://')
        ? urlCandidate
        : `https://${urlCandidate}`;
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '');
    return host || 'custom-portal';
  } catch {
    return urlCandidate
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0] || 'custom-portal';
  }
}

function formatRelativeTime(dateInput?: string | null): string {
  if (!dateInput) return 'Never run';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return 'Never run';

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function WorkflowsPage() {
  const { orgId, openRunDetails, refreshDashboard } = useDashboard();

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeRuns, setActiveRuns] = useState<ExecutionRun[]>([]);
  const [latestRuns, setLatestRuns] = useState<Record<string, ExecutionRun>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingLocal, setIsRefreshingLocal] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // View & Filter States
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('recent');

  // Modal States
  const [preflightWorkflow, setPreflightWorkflow] = useState<Workflow | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Delete Confirmation State
  const [workflowToDelete, setWorkflowToDelete] = useState<Workflow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Initialize View Mode from LocalStorage
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
        if (saved === 'grid' || saved === 'list') {
          setViewMode(saved);
        }
      } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const handleSetViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {}
  };

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

  // Fetch active runs and latest runs telemetry
  const loadRuns = useCallback(async () => {
    try {
      const allRunsRes = await fetch('/api/v1/runs').catch(() => null);
      const allRunsData = allRunsRes && allRunsRes.ok ? await allRunsRes.json() : { runs: [] };
      const runsList: ExecutionRun[] = Array.isArray(allRunsData.runs) ? allRunsData.runs : [];

      const allActive: ExecutionRun[] = runsList.filter(r => ['pending', 'running', 'requires_action'].includes(r.status));
      setActiveRuns(allActive);

      const latestMap: Record<string, ExecutionRun> = {};
      for (const r of runsList) {
        if (!latestMap[r.workflow_id]) {
          latestMap[r.workflow_id] = r;
        }
      }
      setLatestRuns(latestMap);
    } catch {
      // Non-fatal telemetry refresh error
    }
  }, [orgId]);

  // Fetch workflows catalog
  const loadWorkflows = useCallback(async () => {
    setFetchError(null);
    try {
      const url = orgId ? `/api/v1/workflows?org_id=${encodeURIComponent(orgId)}` : '/api/v1/workflows';
      const wfRes = await fetch(url);
      if (!wfRes.ok) {
        const errJson = await wfRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to fetch workflows');
      }

      const wfData = await wfRes.json();
      setWorkflows(Array.isArray(wfData.workflows) ? wfData.workflows : []);
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load workflow data');
    } finally {
      setIsLoading(false);
      setIsRefreshingLocal(false);
    }
  }, [orgId]);

  // Fetch workflows and telemetry together for initial mount or manual refresh
  const loadData = useCallback(async () => {
    await Promise.all([loadWorkflows(), loadRuns()]);
  }, [loadWorkflows, loadRuns]);

  // Lazy fetch complete workflow when opening execution preflight modal
  const handleStartRun = useCallback(async (wf: Workflow) => {
    const def = wf.workflow_definition as Record<string, unknown> | undefined;
    if (Array.isArray(def?.steps) && def.steps.length > 0) {
      setPreflightWorkflow(wf);
      return;
    }

    try {
      const res = await fetch(`/api/v1/workflows?id=${encodeURIComponent(wf.id)}`);
      if (res.ok) {
        const data = await res.json();
        setPreflightWorkflow(data.workflow || wf);
        return;
      }
    } catch {
      // Fallback
    }
    setPreflightWorkflow(wf);
  }, []);

  // Initial load
  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) {
        void loadData();
      }
    }, 0);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [loadData]);

  // Real-time Supabase listener on workflows and active execution runs
  useEffect(() => {
    if (!orgId) return;

    const supabase = createClient();
    const channel = supabase
      .channel('wf_workflows_realtime_sync')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wf_workflows',
          filter: `org_id=eq.${orgId}`,
        },
        () => {
          void loadWorkflows();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wf_execution_runs',
          filter: `org_id=eq.${orgId}`,
        },
        () => {
          void loadRuns();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [orgId, loadWorkflows, loadRuns]);

  // Auto-refresh when tab gains focus (e.g. returning after recording in Chrome)
  useEffect(() => {
    const handleFocus = () => {
      void loadWorkflows();
      void loadRuns();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [loadWorkflows, loadRuns]);

  const handleManualRefresh = async () => {
    setIsRefreshingLocal(true);
    await Promise.all([loadData(), refreshDashboard()]);
  };

  // Delete Workflow Handlers
  const handleConfirmDelete = async () => {
    if (!workflowToDelete) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/v1/workflows/${workflowToDelete.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to delete workflow');
      }

      setWorkflows((prev) => prev.filter((w) => w.id !== workflowToDelete.id));
      setWorkflowToDelete(null);
      await refreshDashboard();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete workflow');
    } finally {
      setIsDeleting(false);
    }
  };

  // Card click opens the slide-over RunDetailsDrawer
  const handleCardClick = (wf: Workflow) => {
    const activeForWf = activeRuns.filter((r) => r.workflow_id === wf.id);
    const targetRun = activeForWf[0] || latestRuns[wf.id];

    if (targetRun) {
      openRunDetails({
        id: targetRun.id,
        workflow_id: wf.id,
        workflowName: wf.name,
        wf_workflows: { name: wf.name },
        status: targetRun.status,
        total_items_discovered: targetRun.total_items_discovered,
        items_discovered: targetRun.total_items_discovered,
        items_processed: targetRun.items_processed,
        items_downloaded: targetRun.items_downloaded,
        started_at: targetRun.started_at,
        completed_at: targetRun.completed_at,
        error_summary: targetRun.error_summary,
      });
    } else {
      openRunDetails({
        id: '',
        workflow_id: wf.id,
        workflowName: wf.name,
        wf_workflows: { name: wf.name },
        status: 'idle',
        total_items_discovered: 0,
        items_discovered: 0,
        items_processed: 0,
        items_downloaded: 0,
      });
    }
  };

  // Filter and Sort Workflows
  const filteredWorkflows = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();

    return workflows
      .filter((wf) => {
        const domain = extractDomain(wf).toLowerCase();
        const name = (wf.name || '').toLowerCase();
        const description = (
          (typeof wf.workflow_definition?.description === 'string'
            ? wf.workflow_definition.description
            : '') ||
          (typeof wf.workflow_definition?.target_folder === 'string'
            ? wf.workflow_definition.target_folder
            : '') ||
          ''
        ).toLowerCase();

        const matchesSearch =
          !q ||
          name.includes(q) ||
          domain.includes(q) ||
          description.includes(q) ||
          (wf.portal_url || '').toLowerCase().includes(q);

        if (!matchesSearch) return false;

        const hasActiveRun = activeRuns.some((r) => r.workflow_id === wf.id);
        if (statusFilter === 'running' && !hasActiveRun) return false;
        if (statusFilter === 'idle' && hasActiveRun) return false;

        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'name_asc') {
          return a.name.localeCompare(b.name);
        }
        if (sortBy === 'name_desc') {
          return b.name.localeCompare(a.name);
        }
        if (sortBy === 'steps_desc') {
          const aSteps = Array.isArray(a.workflow_definition?.steps)
            ? a.workflow_definition.steps.length
            : 0;
          const bSteps = Array.isArray(b.workflow_definition?.steps)
            ? b.workflow_definition.steps.length
            : 0;
          return bSteps - aSteps;
        }
        // Default: 'recent' created_at desc
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [workflows, searchQuery, statusFilter, sortBy, activeRuns]);

  return (
    <div className="space-y-6 pb-12">
      {/* Top Header Hero */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-6">
        <div className="flex items-center gap-3.5">
          <RobotAvatar size="badge" state={activeRuns.length > 0 ? 'running' : 'idle'} />
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">
                Workflows
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
              Manage and run your automations.
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2.5">
          {/* Refresh Button */}
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={isLoading || isRefreshingLocal}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title="Refresh workflows"
            aria-label="Refresh workflows"
          >
            <RotateCw
              className={`h-3.5 w-3.5 ${isRefreshingLocal ? 'animate-spin text-cyan-400' : ''}`}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          {/* Create Workflow CTA */}
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            data-tour="wf-create"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs sm:text-sm shadow-sm transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4 stroke-[2.5]" />
            <span>Create Workflow</span>
          </button>
        </div>
      </div>

      {/* Streamlined Toolbar Row */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-slate-900/60 border border-slate-800/80 p-3 rounded-2xl backdrop-blur-md" data-tour="wf-toolbar">
        {/* Left: Search & Filter Controls */}
        <div className="flex flex-1 flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          {/* Instant Search with Ctrl+K shortcut */}
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search workflows by name or domain..."
              className="w-full pl-9 pr-16 py-2 bg-slate-950/70 border border-slate-800 rounded-xl text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 transition-all"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <kbd className="hidden sm:inline-flex absolute right-2.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 bg-slate-900 border border-slate-800 rounded shadow-sm">
                Ctrl K
              </kbd>
            )}
          </div>

          <details className="relative">
            <summary className="list-none inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-800 bg-slate-950/70 text-xs text-slate-300 hover:bg-slate-900 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Filter &amp; sort</span>
              {(statusFilter !== 'all' || sortBy !== 'recent') && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" aria-label="Custom filters active" />}
            </summary>
            <div className="absolute left-0 top-full mt-2 z-30 grid min-w-56 gap-3 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl sm:left-auto sm:right-0">
              <label className="grid gap-1.5 text-xs text-slate-400">
                Status
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-cyan-500/60" aria-label="Filter by execution status">
                  <option value="all">All workflows</option>
                  <option value="running">Running</option>
                  <option value="idle">Not running</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-xs text-slate-400">
                Sort by
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortOption)} className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-cyan-500/60" aria-label="Sort workflows">
                  <option value="recent">Recently created</option>
                  <option value="name_asc">Name (A–Z)</option>
                  <option value="name_desc">Name (Z–A)</option>
                  <option value="steps_desc">Most steps</option>
                </select>
              </label>
            </div>
          </details>
        </div>

        {/* Right: View Mode Toggle */}
        <div className="flex items-center justify-end gap-1.5 self-end md:self-auto border-t md:border-t-0 border-slate-800/60 pt-2 md:pt-0">
          <div className="flex items-center bg-slate-950/80 p-0.5 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => handleSetViewMode('grid')}
              className={`p-1.5 rounded-lg text-xs font-medium transition-all ${
                viewMode === 'grid'
                  ? 'bg-cyan-500/20 text-cyan-400 shadow-sm border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Grid View"
              aria-label="Switch to grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => handleSetViewMode('list')}
              className={`p-1.5 rounded-lg text-xs font-medium transition-all ${
                viewMode === 'list'
                  ? 'bg-cyan-500/20 text-cyan-400 shadow-sm border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="List View"
              aria-label="Switch to list view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Fetch Error Notice */}
      {fetchError && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-400" />
            <span>{fetchError}</span>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 rounded-lg text-rose-200 font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 py-4" data-tour="wf-list">
          {[1, 2, 3, 4, 5, 6].map((idx) => (
            <div
              key={idx}
              className="h-48 rounded-2xl bg-slate-900/40 border border-slate-800/60 animate-pulse p-5 flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <div className="h-5 w-24 bg-slate-800 rounded-md" />
                  <div className="h-5 w-16 bg-slate-800 rounded-full" />
                </div>
                <div className="h-6 w-3/4 bg-slate-800 rounded-md" />
                <div className="h-4 w-1/2 bg-slate-800 rounded-md" />
              </div>
              <div className="flex justify-between items-center pt-4 border-t border-slate-800/40">
                <div className="h-7 w-20 bg-slate-800 rounded-lg" />
                <div className="h-7 w-16 bg-slate-800 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredWorkflows.length === 0 ? (
        /* Empty States */
        <div className="py-16 px-6 text-center rounded-3xl bg-slate-900/40 border border-slate-800/80 backdrop-blur-md flex flex-col items-center justify-center space-y-4" data-tour="wf-list">
          {workflows.length === 0 ? (
            <>
              <RobotAvatar size="medium" state="idle" />
              <div className="max-w-md space-y-2">
                <h3 className="text-base sm:text-lg font-bold text-slate-100">
                  No workflows yet
                </h3>
                <p className="text-xs sm:text-sm text-slate-400">
                  Record a task in Chrome to create your first automation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(true)}
                className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
              >
                <Plus className="h-4 w-4 stroke-[2.5]" />
                <span>Record your first workflow</span>
              </button>
              <p className="text-xs text-slate-500">
                New to ReFlow?{' '}
                <Link
                  href="/dashboard/getting-started"
                  className="font-medium text-cyan-300 hover:underline"
                >
                  Follow the getting-started guide
                </Link>
                .
              </p>
            </>
          ) : (
            <>
              <RobotAvatar size="badge" state="waiting" />
              <div className="max-w-md space-y-1">
                <h3 className="text-sm sm:text-base font-semibold text-slate-200">
                  No workflows found
                </h3>
                <p className="text-xs text-slate-400">
                  Try a different search or clear your filters.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                  setSortBy('recent');
                }}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Reset search & filters
              </button>
            </>
          )}
        </div>
      ) : viewMode === 'grid' ? (
        /* Grid Catalog View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredWorkflows.map((wf) => {
            const domain = extractDomain(wf);
            const activeWfRuns = activeRuns.filter((r) => r.workflow_id === wf.id);
            const hasActiveRun = activeWfRuns.length > 0;
            const requiresActionRun = activeWfRuns.find((r) => r.status === 'requires_action');
            const stepCount = Array.isArray(wf.workflow_definition?.steps)
              ? wf.workflow_definition.steps.length
              : 0;
            const lastRun = latestRuns[wf.id];

            return (
              <div
                key={wf.id}
                className="group relative bg-[#0c101d] hover:bg-[#0f1527] border border-slate-800/80 hover:border-cyan-500/40 rounded-2xl p-5 transition-all duration-200 shadow-lg hover:shadow-cyan-950/20 flex flex-col justify-between"
              >
                <div>
                  {/* Top Badges Row */}
                  <div className="flex items-center justify-between gap-2 mb-3.5">
                    {/* Domain Tag Badge */}
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700/60 text-slate-300 text-xs font-mono font-medium max-w-[170px] truncate">
                      <Globe className="h-3 w-3 text-cyan-400 shrink-0" />
                      <span className="truncate">{domain}</span>
                    </div>

                    {/* Real-time Status Badge */}
                    {hasActiveRun ? (
                      requiresActionRun ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/40 animate-pulse">
                          <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                          <span>Action Required ({activeWfRuns.length} active)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/40 animate-pulse">
                          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                          <span>Running ({activeWfRuns.length} active)</span>
                        </span>
                      )
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800/80 text-slate-400 border border-slate-700/60">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                        <span>Idle</span>
                      </span>
                    )}
                  </div>

                  {/* Workflow Title */}
                  <h3 className="text-base font-semibold line-clamp-1">
                    <Link href={`/dashboard/workflows/${wf.id}/edit`} className="text-slate-100 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 rounded-sm transition-colors" aria-label={`Edit workflow: ${wf.name}`}>
                      {wf.name}
                    </Link>
                  </h3>

                  {/* Feature & Telemetry Badges */}
                  <div className="flex flex-wrap items-center gap-2 mt-3.5 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-slate-300">
                      <Layers className="h-3 w-3 text-indigo-400" />
                      <span>{stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>
                    </span>

                    {lastRun ? (
                      <button type="button" onClick={() => handleCardClick(wf)} className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-cyan-300 ml-auto transition-colors" aria-label={`View latest run for ${wf.name}`}>
                        <Clock className="h-3 w-3" />
                        <span>Last run: {formatRelativeTime(lastRun.started_at)}</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 ml-auto">
                        <Clock className="h-3 w-3" />
                        <span>Never run</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Bottom Action Footer */}
                <div className="mt-5 pt-4 border-t border-slate-800/80 flex items-center justify-between gap-2">
                  {/* Left: Prominent [ Run ] Button */}
                  <button
                    type="button"
                    onClick={() => void handleStartRun(wf)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-colors cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>Run</span>
                  </button>

                  {/* Right Actions: Visual Canvas Link & Delete */}
                  <div className="flex items-center gap-1.5">
                    <details className="relative">
                      <summary className="list-none p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50" aria-label={`More actions for ${wf.name}`} title="More actions">
                        <MoreHorizontal className="h-4 w-4" />
                      </summary>
                      <div className="absolute right-0 bottom-full mb-1 z-20 min-w-36 rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-xl">
                        <button type="button" onClick={() => { setWorkflowToDelete(wf); setDeleteError(null); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-rose-300 hover:bg-rose-500/10">
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete workflow
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* List Catalog View */
        <div className="space-y-3">
          {filteredWorkflows.map((wf) => {
            const domain = extractDomain(wf);
            const activeWfRuns = activeRuns.filter((r) => r.workflow_id === wf.id);
            const hasActiveRun = activeWfRuns.length > 0;
            const requiresActionRun = activeWfRuns.find((r) => r.status === 'requires_action');
            const stepCount = Array.isArray(wf.workflow_definition?.steps)
              ? wf.workflow_definition.steps.length
              : 0;
            const lastRun = latestRuns[wf.id];

            return (
              <div
                key={wf.id}
                className="group bg-[#0c101d] hover:bg-[#0f1527] border border-slate-800/80 hover:border-cyan-500/40 rounded-2xl p-4 sm:px-6 sm:py-4 transition-all duration-200 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                {/* Left Meta & Identity */}
                <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
                  <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-cyan-400 shrink-0 mt-0.5 sm:mt-0">
                    <WorkflowIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm sm:text-base font-semibold truncate">
                        <Link href={`/dashboard/workflows/${wf.id}/edit`} className="text-slate-100 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 rounded-sm transition-colors" aria-label={`Edit workflow: ${wf.name}`}>
                          {wf.name}
                        </Link>
                      </h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-1 font-mono">
                      <span className="truncate max-w-[280px]">{domain}</span>
                      <span className="text-slate-600">•</span>
                      <span>{stepCount} steps</span>
                      <span className="text-slate-600">•</span>
                      {lastRun ? (
                        <button type="button" onClick={() => handleCardClick(wf)} className="hover:text-cyan-300 transition-colors" aria-label={`View latest run for ${wf.name}`}>
                          Last run: {formatRelativeTime(lastRun.started_at)}
                        </button>
                      ) : (
                        <span>Never run</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Center / Status */}
                <div className="flex items-center gap-3 shrink-0">
                  {hasActiveRun ? (
                    requiresActionRun ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/40 animate-pulse">
                        <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                        <span>Action Required ({activeWfRuns.length} active)</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/40 animate-pulse">
                        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                        <span>Running ({activeWfRuns.length} active)</span>
                      </span>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800/80 text-slate-400 border border-slate-700/60">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                      <span>Idle</span>
                    </span>
                  )}
                </div>

                {/* Right Actions */}
                <div className="flex items-center gap-2 shrink-0 border-t md:border-t-0 border-slate-800/60 pt-3 md:pt-0">
                  <button
                    type="button"
                    onClick={() => void handleStartRun(wf)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-colors cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>Run</span>
                  </button>

                  <details className="relative">
                    <summary className="list-none p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50" aria-label={`More actions for ${wf.name}`} title="More actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </summary>
                    <div className="absolute right-0 bottom-full mb-1 z-20 min-w-36 rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-xl">
                      <button type="button" onClick={() => { setWorkflowToDelete(wf); setDeleteError(null); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-rose-300 hover:bg-rose-500/10">
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete workflow
                      </button>
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Execution Preflight Modal */}
      {preflightWorkflow && (
        <ExecutionPreflightModal
          isOpen={preflightWorkflow !== null}
          onClose={() => setPreflightWorkflow(null)}
          workflow={preflightWorkflow}
          onRunDispatched={(dispatchedRun) => {
            setActiveRuns((prev) => [
              {
                id: dispatchedRun.id,
                org_id: orgId || '',
                workflow_id: dispatchedRun.workflow_id || '',
                status: (dispatchedRun.status as RunStatus) || 'pending',
                total_items_discovered: dispatchedRun.total_items_discovered || 0,
                items_processed: dispatchedRun.items_processed || 0,
                items_downloaded: dispatchedRun.items_downloaded || 0,
                started_at: dispatchedRun.started_at || new Date().toISOString(),
              },
              ...prev,
            ]);
            void loadRuns();
          }}
        />
      )}

      {/* Create Portal Modal */}
      {orgId && (
        <CreatePortalModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          orgId={orgId}
          onWorkflowCreated={(newWorkflow) => {
            setWorkflows((prev) => [newWorkflow, ...prev.filter((w) => w.id !== newWorkflow.id)]);
            setIsCreateModalOpen(false);
            void refreshDashboard();
          }}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {workflowToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 text-slate-100 space-y-4">
            <div className="flex items-start gap-3.5">
              <div className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-400 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-100">Delete Workflow</h3>
                <p className="text-xs text-slate-400">
                  Are you sure you want to permanently delete &ldquo;{workflowToDelete.name}&rdquo;?
                  This action cannot be undone and will delete all associated step recipes and historical run records.
                </p>
              </div>
            </div>

            {deleteError && (
              <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
                {deleteError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  setWorkflowToDelete(null);
                  setDeleteError(null);
                }}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-lg shadow-rose-950/40 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Delete Workflow</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
