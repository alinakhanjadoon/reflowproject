import { NextRequest, NextResponse } from 'next/server';
import { authenticateRunnerOrUser } from '@/lib/auth/runner-auth';
import { RunStatus } from '@/lib/types/database';
import { deriveLoopSignals, validateLoopConfig } from '@/lib/workflows/loop-signals';

const ALLOWED_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['requires_action', 'completed', 'failed', 'cancelled'],
  requires_action: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const VALID_STATUSES: Set<string> = new Set([
  'pending',
  'running',
  'requires_action',
  'completed',
  'failed',
  'cancelled',
]);

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, supabase } = auth.context;
  const searchParams = request.nextUrl.searchParams;
  const statusFilterRaw = searchParams.get('status');
  const statusFilter = statusFilterRaw === 'STOPPED' ? 'cancelled' : statusFilterRaw;
  const workflowId = searchParams.get('workflow_id') || searchParams.get('workflowId');

  let query = supabase
    .from('wf_execution_runs')
    .select('*')
    .eq('org_id', orgId)
    .order('started_at', { ascending: false });

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  if (workflowId) {
    query = query.eq('workflow_id', workflowId);
  }

  const { data: runs, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { runs: runs || [] },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }
  );
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, supabase } = auth.context;

  try {
    const body = await request.json();
    const workflow_id = body.workflow_id || body.workflowId;
    let status = body.status;
    if (status === 'STOPPED') {
      status = 'cancelled';
    }
    const total_items_discovered = body.total_items_discovered ?? body.totalItemsDiscovered ?? 0;

    if (!workflow_id) {
      return NextResponse.json(
        { error: 'Missing required field: workflow_id' },
        { status: 400 }
      );
    }

    const runStatus: RunStatus = (status as RunStatus) || 'pending';
    if (!VALID_STATUSES.has(runStatus)) {
      return NextResponse.json(
        { error: `Invalid status: '${runStatus}'. Valid statuses are: ${Array.from(VALID_STATUSES).join(', ')}` },
        { status: 400 }
      );
    }

    // Ensure workflow exists in authenticated caller's organization
    const { data: existingWorkflow } = await supabase
      .from('wf_workflows')
      .select('id, workflow_definition, filter_rules')
      .eq('id', workflow_id)
      .eq('org_id', orgId)
      .maybeSingle();

    if (!existingWorkflow) {
      return NextResponse.json(
        { error: 'Workflow not found in organization' },
        { status: 404 }
      );
    }

    const currentDef = (existingWorkflow.workflow_definition && typeof existingWorkflow.workflow_definition === 'object')
      ? existingWorkflow.workflow_definition as Record<string, unknown>
      : {};

    const steps = Array.isArray(currentDef.steps) && currentDef.steps.length > 0
      ? currentDef.steps
      : (Array.isArray(currentDef.actions) ? currentDef.actions : []);
    // Single source of truth for loop intent: recorder metadata, visual-editor
    // compile, per-step flags and extraction steps. Keeps the persisted run
    // config in sync with what the engine will actually execute.
    const loopSignals = deriveLoopSignals(currentDef, steps);

    // Validate and normalize loop configuration if provided in body or workflow
    let loopConfig = body.loop !== undefined ? body.loop : (loopSignals.loop || null);
    if (loopConfig && loopConfig.enabled !== false) {
      const validation = validateLoopConfig(loopConfig, steps.length);
      if (!validation.valid) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 }
        );
      }
    }

    // Determine loop execution mode
    const hasExplicitMode = body.mode !== undefined || body.isLoop !== undefined;
    const isLoopCandidate = loopSignals.isLoop;
    const mode = hasExplicitMode
      ? (body.mode || (body.isLoop ? 'loop' : 'single'))
      : (loopConfig?.enabled ? 'loop' : (isLoopCandidate ? 'loop' : 'single'));
    const isLoop = hasExplicitMode
      ? Boolean(body.isLoop ?? (mode === 'loop'))
      : (loopConfig ? Boolean(loopConfig.enabled) : isLoopCandidate);

    // Determine loop step index
    const hasExplicitLoopStepIndex = body.loopStepIndex !== undefined || body.loop_step_index !== undefined;
    const explicitLoopStepIndex = body.loopStepIndex !== undefined ? body.loopStepIndex : body.loop_step_index;
    const loopStepIndex = hasExplicitLoopStepIndex
      ? (explicitLoopStepIndex !== null ? Number(explicitLoopStepIndex) : null)
      : (loopConfig?.anchorStepIndex ?? loopSignals.loopStepIndex);

    // Determine loop limit
    const hasExplicitLoopLimit = body.loopLimit !== undefined || body.loop_limit !== undefined;
    const explicitLoopLimit = body.loopLimit !== undefined ? body.loopLimit : body.loop_limit;
    const loopLimit = hasExplicitLoopLimit
      ? (explicitLoopLimit !== null ? Number(explicitLoopLimit) : null)
      : (Number(total_items_discovered) > 0
          ? Number(total_items_discovered)
          : (loopConfig?.maxItems !== undefined && loopConfig?.maxItems !== null
              ? Number(loopConfig.maxItems)
              : (currentDef.loopLimit !== undefined && currentDef.loopLimit !== null ? Number(currentDef.loopLimit) : null)));

    // Determine item filter
    const hasExplicitItemFilter = body.itemFilter !== undefined || body.item_filter !== undefined;
    const explicitItemFilter = body.itemFilter !== undefined ? body.itemFilter : body.item_filter;
    let itemFilter = hasExplicitItemFilter
      ? explicitItemFilter
      : (currentDef.itemFilter !== undefined ? currentDef.itemFilter : null);

    if (body.nestedLoop || body.newOnly !== undefined) {
      if (typeof itemFilter === 'object' && itemFilter !== null) {
        itemFilter = {
          ...itemFilter,
          ...(body.nestedLoop ? { nestedLoop: body.nestedLoop } : {}),
          ...(body.newOnly !== undefined ? { newOnly: body.newOnly } : {})
        };
      } else {
        itemFilter = {
          ...(body.nestedLoop ? { nestedLoop: body.nestedLoop } : {}),
          ...(body.newOnly !== undefined ? { newOnly: body.newOnly } : {})
        };
      }
    }

    // The execution configuration is stored on the run row below. It is
    // deliberately NOT written back to the workflow: a one-off run used to
    // permanently rewrite the published workflow for every other user.

    const { data: newRun, error } = await supabase
      .from('wf_execution_runs')
      .insert({
        org_id: orgId,
        workflow_id,
        status: runStatus,
        total_items_discovered: Number(total_items_discovered) || 0,
        items_processed: 0,
        items_downloaded: 0,
        started_at: new Date().toISOString(),
        // Run-level execution config (C-07): the runner reads these directly
        // off the run row, so concurrent runs cannot clobber each other via
        // the shared workflow definition.
        mode,
        is_loop: isLoop,
        loop_step_index: loopStepIndex,
        loop_limit: loopLimit,
        item_filter: itemFilter || null,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      run: {
        ...newRun,
        mode,
        isLoop,
        loopStepIndex,
        loopLimit,
        itemFilter,
        loop: loopConfig,
      }
    }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid JSON body';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, supabase } = auth.context;

  try {
    const body = await request.json();
    const runId = body.run_id || body.runId || body.id;
    let status = body.status;
    if (status === 'STOPPED') {
      status = 'cancelled';
    }
    const items_processed = body.items_processed !== undefined ? body.items_processed : body.itemsProcessed;
    const items_downloaded = body.items_downloaded !== undefined ? body.items_downloaded : body.itemsDownloaded;
    const error_summary = body.error_summary !== undefined ? body.error_summary : body.errorSummary;
    const completed_at = body.completed_at !== undefined ? body.completed_at : body.completedAt;
    const total_items_discovered = body.total_items_discovered !== undefined ? body.total_items_discovered : body.totalItemsDiscovered;

    if (!runId) {
      return NextResponse.json({ error: 'Missing required field: run_id' }, { status: 400 });
    }

    // Fetch existing run
    const { data: currentRun, error: fetchError } = await supabase
      .from('wf_execution_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();

    if (fetchError || !currentRun) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Org authorization check
    if (currentRun.org_id !== orgId) {
      return NextResponse.json(
        { error: 'Unauthorized: Run belongs to a different organization' },
        { status: 403 }
      );
    }

    // Enforce atomic status transition
    if (status !== undefined && status !== currentRun.status) {
      if (!VALID_STATUSES.has(status)) {
        return NextResponse.json(
          { error: `Invalid status: '${status}'. Valid statuses are: ${Array.from(VALID_STATUSES).join(', ')}` },
          { status: 400 }
        );
      }

      const allowedTransitions = ALLOWED_TRANSITIONS[currentRun.status as RunStatus] || [];
      if (!allowedTransitions.includes(status as RunStatus)) {
        return NextResponse.json(
          {
            error: `Invalid status transition from '${currentRun.status}' to '${status}'`,
            current_status: currentRun.status,
            requested_status: status,
            allowed_transitions: allowedTransitions,
          },
          { status: 409 }
        );
      }
    }

    const updatePayload: Record<string, unknown> = {};
    if (status !== undefined) {
      updatePayload.status = status;
    }
    if (items_processed !== undefined) {
      updatePayload.items_processed = Number(items_processed);
    }
    if (items_downloaded !== undefined) {
      updatePayload.items_downloaded = Number(items_downloaded);
    }
    if (total_items_discovered !== undefined) {
      updatePayload.total_items_discovered = Number(total_items_discovered);
    }
    if (error_summary !== undefined) {
      updatePayload.error_summary = error_summary;
    }
    if (completed_at !== undefined) {
      updatePayload.completed_at = completed_at;
    } else if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
    ) {
      if (!currentRun.completed_at) {
        updatePayload.completed_at = new Date().toISOString();
      }
    }

    // Atomic conditional compare-and-swap
    let updateQuery = supabase
      .from('wf_execution_runs')
      .update(updatePayload)
      .eq('id', runId)
      .eq('org_id', orgId);

    if (status !== undefined && status !== currentRun.status) {
      updateQuery = updateQuery.eq('status', currentRun.status);
    }

    const { data: updatedRun, error: updateError } = await updateQuery
      .select()
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    if (!updatedRun) {
      return NextResponse.json(
        {
          error: 'Conflict: Run status was updated concurrently by another runner',
          current_status: currentRun.status,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ run: updatedRun }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid JSON body';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
