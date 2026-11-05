'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { DrawerRunItem } from '@/components/dashboard/RunDetailsDrawer';

export type ThemePaletteId =
  | 'reflow-cyber'
  | 'charcoal-indigo'
  | 'emerald-matrix'
  | 'slate-dark'
  | 'crimson-rose'
  | 'forest';

export type InterfaceMode = 'dark' | 'light' | 'system';

export const LEGACY_THEME_MAP: Record<string, ThemePaletteId> = {
  'theme-reflow-cyber': 'reflow-cyber',
};

export const VALID_THEME_PALETTES: ThemePaletteId[] = [
  'reflow-cyber',
  'charcoal-indigo',
  'emerald-matrix',
  'slate-dark',
  'crimson-rose',
  'forest',
];

export function applyThemeToDOM(palette: ThemePaletteId, mode: InterfaceMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  let resolvedMode = mode;
  if (mode === 'system') {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    resolvedMode = prefersDark ? 'dark' : 'light';
  }

  root.setAttribute('data-theme', palette);
  root.setAttribute('data-palette', palette);
  root.setAttribute('data-mode', resolvedMode);
  root.setAttribute('data-theme-mode', mode);

  VALID_THEME_PALETTES.forEach((p) => root.classList.remove(`theme-${p}`));
  root.classList.remove('theme-reflow-cyber');
  root.classList.add(`theme-${palette}`);

  if (resolvedMode === 'light') {
    root.classList.remove('dark');
    root.classList.add('light');
  } else {
    root.classList.remove('light');
    root.classList.add('dark');
  }

  try {
    localStorage.setItem('reflow_theme', palette);
    localStorage.setItem('wf_dashboard_theme', palette);
    localStorage.setItem('wf_dashboard_mode', mode);
    localStorage.setItem('workflow_capture_theme', palette);
    localStorage.setItem('workflow_capture_mode', mode);
    localStorage.setItem('workflow_capture_palette', palette);
  } catch {}

  try {
    window.dispatchEvent(
      new CustomEvent('workflow-capture-theme-change', {
        detail: { theme: palette, palette, mode, resolvedMode }
      })
    );
  } catch {}
}

interface DashboardContextType {
  orgId: string | null;
  organizationName: string;
  userEmail: string | null;
  isRunnerOnline: boolean;
  runnerToken: string | null;
  loading: boolean;
  isRefreshing: boolean;
  refreshDashboard: () => Promise<void>;
  openRunDetails: (run: DrawerRunItem) => void;
  closeRunDetails: () => void;
  selectedRun: DrawerRunItem | null;
  isDrawerOpen: boolean;
  stopActiveRun: (runId: string) => Promise<boolean>;
  theme: ThemePaletteId;
  mode: InterfaceMode;
  setTheme: (theme: ThemePaletteId) => void;
  setMode: (mode: InterfaceMode) => void;
  saveThemePreferences: (theme: ThemePaletteId, mode: InterfaceMode) => Promise<void>;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState<string>('My Organization');
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isRunnerOnline, setIsRunnerOnline] = useState<boolean>(false);
  const [runnerToken, setRunnerToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Theme & Appearance State
  const [theme, setThemeState] = useState<ThemePaletteId>('reflow-cyber');
  const [mode, setModeState] = useState<InterfaceMode>('dark');

  // Global Run Details Drawer state
  const [selectedRun, setSelectedRun] = useState<DrawerRunItem | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Synchronize initial theme & mode from localStorage and system preferences
  useEffect(() => {
    let initialTheme: ThemePaletteId = 'reflow-cyber';
    let initialMode: InterfaceMode = 'dark';
    try {
      const rawStoredTheme = localStorage.getItem('reflow_theme') ||
        localStorage.getItem('wf_dashboard_theme') ||
        localStorage.getItem('workflow_capture_theme');
      const resolved = rawStoredTheme ? (LEGACY_THEME_MAP[rawStoredTheme] || (rawStoredTheme as ThemePaletteId)) : null;
      if (resolved && VALID_THEME_PALETTES.includes(resolved)) {
        initialTheme = resolved;
      }
      const storedMode = (localStorage.getItem('wf_dashboard_mode') ||
        localStorage.getItem('workflow_capture_mode')) as InterfaceMode | null;
      if (storedMode && ['dark', 'light', 'system'].includes(storedMode)) {
        initialMode = storedMode;
      }
    } catch {}

    setThemeState(initialTheme);
    setModeState(initialMode);
    applyThemeToDOM(initialTheme, initialMode);

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMql = () => {
      setModeState((curMode) => {
        if (curMode === 'system') {
          setThemeState((curTheme) => {
            applyThemeToDOM(curTheme, 'system');
            return curTheme;
          });
        }
        return curMode;
      });
    };
    mql.addEventListener('change', handleMql);

    const handleCustomChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ theme?: ThemePaletteId; mode?: InterfaceMode }>;
      if (customEvent.detail) {
        if (customEvent.detail.theme && VALID_THEME_PALETTES.includes(customEvent.detail.theme)) {
          setThemeState(customEvent.detail.theme);
        }
        if (customEvent.detail.mode && ['dark', 'light', 'system'].includes(customEvent.detail.mode)) {
          setModeState(customEvent.detail.mode);
        }
      }
    };
    window.addEventListener('reflow-theme-change', handleCustomChange);
    window.addEventListener('workflow-capture-theme-change', handleCustomChange);

    return () => {
      mql.removeEventListener('change', handleMql);
      window.removeEventListener('reflow-theme-change', handleCustomChange);
      window.removeEventListener('workflow-capture-theme-change', handleCustomChange);
    };
  }, []);

  const fetchDashboardContext = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      setUserEmail(user.email || null);

      // Fetch user's organization memberships (unjoined to guarantee it never fails on relation/cache)
      const { data: members, error: memberError } = await supabase
        .from('wf_organization_members')
        .select('org_id, role')
        .eq('user_id', user.id);

      if (memberError) {
        const errDetail = memberError.message || (memberError as any).code || JSON.stringify(memberError);
        console.error('Error fetching org membership:', errDetail);
      }

      // ONLY redirect to onboarding if the query succeeded without error AND user has 0 memberships
      if (!memberError && (!members || members.length === 0)) {
        router.push('/onboarding');
        return;
      }

      // 1. Determine active organization
      const savedOrgId = typeof window !== 'undefined' ? localStorage.getItem('wf_active_org_id') : null;
      let activeOrgId: string | null = null;
      if (savedOrgId && members && members.some((m) => m.org_id === savedOrgId)) {
        activeOrgId = savedOrgId;
      } else if (members && members.length > 0) {
        activeOrgId = members[0].org_id;
      } else if (savedOrgId) {
        activeOrgId = savedOrgId;
      }

      if (!activeOrgId) {
        // If query errored and no org was cached, exit gracefully without redirecting to onboarding
        return;
      }

      setOrgId(activeOrgId);
      if (typeof window !== 'undefined') {
        localStorage.setItem('wf_active_org_id', activeOrgId);
      }

      // 2. Fetch organization row with fallback
      let orgRecord: { id: string; name?: string; slug?: string; plan_tier?: string; runner_metadata?: any } = {
        id: activeOrgId,
        name: 'Workspace',
        slug: 'workspace',
        plan_tier: 'starter',
        runner_metadata: {},
      };

      try {
        const { data: orgData, error: orgError } = await supabase
          .from('wf_organizations')
          .select('*')
          .eq('id', activeOrgId)
          .maybeSingle();

        if (!orgError && orgData) {
          orgRecord = orgData;
        }
      } catch (e) {
        console.warn('Notice fetching organization details:', e);
      }

      setOrganizationName(orgRecord.name || 'My Organization');

      // 3. Parse runner_metadata
      let parsedMeta: Record<string, unknown> = {};
      if (orgRecord.runner_metadata) {
        try {
          parsedMeta = typeof orgRecord.runner_metadata === 'object' && orgRecord.runner_metadata !== null
            ? orgRecord.runner_metadata as Record<string, unknown>
            : JSON.parse(orgRecord.runner_metadata as string);
        } catch {}
      }

      const orgPalette = ((parsedMeta.theme_settings as Record<string, unknown> | undefined)?.palette || parsedMeta.theme) as ThemePaletteId | undefined;
      const orgMode = ((parsedMeta.theme_settings as Record<string, unknown> | undefined)?.mode || parsedMeta.mode) as InterfaceMode | undefined;
      if (orgPalette && VALID_THEME_PALETTES.includes(orgPalette)) {
        setThemeState(orgPalette);
        const resolvedMode = (orgMode && ['dark', 'light', 'system'].includes(orgMode)) ? orgMode : 'dark';
        setModeState(resolvedMode);
        applyThemeToDOM(orgPalette, resolvedMode);
      }

      // The raw runner token is no longer stored or readable from the browser.
      setRunnerToken(null);

      // Determine initial online status synchronously from already-fetched organization metadata
      let online = false;
      if (parsedMeta?.last_ping_at && parsedMeta?.token_revoked !== true) {
        const diffSeconds = (Date.now() - new Date(parsedMeta.last_ping_at as string).getTime()) / 1000;
        online = diffSeconds < 60;
      }
      setIsRunnerOnline(online);

      // Immediately unblock the page UI so the user does not stare at a blocking waterfall
      setLoading(false);

      // Asynchronously refresh online status in background without blocking initial paint
      void (async () => {
        try {
          const res = await fetch(`/api/v1/runners`, {
            cache: 'no-store',
          });
          if (res.ok) {
            const data = await res.json();
            setIsRunnerOnline(!!data.is_online);
          }
        } catch {}
      })();
    } catch (err) {
      console.error('Dashboard context error:', err);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) {
        void fetchDashboardContext();
      }
    }, 0);

    if (!orgId) {
      return () => {
        isMounted = false;
        clearTimeout(timer);
      };
    }

    const supabase = createClient();

    // Heartbeat poller for runner status every 15 seconds (coalesced with Realtime sync)
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/runners`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          if (isMounted) {
            setIsRunnerOnline(!!data.is_online);
          }
        } else {
          // Direct Supabase query fallback
          const { data: directOrg } = await supabase
            .from('wf_organizations')
            .select('runner_metadata')
            .eq('id', orgId)
            .maybeSingle();

          if (directOrg?.runner_metadata && isMounted) {
            try {
              const meta = typeof directOrg.runner_metadata === 'object'
                ? directOrg.runner_metadata as Record<string, unknown>
                : JSON.parse(directOrg.runner_metadata as string);
              if (meta?.last_ping_at) {
                const diff = (Date.now() - new Date(meta.last_ping_at as string).getTime()) / 1000;
                setIsRunnerOnline(diff < 60);
              }
            } catch {}
          }
        }
      } catch {}
    }, 15000);

    // Supabase Realtime subscription to organization telemetry updates
    const orgChannel = supabase
      .channel(`wf_org_heartbeat_sync_${orgId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'wf_organizations',
          filter: `id=eq.${orgId}`,
        },
        (payload) => {
          if (!isMounted) return;
          const updated = payload.new as { runner_metadata?: Record<string, unknown> | string | null } | undefined;
          if (updated?.runner_metadata) {
            try {
              const meta = typeof updated.runner_metadata === 'object'
                ? updated.runner_metadata
                : JSON.parse(updated.runner_metadata);
              if (meta?.last_ping_at) {
                const diff = (Date.now() - new Date(meta.last_ping_at).getTime()) / 1000;
                setIsRunnerOnline(diff < 60);
              }
            } catch {}
          }
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      clearTimeout(timer);
      clearInterval(interval);
      void supabase.removeChannel(orgChannel);
    };
  }, [fetchDashboardContext, orgId, runnerToken]);

  const refreshDashboard = async () => {
    setIsRefreshing(true);
    try {
      await fetchDashboardContext();
    } finally {
      setIsRefreshing(false);
    }
  };

  const openRunDetails = (run: DrawerRunItem) => {
    setSelectedRun(run);
    setIsDrawerOpen(true);
  };

  const closeRunDetails = () => {
    setIsDrawerOpen(false);
  };

  const stopActiveRun = async (runId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/v1/runs`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId, status: 'cancelled' })
      });
      if (res.ok) {
        if (selectedRun && selectedRun.id === runId) {
          setSelectedRun({ ...selectedRun, status: 'cancelled' });
        }
        await refreshDashboard();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const setTheme = useCallback((newTheme: ThemePaletteId) => {
    if (!VALID_THEME_PALETTES.includes(newTheme)) return;
    setThemeState(newTheme);
    applyThemeToDOM(newTheme, mode);
  }, [mode]);

  const setMode = useCallback((newMode: InterfaceMode) => {
    setModeState(newMode);
    applyThemeToDOM(theme, newMode);
  }, [theme]);

  const saveThemePreferences = useCallback(
    async (newTheme: ThemePaletteId, newMode: InterfaceMode) => {
      if (!VALID_THEME_PALETTES.includes(newTheme)) return;
      setThemeState(newTheme);
      setModeState(newMode);
      applyThemeToDOM(newTheme, newMode);

      if (orgId) {
        try {
          const supabase = createClient();
          const { data: directOrg } = await supabase
            .from('wf_organizations')
            .select('runner_metadata')
            .eq('id', orgId)
            .maybeSingle();

          let existingMeta: Record<string, unknown> = {};
          if (directOrg?.runner_metadata) {
            try {
              existingMeta = typeof directOrg.runner_metadata === 'object'
                ? directOrg.runner_metadata as Record<string, unknown>
                : JSON.parse(directOrg.runner_metadata as string);
            } catch {}
          }

          const updatedMeta = {
            ...existingMeta,
            theme_settings: { palette: newTheme, mode: newMode },
            theme: newTheme,
            mode: newMode,
          };

          await supabase
            .from('wf_organizations')
            .update({
              runner_metadata: updatedMeta,
            })
            .eq('id', orgId);
        } catch (err) {
          console.warn('Failed to sync theme preference to Supabase:', err);
        }
      }
    },
    [orgId]
  );

  return (
    <DashboardContext.Provider
      value={{
        orgId,
        organizationName,
        userEmail,
        isRunnerOnline,
        runnerToken,
        loading,
        isRefreshing,
        refreshDashboard,
        openRunDetails,
        closeRunDetails,
        selectedRun,
        isDrawerOpen,
        stopActiveRun,
        theme,
        mode,
        setTheme,
        setMode,
        saveThemePreferences,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboard must be used within a DashboardProvider');
  }
  return context;
}
