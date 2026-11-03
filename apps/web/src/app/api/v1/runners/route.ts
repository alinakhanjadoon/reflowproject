import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateRunnerOrUser, RunnerAuthContext } from '@/lib/auth/runner-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Runner-token rotation and revocation are workspace-admin operations. A
 * runner token itself must never be able to rotate its own credentials.
 */
async function requireOrgAdmin(
  supabase: SupabaseClient,
  orgId: string,
  context: RunnerAuthContext,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (context.authType !== 'session_user' || !context.userId) {
    return { ok: false, status: 403, error: 'Only a signed-in workspace admin can manage runner tokens' };
  }

  const { data } = await supabase
    .from('wf_organization_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', context.userId)
    .maybeSingle();

  if (!data || (data.role !== 'owner' && data.role !== 'admin')) {
    return { ok: false, status: 403, error: 'Only a workspace owner or admin can manage runner tokens' };
  }

  return { ok: true };
}

interface RegisteredWorkerMetadata {
  id?: string;
  hostname?: string;
  platform?: string;
  version?: string;
  last_ping_at?: string;
  cdp_active?: boolean;
  token_revoked?: boolean;
  [key: string]: unknown;
}

interface RunnerMetadata {
  workers?: RegisteredWorkerMetadata[];
  last_ping_at?: string;
  hostname?: string;
  platform?: string;
  version?: string;
  token?: string;
  token_revoked?: boolean;
  cdp_active?: boolean;
  rotated_at?: string;
  revoked_at?: string;
  [key: string]: unknown;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Strictly enforce authenticated caller's tenant orgId without query parameter overrides
  const { orgId, supabase } = auth.context;

  try {
    const { data: org, error } = await supabase
      .from('wf_organizations')
      .select('id, name, runner_metadata, runner_token_hash')
      .eq('id', orgId)
      .maybeSingle();

    if (error || !org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    let runnerMeta: RunnerMetadata = {};
    if (org.runner_metadata) {
      if (typeof org.runner_metadata === 'object' && org.runner_metadata !== null) {
        runnerMeta = org.runner_metadata as RunnerMetadata;
      } else if (typeof org.runner_metadata === 'string') {
        try {
          runnerMeta = JSON.parse(org.runner_metadata);
        } catch {
          runnerMeta = {};
        }
      }
    }

    const lastPingMs = runnerMeta.last_ping_at ? new Date(runnerMeta.last_ping_at).getTime() : 0;
    const diffSeconds = lastPingMs > 0 ? (Date.now() - lastPingMs) / 1000 : 999999;
    const isOnline = diffSeconds < 60 && runnerMeta.token_revoked !== true;

    // The raw token is never stored or served again. A pairing token is shown
    // once in the rotate/generate response; after that only its hash exists.
    const hasToken = Boolean(org.runner_token_hash);

    const registeredWorkers = Array.isArray(runnerMeta.workers) ? runnerMeta.workers : [];
    const runners = registeredWorkers.length > 0
      ? registeredWorkers.map((worker, index) => {
          const workerPingMs = worker.last_ping_at ? new Date(worker.last_ping_at).getTime() : 0;
          const workerAgeSeconds = workerPingMs > 0 ? (Date.now() - workerPingMs) / 1000 : 999999;
          const workerOnline = workerAgeSeconds >= 0 && workerAgeSeconds < 60 && runnerMeta.token_revoked !== true && worker.token_revoked !== true;
          return {
            id: worker.id || `runner_${index + 1}`,
            hostname: worker.hostname || 'Unknown desktop',
            label: worker.hostname || 'Desktop runner',
            platform: worker.platform || 'unknown',
            engineVersion: worker.version || 'unknown',
            status: runnerMeta.token_revoked || worker.token_revoked ? 'REVOKED' : workerOnline ? 'ONLINE' : 'OFFLINE',
            lastPingAt: worker.last_ping_at || null,
            cdpActive: worker.cdp_active === true,
          };
        })
      : [{
          id: 'runner_primary',
          hostname: runnerMeta.hostname || (isOnline ? 'Active Desktop Runner' : 'unknown'),
          label: 'Primary Desktop Runner',
          platform: runnerMeta.platform || 'unknown',
          engineVersion: runnerMeta.version || 'unknown',
          status: runnerMeta.token_revoked ? 'REVOKED' : (isOnline ? 'ONLINE' : 'OFFLINE'),
          lastPingAt: runnerMeta.last_ping_at || null,
          cdpActive: runnerMeta.cdp_active === true,
        }];

    const anyWorkerOnline = runners.some((runner) => runner.status === 'ONLINE');

    return NextResponse.json(
      {
        success: true,
        is_online: anyWorkerOnline,
        token_configured: hasToken,
        token_revoked: runnerMeta.token_revoked === true,
        diff_seconds: Math.round(diffSeconds),
        runners,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve runner state';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, supabase } = auth.context;

  let body: (Partial<RunnerMetadata> & { action?: string }) = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // Fetch existing org metadata to merge and preserve fields
  const { data: existingOrg } = await supabase
    .from('wf_organizations')
    .select('runner_metadata, runner_token_hash')
    .eq('id', orgId)
    .maybeSingle();

  let existingMeta: RunnerMetadata = {};
  if (existingOrg?.runner_metadata) {
    if (typeof existingOrg.runner_metadata === 'object' && existingOrg.runner_metadata !== null) {
      existingMeta = existingOrg.runner_metadata as RunnerMetadata;
    } else if (typeof existingOrg.runner_metadata === 'string') {
      try {
        existingMeta = JSON.parse(existingOrg.runner_metadata);
      } catch {}
    }
  }

  // Strip any legacy plaintext token before it is merged back into storage.
  const cleanMeta: RunnerMetadata = { ...existingMeta };
  delete cleanMeta.token;

  // Handle Token Rotation Action
  if (body.action === 'rotate' || body.action === 'generate') {
    const admin = await requireOrgAdmin(supabase, orgId, auth.context);
    if (!admin.ok) {
      return NextResponse.json({ error: admin.error }, { status: admin.status });
    }

    const rawOrgHex = orgId.replace(/-/g, '').slice(0, 16);
    const secretHex = crypto.randomBytes(16).toString('hex');
    const newToken = `rf_live_${rawOrgHex}_${secretHex}`;
    const newHash = crypto.createHash('sha256').update(newToken).digest('hex');

    const updatedMeta = {
      ...cleanMeta,
      token_revoked: false,
      workers: Array.isArray(cleanMeta.workers) ? cleanMeta.workers.map((worker) => ({ ...worker, token_revoked: true })) : cleanMeta.workers,
      rotated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from('wf_organizations')
      .update({
        runner_token_hash: newHash,
        runner_metadata: updatedMeta,
      })
      .eq('id', orgId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      token: newToken,
      is_online: true,
    });
  }

  // Handle Token Revocation Action
  if (body.action === 'revoke') {
    const admin = await requireOrgAdmin(supabase, orgId, auth.context);
    if (!admin.ok) {
      return NextResponse.json({ error: admin.error }, { status: admin.status });
    }

    const updatedMeta = {
      ...cleanMeta,
      token_revoked: true,
      revoked_at: new Date().toISOString(),
    };

    const { error: revokeError } = await supabase
      .from('wf_organizations')
      .update({
        runner_token_hash: null,
        runner_metadata: updatedMeta,
      })
      .eq('id', orgId);

    if (revokeError) {
      return NextResponse.json({ error: revokeError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      revoked: true,
    });
  }

  // Handle Runner Heartbeat. Store one heartbeat per desktop so multiple machines
  // using the same workspace token remain independently visible.
  const timestamp = new Date().toISOString();
  const hostname = String(body.hostname || request.headers.get('x-runner-hostname') || 'unknown');
  const platform = String(body.platform || request.headers.get('x-runner-platform') || 'unknown');
  const version = String(body.version || request.headers.get('x-runner-version') || 'unknown');
  const requestedWorkerId = typeof body.worker_id === 'string' ? body.worker_id : typeof body.workerId === 'string' ? body.workerId : '';
  const stableIdentity = requestedWorkerId || (hostname !== 'unknown'
    ? `runner_${crypto.createHash('sha256').update(`${hostname.toLowerCase()}|${platform.toLowerCase()}`).digest('hex').slice(0, 16)}`
    : 'runner_primary');
  const workerRecord: RegisteredWorkerMetadata = {
    id: stableIdentity,
    hostname,
    platform,
    version,
    last_ping_at: timestamp,
    cdp_active: body.cdp_active === true,
    token_revoked: false,
  };
  const existingWorkers = Array.isArray(existingMeta.workers) ? existingMeta.workers : [];
  const nextWorkers = [
    ...existingWorkers.filter((worker) => worker.id !== stableIdentity),
    workerRecord,
  ];
  const payload: RunnerMetadata = {
    ...cleanMeta,
    // Keep legacy top-level fields in sync while new clients migrate to the workers registry.
    last_ping_at: timestamp,
    hostname,
    platform,
    version,
    cdp_active: body.cdp_active === true,
    workers: nextWorkers,
  };

  try {
    const { error } = await supabase
      .from('wf_organizations')
      .update({ runner_metadata: payload })
      .eq('id', orgId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      worker_id: stableIdentity,
      timestamp,
      is_online: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update runner heartbeat';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
