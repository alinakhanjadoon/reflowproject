'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Cpu,
  Server,
  Activity,
  Check,
  Copy,
  RefreshCw,
  ShieldCheck,
  ExternalLink,
  Clock,
  StopCircle,
  AlertTriangle,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  X,
  HelpCircle,
  Monitor,
  Wifi,
  LoaderCircle
} from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { createClient } from '@/lib/supabase/client';
import { RobotAvatar } from '@/components/dashboard/RobotAvatar';
import { DrawerRunItem } from '@/components/dashboard/RunDetailsDrawer';

interface ConnectedWorker {
  id: string;
  hostname: string;
  label: string;
  token: string;
  platform: string;
  engineVersion: string;
  claimsCount: number;
  status: 'ONLINE' | 'EXECUTING' | 'OFFLINE' | 'REVOKED';
  lastPingAt: string | null;
  activeRun?: DrawerRunItem | null;
  ipAddress?: string;
  cdpActive?: boolean;
}

export default function RunnersPage() {
  const {
    orgId,
    organizationName,
    refreshDashboard,
    openRunDetails,
    stopActiveRun,
  } = useDashboard();

  // Active token state & local overrides
  const [currentToken, setCurrentToken] = useState<string>('');
const [tokenConfigured, setTokenConfigured] = useState<boolean>(false);
  const [isTokenRevoked, setIsTokenRevoked] = useState<boolean>(false);
  const [isTokenMasked, setIsTokenMasked] = useState<boolean>(true);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);

  // Modals state
  const [showRegenModal, setShowRegenModal] = useState<boolean>(false);
  const [showRevokeModal, setShowRevokeModal] = useState<boolean>(false);
  const [showPairingHelp, setShowPairingHelp] = useState<boolean>(false);
  const [pairingCheckState, setPairingCheckState] = useState<'idle' | 'checking' | 'waiting' | 'connected' | 'error'>('idle');
  const [pairingCheckError, setPairingCheckError] = useState<string | null>(null);
  const [workerChecks, setWorkerChecks] = useState<Record<string, { state: 'checking' | 'success' | 'error'; message: string; latencyMs?: number }>>({});
  const [regenConfirmChecked, setRegenConfirmChecked] = useState<boolean>(false);
  const [isRegenerating, setIsRegenerating] = useState<boolean>(false);
  const [isRevoking, setIsRevoking] = useState<boolean>(false);
  const [actionSuccessNotice, setActionSuccessNotice] = useState<string | null>(null);
  const [actionErrorNotice, setActionErrorNotice] = useState<string | null>(null);

  // Workers & Telemetry state
  const [workers, setWorkers] = useState<ConnectedWorker[]>([]);
  const [loadingWorkers, setLoadingWorkers] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [, setActiveRunsMap] = useState<Record<string, DrawerRunItem>>({});
  const [, setTotalClaimsCount] = useState<number>(0);
  const [, setRealtimeConnected] = useState<boolean>(false);

  // Live seconds ticker
  const [now, setNow] = useState<number>(() => Date.now());

  // Keep live seconds ticking every 1,000ms
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // The API returns the server-issued token and the authoritative runner heartbeat.

  // Fetch connected workers and active execution runs
  const fetchWorkersAndRuns = useCallback(async () => {
    if (!orgId) return;

    try {
      const supabase = createClient();

      // 1. Fetch active runs for this organization
      const { data: activeRuns, error: runsError } = await supabase
        .from('wf_execution_runs')
        .select(`
          id,
          org_id,
          workflow_id,
          status,
          total_items_discovered,
          items_processed,
          items_downloaded,
          started_at,
          completed_at,
          error_summary,
          wf_workflows ( name )
        `)
        .eq('org_id', orgId)
        .order('started_at', { ascending: false })
        .limit(20);

      const activeMap: Record<string, DrawerRunItem> = {};
      let runningRun: DrawerRunItem | null = null;
      let claimsCount = 0;

      if (!runsError && activeRuns) {
        claimsCount = activeRuns.length;
        setTotalClaimsCount(claimsCount);

        activeRuns.forEach((r) => {
          const runItem: DrawerRunItem = {
            id: r.id,
            workflow_id: r.workflow_id,
            workflowName: (r.wf_workflows as { name?: string } | null)?.name || 'Automation Workflow',
            status: r.status,
            items_discovered: r.total_items_discovered,
            items_processed: r.items_processed,
            items_downloaded: r.items_downloaded,
            started_at: r.started_at,
            completed_at: r.completed_at,
            error_summary: r.error_summary,
          };
          activeMap[r.id] = runItem;
          if (r.status === 'running' && !runningRun) {
            runningRun = runItem;
          }
        });
        setActiveRunsMap(activeMap);
      }

      // 2. Fetch registered runners and live heartbeat from /api/v1/runners
      let apiRunners: ConnectedWorker[] = [];


      try {
        const res = await fetch('/api/v1/runners', { cache: 'no-store', credentials: 'same-origin' });
        if (res.ok) {
          const json = await res.json();
          if (json.runners && Array.isArray(json.runners) && json.runners.length > 0) {
            if (json.token_configured === true) setTokenConfigured(true);
            if (typeof json.token_revoked === 'boolean' && !currentToken) setIsTokenRevoked(json.token_revoked);
            apiRunners = json.runners.map((r: { id?: string; hostname?: string; label?: string; platform?: string; engineVersion?: string; status?: string; lastPingAt?: string | null; cdpActive?: boolean }, idx: number) => {
              const lastPingMs = r.lastPingAt ? new Date(r.lastPingAt).getTime() : 0;
              const diffSeconds = lastPingMs > 0 ? (Date.now() - lastPingMs) / 1000 : 999999;
              const isOnline = diffSeconds >= 0 && diffSeconds < 60 && r.status !== 'REVOKED';

              let status: ConnectedWorker['status'] = 'OFFLINE';
              if (r.status === 'REVOKED') {
                status = 'REVOKED';
              } else if (runningRun && isOnline) {
                status = 'EXECUTING';
              } else if (isOnline) {
                status = 'ONLINE';
              }

              return {
                id: r.id || `runner-${idx}`,
                hostname: r.hostname || 'unknown',
                label: r.label || 'Primary Desktop Runner',
                token: '',
                platform: r.platform || 'unknown',
                engineVersion: r.engineVersion || 'unknown',
                claimsCount: Math.max(0, claimsCount),
                status,
                lastPingAt: r.lastPingAt || null,
                activeRun: status === 'EXECUTING' ? runningRun : null,
                cdpActive: r.cdpActive === true,
              };
            });
          }
        }
      } catch (err) {
        console.warn('API runners fetch notice:', err);
      }

      // Direct Supabase database fallback if API route returned no runners
      if (apiRunners.length === 0 && orgId) {
        try {
          const { data: orgDirect } = await supabase
            .from('wf_organizations')
            .select('*')
            .eq('id', orgId)
            .maybeSingle();

          if (orgDirect?.runner_metadata) {
            try {
              const meta = typeof orgDirect.runner_metadata === 'object' && orgDirect.runner_metadata !== null
                ? orgDirect.runner_metadata as Record<string, unknown>
                : JSON.parse(orgDirect.runner_metadata as string);
              const lastPingMs = meta.last_ping_at ? new Date(meta.last_ping_at).getTime() : 0;
              const diffSeconds = lastPingMs > 0 ? (Date.now() - lastPingMs) / 1000 : 999999;
              const isOnline = diffSeconds >= 0 && diffSeconds < 60 && meta.token_revoked !== true;

              let status: ConnectedWorker['status'] = 'OFFLINE';
              if (meta.token_revoked === true) {
                status = 'REVOKED';
              } else if (runningRun && isOnline) {
                status = 'EXECUTING';
              } else if (isOnline) {
                status = 'ONLINE';
              }

              if (meta.token_revoked === true && !currentToken) setIsTokenRevoked(true);
              if (orgDirect.runner_token_hash) setTokenConfigured(true);
              apiRunners = [
                {
                  id: 'runner_primary',
                  hostname: meta.hostname || 'unknown',
                  label: 'Primary Desktop Runner',
                  token: '',
                  platform: meta.platform || 'unknown',
                  engineVersion: meta.version || 'unknown',
                  claimsCount: Math.max(0, claimsCount),
                  status,
                  lastPingAt: meta.last_ping_at || null,
                  activeRun: status === 'EXECUTING' ? runningRun : null,
                  cdpActive: meta.cdp_active === true,
                },
              ];
            } catch {}
          }
        } catch (dbErr) {
          console.warn('Direct DB runners fallback notice:', dbErr);
        }
      }

      if (apiRunners.length > 0) {
        setWorkers(apiRunners);
      } else {
        setWorkers([]);
      }
    } catch (err) {
      console.error('Failed to query workers:', err);
    } finally {
      setLoadingWorkers(false);
      setIsRefreshing(false);
    }
  }, [orgId]);

  // Initial load and periodic refresh ticker (every 5 seconds)
  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) {
        void fetchWorkersAndRuns();
      }
    }, 0);

    const poller = setInterval(() => {
      if (isMounted) {
        void fetchWorkersAndRuns();
      }
    }, 5000);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      clearInterval(poller);
    };
  }, [fetchWorkersAndRuns]);

  // Supabase Realtime Telemetry Stream
  useEffect(() => {
    if (!orgId) return;

    const supabase = createClient();

    // Channel 1: Listen to active execution run state changes
    const runsChannel = supabase
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
          void fetchWorkersAndRuns();
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeConnected(true);
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          setRealtimeConnected(false);
        }
      });

    // Channel 2: Listen to organization heartbeat / runner metadata updates
    let orgChannel: ReturnType<typeof supabase.channel> | null = null;
    try {
      orgChannel = supabase
        .channel(`wf_organizations_telemetry_${orgId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'wf_organizations',
            filter: `id=eq.${orgId}`,
          },
          () => {
            void fetchWorkersAndRuns();
          }
        )
        .subscribe();
    } catch {
      // Non-fatal if publication does not support
    }

    return () => {
      setRealtimeConnected(false);
      void supabase.removeChannel(runsChannel);
      if (orgChannel) {
        void supabase.removeChannel(orgChannel);
      }
    };
  }, [orgId, fetchWorkersAndRuns]);

  // Refresh handler
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshDashboard();
    await fetchWorkersAndRuns();
    setIsRefreshing(false);
  };

  const checkPairingConnection = useCallback(async (): Promise<boolean> => {
    setPairingCheckState('checking');
    setPairingCheckError(null);
    try {
      const response = await fetch('/api/v1/runners', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('Your session could not verify this workspace. Sign in again, then retry.');
        throw new Error('We couldn’t check your desktop status right now. Your pairing settings haven’t been changed.');
      }
      const payload = await response.json();
      const runners = Array.isArray(payload.runners) ? payload.runners : [];
      const freshWorker = runners.find((runner: { lastPingAt?: string | null; status?: string }) => {
        const timestamp = runner.lastPingAt ? new Date(runner.lastPingAt).getTime() : 0;
        const ageMs = Date.now() - timestamp;
        return timestamp > 0 && ageMs >= 0 && ageMs < 60_000 && runner.status !== 'REVOKED';
      });
      await fetchWorkersAndRuns();
      setPairingCheckState(freshWorker ? 'connected' : 'waiting');
      return Boolean(freshWorker);
    } catch (error) {
      setPairingCheckState('error');
      setPairingCheckError(error instanceof Error ? error.message : 'We couldn’t check your desktop status right now.');
      return false;
    }
  }, [fetchWorkersAndRuns]);

  const checkWorkerStatus = async (workerId: string) => {
    const startedAt = Date.now();
    setWorkerChecks((prev) => ({ ...prev, [workerId]: { state: 'checking', message: 'Checking latest heartbeat…' } }));
    try {
      const response = await fetch('/api/v1/runners', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not retrieve worker status. Try again.');
      const payload = await response.json();
      const list = Array.isArray(payload.runners) ? payload.runners : [];
      const worker = list.find((item: { id?: string }) => item.id === workerId);
      const timestamp = worker?.lastPingAt ? new Date(worker.lastPingAt).getTime() : 0;
      const ageMs = Date.now() - timestamp;
      const latencyMs = Date.now() - startedAt;
      if (worker && timestamp > 0 && ageMs >= 0 && ageMs < 60_000 && worker.status !== 'REVOKED') {
        setWorkerChecks((prev) => ({ ...prev, [workerId]: { state: 'success', message: 'Recent heartbeat confirmed', latencyMs } }));
      } else if (worker?.status === 'REVOKED') {
        setWorkerChecks((prev) => ({ ...prev, [workerId]: { state: 'error', message: 'Pairing token revoked' } }));
      } else {
        setWorkerChecks((prev) => ({ ...prev, [workerId]: { state: 'error', message: 'No recent heartbeat. This checks server status; it does not send a direct network ping.' } }));
      }
      await fetchWorkersAndRuns();
    } catch (error) {
      setWorkerChecks((prev) => ({ ...prev, [workerId]: { state: 'error', message: error instanceof Error ? error.message : 'Could not retrieve worker status.' } }));
    }
  };

  useEffect(() => {
    if (!showPairingHelp) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowPairingHelp(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPairingHelp]);

  useEffect(() => {
    if (!showPairingHelp) return;
    let attempts = 0;
    let inFlight = false;
    const poller = window.setInterval(async () => {
      if (inFlight || attempts >= 12) {
        if (attempts >= 12) window.clearInterval(poller);
        return;
      }
      attempts += 1;
      inFlight = true;
      const connected = await checkPairingConnection();
      inFlight = false;
      if (connected) window.clearInterval(poller);
    }, 5000);
    return () => window.clearInterval(poller);
  }, [showPairingHelp, checkPairingConnection]);

  // 1-Click Copy with feedback
  const copyToClipboard = (text: string) => {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 2500);
    }).catch(() => {
      setActionErrorNotice('Could not copy the token. Check your browser clipboard permissions and try again.');
    });
  };

  // Token Regeneration
  const handleRegenerateToken = async () => {
    if (!orgId || isRegenerating) return;
    setIsRegenerating(true);

    try {
      const res = await fetch('/api/v1/runners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate' }),
      });

      if (!res.ok) throw new Error(`Token rotation failed (${res.status}). Please try again.`);
      const json = await res.json();
      const newToken = typeof json.token === 'string' ? json.token : '';
      if (!newToken) throw new Error('The server did not return a new pairing token. Please try again.');

      setCurrentToken(newToken);
      setIsTokenMasked(false);
      setTokenConfigured(true);
      setIsTokenRevoked(false);
      setShowRegenModal(false);
      setRegenConfirmChecked(false);
      copyToClipboard(newToken);
      setActionSuccessNotice('Pairing token successfully regenerated and copied to clipboard! Paste it into ReFlow Desktop.');
      setTimeout(() => setActionSuccessNotice(null), 6000);

      await refreshDashboard();
      await fetchWorkersAndRuns();
    } catch (err) {
      console.error('Failed to regenerate token:', err);
      setActionErrorNotice(err instanceof Error ? err.message : 'Could not regenerate the token. Please try again.');
      setTimeout(() => setActionErrorNotice(null), 6000);
    } finally {
      setIsRegenerating(false);
    }
  };

  // Token Revocation
  const handleRevokeToken = async () => {
    if (!orgId || isRevoking) return;
    setIsRevoking(true);

    try {
      const res = await fetch('/api/v1/runners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'revoke' }),
      });
      if (!res.ok) throw new Error(`Token revocation failed (${res.status}). Please try again.`);

      setIsTokenRevoked(true);
      setCurrentToken('');
      setTokenConfigured(false);
      setShowRevokeModal(false);
      setActionSuccessNotice('Pairing token revoked. Desktop runners will need a new token to reconnect.');
      setTimeout(() => setActionSuccessNotice(null), 6000);
      setWorkers((prev) => prev.map((worker) => ({ ...worker, status: 'REVOKED', activeRun: null })));
    } catch (err) {
      console.error('Failed to revoke token:', err);
      setActionErrorNotice(err instanceof Error ? err.message : 'Could not revoke the token. Please try again.');
      setTimeout(() => setActionErrorNotice(null), 6000);
    } finally {
      setIsRevoking(false);
    }
  };

  // Stop an active run and surface the outcome (never fail silently)
  const handleStopRun = async (runId: string) => {
    setStoppingRunId(runId);
    try {
      const ok = await stopActiveRun(runId);
      if (ok) {
        setActionSuccessNotice('Run cancellation requested — the worker will stop when it next checks in.');
        setTimeout(() => setActionSuccessNotice(null), 6000);
      } else {
        setActionErrorNotice('Could not cancel the active run. It may still be executing — please retry.');
        setTimeout(() => setActionErrorNotice(null), 6000);
      }
    } finally {
      setStoppingRunId(null);
    }
  };

  // Format live heartbeat counter
  const formatHeartbeat = (isoDate: string | null | undefined, currentNow: number) => {
    if (!isoDate) return 'Awaiting initial ping';
    const lastPingMs = new Date(isoDate).getTime();
    if (isNaN(lastPingMs) || lastPingMs <= 0) return 'Awaiting initial ping';
    const diffSec = Math.max(0, Math.floor((currentNow - lastPingMs) / 1000));
    if (diffSec < 3) return 'Active just now';
    if (diffSec < 60) return `Active ${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Active ${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `Active ${diffHr}h ago`;
  };

  const hasRecentRunnerHeartbeat = workers.some((worker) => worker.status === 'ONLINE' || worker.status === 'EXECUTING');
  return (
    <div className="space-y-6 pb-12">
      {/* Toast Notification Banner */}
      {actionSuccessNotice && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-xl flex items-center justify-between text-xs font-semibold animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span>{actionSuccessNotice}</span>
          </div>
          <button
            onClick={() => setActionSuccessNotice(null)}
            className="text-emerald-400 hover:text-white p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionErrorNotice && (
        <div role="alert" className="bg-rose-500/10 border border-rose-500/30 text-rose-300 px-4 py-3 rounded-xl flex items-center justify-between text-xs font-semibold">
          <span>{actionErrorNotice}</span>
          <button type="button" onClick={() => setActionErrorNotice(null)} className="text-rose-300 hover:text-white p-1" aria-label="Dismiss error"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Page heading */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <RobotAvatar size="badge" state={workers.some((worker) => worker.status === 'EXECUTING') ? 'running' : 'idle'} />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Desktop connection</h1>
            <p className="text-sm text-slate-400 mt-1">Manage pairing and connected desktop workers.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setPairingCheckState('idle'); setPairingCheckError(null); setShowPairingHelp(true); }} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 transition-colors">
            <HelpCircle className="w-4 h-4" /> How to connect
          </button>
          <button type="button" onClick={handleRefresh} disabled={loadingWorkers || isRefreshing} aria-label="Refresh workers" className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 transition-colors">
            <RefreshCw className={`w-4 h-4 ${isRefreshing || loadingWorkers ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>
      {/* Token management */}

      <div className="space-y-6">
        {/* Organization Runner Pairing Token Card */}
        <div id="pairing-token" data-tour="pairing-token" className="bg-[#0c101d] border border-white/10 rounded-2xl p-5 sm:p-6 shadow-xl relative overflow-hidden flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-white tracking-tight">Organization Pairing Token</h2>
                  <p className="text-[11px] text-slate-400">
                    Cryptographic key required to pair local Desktop Runners to {organizationName}
                  </p>
                </div>
              </div>

              <span
                className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${
                  isTokenRevoked && !currentToken
                    ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                }`}
              >
                {isTokenRevoked && !currentToken ? 'REVOKED' : 'ACTIVE'}
              </span>
            </div>

            {/* Token Display & Interactive Actions */}
            <div className="space-y-2">
              <div className="bg-slate-950/80 border border-white/10 rounded-xl p-3 flex items-center justify-between gap-3 font-mono text-xs">
                <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto">
                  <Key className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                  {currentToken ? (
                    <input
                      type={isTokenMasked ? 'password' : 'text'}
                      readOnly
                      value={currentToken}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                      className={`bg-transparent border-0 font-mono text-xs w-full outline-none select-all ${
                        isTokenRevoked && !currentToken ? 'line-through text-slate-500' : 'text-cyan-300'
                      }`}
                      aria-label="Runner pairing token"
                    />
                  ) : (
                    <span className="text-slate-400 text-xs">
                      {isTokenRevoked
                        ? 'Token revoked'
                        : tokenConfigured
                          ? '•••••••••••••••• (hidden — regenerate to reveal)'
                          : 'No token issued yet — regenerate to create one'}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {currentToken && (
                    <button
                      type="button"
                      onClick={() => setIsTokenMasked(!isTokenMasked)}
                      className="p-1.5 hover:bg-white/5 text-slate-400 hover:text-slate-200 rounded-lg transition-colors"
                      title={isTokenMasked ? 'Reveal Token' : 'Mask Token'}
                    >
                      {isTokenMasked ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => copyToClipboard(currentToken)}
                    disabled={!currentToken}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-lg text-xs font-sans font-semibold border border-cyan-400/30 transition-all disabled:opacity-50"
                    title="Copy secret pairing token"
                  >
                    {copiedToken ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Token</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Token Lifecycle Controls */}
              <div className="flex items-center justify-between pt-1 text-[11px]">
                <span className="text-slate-500">
                  Authorized for: <strong className="text-slate-300">{organizationName}</strong>
                </span>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowRegenModal(true)}
                    className="text-cyan-400 hover:text-cyan-300 font-semibold hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Regenerate Token</span>
                  </button>

                  {!isTokenRevoked && (
                    <button
                      onClick={() => setShowRevokeModal(true)}
                      className="text-rose-400 hover:text-rose-300 font-semibold hover:underline flex items-center gap-1"
                    >
                      <XCircle className="w-3 h-3" />
                      <span>Revoke</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed border-t border-white/5 pt-3">
              <strong className="text-slate-300">Security Invariant:</strong> Any worker paired with this key can claim execution runs and upload artifacts. Store safely and rotate if compromised.
            </p>
          </div>

        </div>
      </div>

      {/* Connected Workers Section & Telemetry Cards */}
      <div className="bg-[#0c101d] border border-white/10 rounded-2xl p-6 shadow-xl space-y-4" data-tour="worker-status">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <Server className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-white tracking-tight">Connected workers</h2>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-white/5">
              {workers.length} registered
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs font-semibold">
            <button type="button" onClick={() => { void Promise.all(workers.map((worker) => checkWorkerStatus(worker.id))); }} disabled={loadingWorkers || workers.length === 0 || workers.some((worker) => workerChecks[worker.id]?.state === 'checking')} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50">
              <Wifi className="w-3.5 h-3.5" /> Check all
            </button>
            <span className="text-slate-400">Status:</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] ${
                hasRecentRunnerHeartbeat
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-slate-800 text-slate-400 border border-white/5'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  hasRecentRunnerHeartbeat ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                }`}
              />
              {hasRecentRunnerHeartbeat ? 'Daemon Operational' : 'Awaiting Connection'}
            </span>
          </div>
        </div>

        {/* Workers List / Cards */}
        {loadingWorkers ? (
          <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-400">
            <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
            <span className="text-xs">Detecting active workers &amp; runner telemetry...</span>
          </div>
        ) : workers.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-white/10 flex items-center justify-center text-slate-500">
              <Cpu className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">No Desktop Runners Connected Yet</h3>
              <p className="text-xs text-slate-400 max-w-sm mt-1">
No desktop has checked in recently. Open ReFlow Desktop, paste the workspace token, and start the runner. <button type="button" onClick={() => setShowPairingHelp(true)} className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2">View pairing help</button>.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {workers.map((worker) => {
              const isExecuting = worker.status === 'EXECUTING';
              const isOnline = worker.status === 'ONLINE' || isExecuting;

              return (
                <div
                  key={worker.id}
                  className={`bg-slate-950/70 border rounded-xl p-5 transition-all space-y-4 relative overflow-hidden ${
                    isExecuting
                      ? 'border-cyan-500/40 shadow-lg shadow-cyan-500/10'
                      : isOnline
                      ? 'border-white/10 hover:border-white/20'
                      : 'border-white/5 opacity-85'
                  }`}
                >
                  {/* Top card metadata */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-11 h-11 rounded-xl flex items-center justify-center border ${
                          isExecuting
                            ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-300'
                            : isOnline
                            ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
                            : 'bg-slate-900 border-white/5 text-slate-500'
                        }`}
                      >
                        <Cpu className={`w-5 h-5 ${isExecuting ? 'animate-pulse' : ''}`} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-white tracking-tight">
                            {worker.hostname}
                          </h4>
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {worker.platform} &middot; {worker.engineVersion}
                        </p>
                      </div>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                        worker.status === 'EXECUTING'
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 animate-pulse'
                          : worker.status === 'ONLINE'
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : worker.status === 'REVOKED'
                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                          : 'bg-slate-800 text-slate-400 border border-white/5'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          worker.status === 'EXECUTING'
                            ? 'bg-cyan-400 animate-ping'
                            : worker.status === 'ONLINE'
                            ? 'bg-emerald-400'
                            : worker.status === 'REVOKED'
                            ? 'bg-rose-400'
                            : 'bg-slate-500'
                        }`}
                      />
                      {worker.status}
                    </span>
                  </div>

                  {/* Active Run Banner (If currently executing) */}
                  {isExecuting && worker.activeRun && (
                    <div className="bg-cyan-950/40 border border-cyan-500/30 rounded-lg p-3 flex items-center justify-between gap-3 text-xs">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-cyan-300 font-bold">
                          <Activity className="w-3.5 h-3.5 animate-spin" />
                          <span>Executing Run #{worker.activeRun.id.slice(0, 8)}</span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">
                          {worker.activeRun.workflowName || 'Automation Workflow'} &middot;{' '}
                          {worker.activeRun.items_processed || 0} items processed
                        </p>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => openRunDetails(worker.activeRun!)}
                          className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-md text-[11px] font-bold border border-cyan-400/30 transition-all flex items-center gap-1"
                          title="Open Run Details Drawer"
                        >
                          <span>Inspect</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>

                        <button
                          onClick={() => void handleStopRun(worker.activeRun!.id)}
                          disabled={stoppingRunId === worker.activeRun.id}
                          className="p-1 hover:bg-rose-500/20 text-rose-400 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          title="Stop Active Run"
                        >
                          {stoppingRunId === worker.activeRun.id ? (
                            <LoaderCircle className="w-4 h-4 animate-spin" />
                          ) : (
                            <StopCircle className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Metrics and Heartbeat Details */}
                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/5 text-[11px]">
                    <div>
                      <span className="text-slate-500 block text-[10px]">Heartbeat</span>
                      <span className="text-slate-300 font-medium flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3 text-cyan-400" />
                        {formatHeartbeat(worker.lastPingAt, now)}
                      </span>
                    </div>

                    <div>
                      <span className="text-slate-500 block text-[10px]">Claims Count</span>
                      <span className="text-slate-300 font-semibold mt-0.5 block">
                        {worker.claimsCount} runs handled
                      </span>
                    </div>

                    <div>
                      <span className="text-slate-500 block text-[10px]">Worker ID</span>
                      <span className="text-cyan-400/90 font-mono font-medium block mt-0.5">
                        ...{worker.id.slice(-8)}
                      </span>
                    </div>
                  </div>

                  {/* Card Actions Footer */}
                  <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5">
                      {worker.status === 'ONLINE' || worker.status === 'EXECUTING' ? (
                        <>
                          <span className={`w-1.5 h-1.5 rounded-full ${worker.cdpActive ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                          <span className={`font-medium ${worker.cdpActive ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {worker.cdpActive ? 'Browser ready' : 'Browser readiness not confirmed'}
                          </span>
                        </>
                      ) : worker.status === 'REVOKED' ? (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                          <span className="text-rose-400 font-medium">Token revoked &bull; reconnect required</span>
                        </>
                      ) : (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                          <span className="text-slate-400 font-medium">Runner offline &bull; browser status unknown</span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void checkWorkerStatus(worker.id)}
                        disabled={workerChecks[worker.id]?.state === 'checking'}
                        className="text-cyan-400 hover:text-cyan-300 font-semibold hover:underline disabled:opacity-50"
                      >
                        {workerChecks[worker.id]?.state === 'checking' ? 'Checking…' : 'Check status'}
                      </button>
                    </div>
                  </div>
                  {workerChecks[worker.id] && (
                    <p role="status" className={`text-[11px] ${workerChecks[worker.id].state === 'success' ? 'text-emerald-300' : workerChecks[worker.id].state === 'error' ? 'text-amber-300' : 'text-slate-400'}`}>
                      {workerChecks[worker.id].message}{workerChecks[worker.id].latencyMs !== undefined ? ` · Dashboard check ${workerChecks[worker.id].latencyMs} ms` : ''}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pairing help dialog */}
      {showPairingHelp && (
        <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/75 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowPairingHelp(false); }}>
          <div className="flex min-h-full items-start sm:items-center justify-center p-3 sm:p-4">
            <section role="dialog" aria-modal="true" aria-labelledby="pairing-help-title" className="my-auto flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0c101d] shadow-2xl sm:max-h-[calc(100dvh-2rem)]">
              <div className="shrink-0 border-b border-white/5 px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-cyan-300 mb-2"><Monitor className="w-5 h-5" /><span className="text-xs font-semibold uppercase tracking-wide">Desktop pairing</span></div>
                <h2 id="pairing-help-title" className="text-lg font-bold text-white">Connect a desktop</h2>
                <p className="text-sm text-slate-400 mt-1">Pair a computer with {organizationName} in a few steps.</p>
              </div>
              <button type="button" onClick={() => setShowPairingHelp(false)} aria-label="Close pairing help" className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5 [scrollbar-color:rgb(71_85_105)_rgb(12_16_29)] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-slate-950 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-600 hover:[&::-webkit-scrollbar-thumb]:bg-slate-500">
            <ol className="space-y-4">
              <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-xs font-bold text-cyan-300">1</span><div><p className="text-sm font-semibold text-white">Open ReFlow Desktop</p><p className="text-sm text-slate-400 mt-1">On the computer you want to connect, open the desktop app and go to its workspace pairing settings.</p></div></li>
              <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-xs font-bold text-cyan-300">2</span><div><p className="text-sm font-semibold text-white">Copy your workspace token</p><p className="text-sm text-slate-400 mt-1">Use Regenerate Token to issue a pairing token, then copy it immediately — it is shown only once. Paste it into ReFlow Desktop and keep it private.</p><button type="button" onClick={() => { setShowPairingHelp(false); document.getElementById('pairing-token')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} className="mt-2 text-sm font-semibold text-cyan-300 hover:text-cyan-200">Go to pairing token <span aria-hidden="true">→</span></button></div></li>
              <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-xs font-bold text-cyan-300">3</span><div><p className="text-sm font-semibold text-white">Start the runner</p><p className="text-sm text-slate-400 mt-1">Choose Connect or Start in ReFlow Desktop. Keep the app open while it connects.</p></div></li>
            </ol>
            <div className="rounded-xl border border-white/10 bg-slate-950/70 p-4 space-y-2">
              <div className="flex items-center gap-2">
                {pairingCheckState === 'checking' ? <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" /> : pairingCheckState === 'connected' ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : pairingCheckState === 'error' ? <AlertTriangle className="h-4 w-4 text-rose-300" /> : <Wifi className="h-4 w-4 text-slate-400" />}
                <p className="text-sm font-semibold text-white">{pairingCheckState === 'checking' ? 'Checking connection…' : pairingCheckState === 'connected' ? 'Desktop connected' : pairingCheckState === 'waiting' ? 'Waiting for your desktop' : pairingCheckState === 'error' ? 'Connection check failed' : 'Ready to check connection'}</p>
              </div>
              <p className="text-sm text-slate-400">{pairingCheckState === 'connected' ? 'A recent heartbeat was found for this workspace. Your desktop should now appear in Connected workers.' : pairingCheckState === 'waiting' ? 'We haven’t detected a recent desktop heartbeat yet. Make sure the app is open and the runner is started.' : pairingCheckState === 'error' ? (pairingCheckError || 'We couldn’t verify your desktop right now.') : 'After pairing in the desktop app, check here to confirm that it has checked in.'}</p>
              {pairingCheckState === 'error' && <p role="alert" className="text-xs text-rose-300">{pairingCheckError}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" onClick={() => void checkPairingConnection()} disabled={pairingCheckState === 'checking'} className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-3.5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50">{pairingCheckState === 'checking' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{pairingCheckState === 'checking' ? 'Checking…' : 'Check connection'}</button>
                {pairingCheckState === 'waiting' && <button type="button" onClick={() => { setPairingCheckState('idle'); setPairingCheckError(null); }} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm font-medium text-slate-200 hover:bg-white/5">Try again</button>}
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
              <p className="text-xs text-slate-400"><strong className="text-slate-200">Connecting another computer?</strong> Use the same workspace token on another authorized computer. Each computer should be registered as its own worker.</p>
            </div>
              </div>
              <div className="shrink-0 border-t border-white/10 bg-[#0c101d] px-4 py-3 sm:px-6">
                <div className="flex justify-end"><button type="button" onClick={() => setShowPairingHelp(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/5">Done</button></div>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Regenerate Token */}
      {showRegenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-[#0c101d] border border-cyan-500/30 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                <RefreshCw className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Regenerate Organization Token?</h3>
                <p className="text-xs text-slate-400">Invalidate previous token and issue a fresh secret key</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/70 p-3 rounded-xl border border-white/5">
              Warning: Regenerating will immediately invalidate your active pairing token. Any local Desktop Runners or daemons connected with the old key will stop claiming tasks until updated.
            </p>

            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={regenConfirmChecked}
                onChange={(e) => setRegenConfirmChecked(e.target.checked)}
                className="mt-0.5 rounded border-white/20 bg-slate-900 text-cyan-500 focus:ring-cyan-500"
              />
              <span>I understand that existing workers will stop processing runs until re-paired.</span>
            </label>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
              <button
                onClick={() => {
                  setShowRegenModal(false);
                  setRegenConfirmChecked(false);
                }}
                disabled={isRegenerating}
                className="px-3.5 py-1.5 rounded-lg border border-white/10 hover:border-white/20 text-xs font-semibold text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={handleRegenerateToken}
                disabled={!regenConfirmChecked || isRegenerating}
                className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-all disabled:opacity-40"
              >
                {isRegenerating ? 'Regenerating...' : 'Confirm & Regenerate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Revoke Token */}
      {showRevokeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-[#0c101d] border border-rose-500/30 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Revoke Pairing Token?</h3>
                <p className="text-xs text-slate-400">Completely disable desktop execution access</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/70 p-3 rounded-xl border border-white/5">
              This action revokes access for all runners paired to <strong className="text-white">{organizationName}</strong>. No new tasks will be executed until a new key is issued.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
              <button
                onClick={() => setShowRevokeModal(false)}
                disabled={isRevoking}
                className="px-3.5 py-1.5 rounded-lg border border-white/10 hover:border-white/20 text-xs font-semibold text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeToken}
                disabled={isRevoking}
                className="px-4 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-xs font-bold transition-all disabled:opacity-40"
              >
                {isRevoking ? 'Revoking...' : 'Revoke Token Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
