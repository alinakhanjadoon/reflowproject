import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';

export interface RunnerAuthContext {
  authenticated: true;
  authType: 'runner_token' | 'session_user';
  orgId: string;
  userId?: string;
  token?: string;
  supabase: SupabaseClient;
}

export type RunnerAuthResult =
  | { success: true; context: RunnerAuthContext }
  | { success: false; error: string; status: number };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lastHeartbeatWriteCache = new Map<string, number>();

function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url || !key) {
    // Falling back to the anon key used to "work" only because RLS was off.
    // RLS is now enabled, so an anon-key client silently returns no rows
    // instead of failing. Refuse to run instead.
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for server-side tenant access');
  }

  return createSupabaseClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function extractRunnerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (authHeader) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    if (trimmed.startsWith('rf_live_')) {
      return trimmed;
    }
  }

  const runnerHeader = request.headers.get('x-runner-token') || request.headers.get('X-Runner-Token');
  if (runnerHeader) {
    return runnerHeader.trim();
  }

  return null;
}

export async function authenticateRunnerOrUser(request: NextRequest): Promise<RunnerAuthResult> {
  const runnerToken = extractRunnerToken(request);
  const client = getServiceClient();

  // If a bearer or runner token header was provided:
  if (runnerToken !== null) {
    let cleanToken = runnerToken.trim().replace(/^["']|["']$/g, '').replace(/[\.\s…]+$/, '');
    if (cleanToken.toLowerCase().startsWith('bearer ')) {
      cleanToken = cleanToken.slice(7).trim();
    }

    if (!cleanToken.startsWith('rf_live_')) {
      return {
        success: false,
        error: 'Unauthorized: Invalid runner token format. Expected rf_live_<org_id>_<secret>',
        status: 401,
      };
    }

    const tokenContent = cleanToken.slice('rf_live_'.length).trim();
    const parts = tokenContent.split('_');
    const orgPrefix = parts[0];
    const secret = parts[1];
    if (!orgPrefix || !secret || secret.length < 16) {
      return {
        success: false,
        error: 'Unauthorized: Missing or malformed secret in runner token. Expected rf_live_<org_id>_<secret>',
        status: 401,
      };
    }

    if (secret.includes('•') || secret.includes('\u2022')) {
      return {
        success: false,
        error: 'Unauthorized: Runner token contains masked bullet characters (•). Please regenerate and copy the full token from the web console.',
        status: 401,
      };
    }

    if (secret.length < 32) {
      return {
        success: false,
        error: `Unauthorized: Incomplete runner token secret (received ${secret.length} characters, expected 32). Please copy the full token using the Copy button.`,
        status: 401,
      };
    }

    const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');

    // 1. Direct lookup by runner_token_hash (optimal and safe)
    let { data: org, error: queryError } = await client
      .from('wf_organizations')
      .select('id, name, runner_metadata, runner_token_hash')
      .eq('runner_token_hash', tokenHash)
      .maybeSingle();

    if (queryError) {
      return {
        success: false,
        error: `Database error during runner authentication: ${queryError.message}`,
        status: 500,
      };
    }

    // 2. Fallback check: lookup by exact UUID if token hash was stored inside runner_metadata
    if (!org && UUID_REGEX.test(orgPrefix)) {
      const { data: byId } = await client
        .from('wf_organizations')
        .select('id, name, runner_metadata, runner_token_hash')
        .eq('id', orgPrefix)
        .maybeSingle();
      org = byId;
    }

    if (!org) {
      return {
        success: false,
        error: 'Unauthorized: Unknown or invalid runner token',
        status: 401,
      };
    }

    // Resolve expected hash from column or metadata
    const rawMeta = org.runner_metadata;
    const meta: Record<string, unknown> = (typeof rawMeta === 'object' && rawMeta !== null)
      ? (rawMeta as Record<string, unknown>)
      : (typeof rawMeta === 'string' ? (() => { try { return JSON.parse(rawMeta); } catch { return {}; } })() : {});

    // Only the hash column is authoritative. Legacy copies of the token in
    // runner_metadata (plaintext or hashed) are no longer written or trusted.
    const expectedHash = org.runner_token_hash || null;

    if (!expectedHash) {
      return {
        success: false,
        error: 'Unauthorized: Organization has no active runner token configured',
        status: 401,
      };
    }

    // Verify token using constant-time comparison
    const bufA = Buffer.from(tokenHash, 'hex');
    const bufB = Buffer.from(expectedHash, 'hex');
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      return {
        success: false,
        error: 'Unauthorized: Invalid runner token secret',
        status: 401,
      };
    }

    // Check if token was revoked
    if (meta.token_revoked === true) {
      return {
        success: false,
        error: 'Forbidden: Runner token has been revoked',
        status: 403,
      };
    }

    const orgId = org.id;

    // Runner heartbeat & telemetry
    const incomingHostname = request.headers.get('x-runner-hostname');
    const incomingPlatform = request.headers.get('x-runner-platform');
    const incomingVersion = request.headers.get('x-runner-version');
    const incomingCdp = request.headers.get('x-runner-cdp');

    const isRunnerRequest = Boolean(incomingHostname || incomingPlatform || request.method === 'POST');
    const shouldWriteHeartbeat = isRunnerRequest && (
      (request.method === 'POST' && request.nextUrl.pathname.endsWith('/runners')) ||
      (Date.now() - (lastHeartbeatWriteCache.get(orgId) || 0) > 15000)
    );

    if (shouldWriteHeartbeat) {
      try {
        const safeMeta = { ...meta };
        delete safeMeta.token;

        const mergedPayload = {
          ...safeMeta,
          last_ping_at: new Date().toISOString(),
          hostname: incomingHostname || meta.hostname || 'unknown',
          platform: incomingPlatform || meta.platform || 'unknown',
          version: incomingVersion || meta.version || 'unknown',
          cdp_active: incomingCdp !== null ? incomingCdp === 'true' : (meta.cdp_active ?? false),
        };

        await client
          .from('wf_organizations')
          .update({
            runner_metadata: mergedPayload,
          })
          .eq('id', orgId);

        lastHeartbeatWriteCache.set(orgId, Date.now());
      } catch {
        // Non-fatal if telemetry update fails
      }
    }

    return {
      success: true,
      context: {
        authenticated: true,
        authType: 'runner_token',
        orgId,
        token: runnerToken,
        supabase: client,
      },
    };
  }

  // Fallback to browser session cookie authentication
  try {
    const serverSupabase = await createServerClient();
    const {
      data: { user },
      error: userError,
    } = await serverSupabase.auth.getUser();

    if (userError || !user) {
      return {
        success: false,
        error: 'Unauthorized: Authentication required (Bearer token, x-runner-token, or session cookie)',
        status: 401,
      };
    }

    // Resolve user's organization
    const { data: members } = await client
      .from('wf_organization_members')
      .select('org_id')
      .eq('user_id', user.id)
      .limit(20);

    let orgId: string | null = null;
    if (members && members.length > 0) {
      orgId = members[0].org_id;
    }

    // Check query params if specified and verify user membership
    const requestedOrgId = request.nextUrl.searchParams.get('org_id');
    if (requestedOrgId && UUID_REGEX.test(requestedOrgId)) {
      if (members && members.some((m) => m.org_id === requestedOrgId)) {
        orgId = requestedOrgId;
      }
    }

    // If user has no organization yet, resolve or create default
    if (!orgId) {
      const defaultSlug = `user-${user.id.slice(0, 8)}`;
      const { data: defaultOrg } = await client
        .from('wf_organizations')
        .insert({
          name: `${user.email?.split('@')[0] || 'User'}'s Organization`,
          slug: defaultSlug,
          plan_tier: 'starter',
        })
        .select('id')
        .maybeSingle();

      if (defaultOrg) {
        orgId = defaultOrg.id;
        await client.from('wf_organization_members').insert({
          org_id: orgId,
          user_id: user.id,
          role: 'owner',
        });
      }
    }

    if (!orgId) {
      return {
        success: false,
        error: 'Forbidden: No organization associated with user',
        status: 403,
      };
    }

    return {
      success: true,
      context: {
        authenticated: true,
        authType: 'session_user',
        orgId,
        userId: user.id,
        supabase: client,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    return {
      success: false,
      error: `Unauthorized: ${message}`,
      status: 401,
    };
  }
}
