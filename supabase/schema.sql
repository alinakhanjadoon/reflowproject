-- ============================================================================
-- ReFlow Database Schema (fresh install)
-- Supabase PostgreSQL with Row Level Security (RLS)
--
-- This file describes a NEW database. Existing projects are upgraded with the
-- files in supabase/migrations/ — do not re-run this file against a database
-- that already has data.
-- ============================================================================

-- 1. Organizations
CREATE TABLE IF NOT EXISTS public.wf_organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    runner_metadata JSONB DEFAULT '{}'::jsonb,
    runner_token_hash TEXT,
    plan_tier TEXT DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'pro', 'business', 'enterprise')),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 2. Organization Members
CREATE TABLE IF NOT EXISTS public.wf_organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.wf_organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(org_id, user_id)
);

-- 3. Workflows
CREATE TABLE IF NOT EXISTS public.wf_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.wf_organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    portal_url TEXT NOT NULL DEFAULT '',
    schema_version TEXT DEFAULT '1.0.0',
    workflow_definition JSONB DEFAULT '{}'::jsonb NOT NULL,
    filter_rules JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 4. Execution Runs
-- The execution configuration lives on the run, not on the workflow, so two
-- concurrent runs with different filters cannot overwrite each other.
CREATE TABLE IF NOT EXISTS public.wf_execution_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.wf_organizations(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES public.wf_workflows(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'requires_action', 'completed', 'failed', 'cancelled')),
    total_items_discovered INT DEFAULT 0,
    items_processed INT DEFAULT 0,
    items_downloaded INT DEFAULT 0,
    started_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    completed_at TIMESTAMPTZ,
    error_summary TEXT,
    mode TEXT DEFAULT 'single',
    is_loop BOOLEAN DEFAULT false,
    loop_step_index INT,
    loop_limit INT,
    item_filter JSONB
);

-- 5. Run Artifacts
CREATE TABLE IF NOT EXISTS public.wf_run_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.wf_execution_runs(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_size_bytes BIGINT,
    sha256_hash TEXT NOT NULL,
    item_metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    cloud_storage_path TEXT,
    synced_to_drive BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_wf_org_members_user_id ON public.wf_organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_wf_workflows_org_id ON public.wf_workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_wf_execution_runs_org_id ON public.wf_execution_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_wf_execution_runs_status ON public.wf_execution_runs(status);
CREATE INDEX IF NOT EXISTS idx_wf_execution_runs_workflow_id ON public.wf_execution_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_run_artifacts_run_id ON public.wf_run_artifacts(run_id);

-- One row per distinct file content per run; retries update instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_run_artifacts_run_sha256
    ON public.wf_run_artifacts(run_id, sha256_hash);

-- Runner authentication looks organizations up by token hash on every request.
CREATE UNIQUE INDEX IF NOT EXISTS wf_organizations_runner_token_hash_key
    ON public.wf_organizations(runner_token_hash)
    WHERE runner_token_hash IS NOT NULL;

-- Private artifact bucket. All access goes through the API routes using the
-- service role, so no storage.objects policies are granted to end users.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('wf_artifacts', 'wf_artifacts', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Membership helpers
--
-- SECURITY DEFINER is required: a policy on wf_organization_members that
-- selects from wf_organization_members re-enters itself once RLS is enabled
-- and Postgres raises "infinite recursion detected in policy".
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_org_member(target_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.wf_organization_members m
    WHERE m.org_id = target_org AND m.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin(target_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.wf_organization_members m
    WHERE m.org_id = target_org
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.org_has_members(target_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.wf_organization_members m WHERE m.org_id = target_org
  );
$$;

CREATE OR REPLACE FUNCTION public.is_run_visible(target_run uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.wf_execution_runs r
    WHERE r.id = target_run AND public.is_org_member(r.org_id)
  );
$$;

REVOKE ALL ON FUNCTION public.is_org_member(uuid) FROM public;
REVOKE ALL ON FUNCTION public.is_org_admin(uuid) FROM public;
REVOKE ALL ON FUNCTION public.org_has_members(uuid) FROM public;
REVOKE ALL ON FUNCTION public.is_run_visible(uuid) FROM public;

GRANT EXECUTE ON FUNCTION public.is_org_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_members(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_run_visible(uuid) TO authenticated;

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.wf_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_execution_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_run_artifacts ENABLE ROW LEVEL SECURITY;

-- No anonymous access to tenant data. The public anon key is shipped to
-- browsers, so grants to anon are effectively public access.
REVOKE ALL ON TABLE public.wf_organizations FROM anon;
REVOKE ALL ON TABLE public.wf_organization_members FROM anon;
REVOKE ALL ON TABLE public.wf_workflows FROM anon;
REVOKE ALL ON TABLE public.wf_execution_runs FROM anon;
REVOKE ALL ON TABLE public.wf_run_artifacts FROM anon;

-- Organizations
DROP POLICY IF EXISTS "Users can view their organizations" ON public.wf_organizations;
DROP POLICY IF EXISTS "Users can create organizations" ON public.wf_organizations;

CREATE POLICY "Members can view their organizations" ON public.wf_organizations
    FOR SELECT TO authenticated
    USING (public.is_org_member(id));

-- Signup inserts the organization before the membership row exists.
CREATE POLICY "Authenticated users can create organizations" ON public.wf_organizations
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Members can update their organizations" ON public.wf_organizations
    FOR UPDATE TO authenticated
    USING (public.is_org_member(id))
    WITH CHECK (public.is_org_member(id));

-- Memberships
DROP POLICY IF EXISTS "Users can view their organization memberships" ON public.wf_organization_members;
DROP POLICY IF EXISTS "Admins can add members" ON public.wf_organization_members;

CREATE POLICY "Members can view org membership" ON public.wf_organization_members
    FOR SELECT TO authenticated
    USING (public.is_org_member(org_id) OR user_id = auth.uid());

-- Self-insert is limited to the signup bootstrap (an org with no members yet).
-- Without this restriction any authenticated user could add themselves as
-- owner of any organization whose id they knew.
CREATE POLICY "Bootstrap or admin can add members" ON public.wf_organization_members
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_org_admin(org_id)
        OR (user_id = auth.uid() AND NOT public.org_has_members(org_id))
    );

CREATE POLICY "Admins can update members" ON public.wf_organization_members
    FOR UPDATE TO authenticated
    USING (public.is_org_admin(org_id))
    WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "Admins can remove members" ON public.wf_organization_members
    FOR DELETE TO authenticated
    USING (public.is_org_admin(org_id));

-- Workflows
DROP POLICY IF EXISTS "Users can manage workflows in their org" ON public.wf_workflows;
CREATE POLICY "Members manage workflows" ON public.wf_workflows
    FOR ALL TO authenticated
    USING (public.is_org_member(org_id))
    WITH CHECK (public.is_org_member(org_id));

-- Execution runs
DROP POLICY IF EXISTS "Users can manage execution runs in their org" ON public.wf_execution_runs;
CREATE POLICY "Members manage runs" ON public.wf_execution_runs
    FOR ALL TO authenticated
    USING (public.is_org_member(org_id))
    WITH CHECK (public.is_org_member(org_id));

-- Run artifacts
DROP POLICY IF EXISTS "Users can manage artifacts in their org" ON public.wf_run_artifacts;
CREATE POLICY "Members manage artifacts" ON public.wf_run_artifacts
    FOR ALL TO authenticated
    USING (public.is_run_visible(run_id))
    WITH CHECK (public.is_run_visible(run_id));

