import { NextRequest, NextResponse } from 'next/server';
import { authenticateRunnerOrUser } from '@/lib/auth/runner-auth';
import { WorkflowDefinition } from '@/lib/types/database';
import { normalizeLoopFlags } from '@/lib/workflows/loop-signals';

export async function GET(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, supabase } = auth.context;

  const workflowId =
    request.nextUrl.searchParams.get('id') ||
    request.nextUrl.searchParams.get('workflow_id');

  if (workflowId) {
    const { data: workflow, error } = await supabase
      .from('wf_workflows')
      .select('*')
      .eq('id', workflowId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!workflow) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }

    return NextResponse.json({ workflow, workflows: [workflow] });
  }

  const isFull = request.nextUrl.searchParams.get('full') === 'true';

  if (isFull) {
    const { data: workflows, error } = await supabase
      .from('wf_workflows')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ workflows: workflows || [] });
  }

  const { data: workflows, error } = await supabase
    .from('wf_workflows')
    .select('id, org_id, name, portal_url, schema_version, created_by, created_at, updated_at, filter_rules, steps:workflow_definition->steps')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const sanitizedWorkflows = (workflows || []).map((w: any) => ({
    id: w.id,
    org_id: w.org_id,
    name: w.name,
    portal_url: w.portal_url,
    schema_version: w.schema_version,
    created_by: w.created_by,
    created_at: w.created_at,
    updated_at: w.updated_at,
    filter_rules: w.filter_rules || {},
    workflow_definition: {
      steps: Array.isArray(w.steps)
        ? w.steps.map((s: any) => ({
            id: s?.id,
            type: s?.type,
            action: s?.action || s?.type,
            target: { elementName: s?.target?.elementName || s?.elementName },
          }))
        : [],
      start_url: w.portal_url,
    },
  }));

  return NextResponse.json({ workflows: sanitizedWorkflows });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, userId, supabase } = auth.context;

  try {
    const body = await request.json();
    const {
      name,
      portal_url,
      workflow_definition,
      filter_rules,
      upload_to_cloud,
      target_folder,
    } = body;

    if (!name || !portal_url) {
      return NextResponse.json(
        { error: 'Missing required fields: name, portal_url' },
        { status: 400 }
      );
    }

    const baseDefinition: WorkflowDefinition =
      typeof workflow_definition === 'object' && workflow_definition !== null
        ? { ...workflow_definition }
        : {};

    // Incorporate hybrid storage preferences into workflow_definition, then
    // normalize loop intent (recorder writes it under metadata, the visual
    // editor at the top level) so every reader sees the same answer.
    const finalDefinition: WorkflowDefinition = normalizeLoopFlags({
      ...baseDefinition,
      upload_to_cloud:
        upload_to_cloud !== undefined
          ? Boolean(upload_to_cloud)
          : Boolean(baseDefinition.upload_to_cloud ?? false),
      target_folder:
        target_folder !== undefined
          ? String(target_folder)
          : String(baseDefinition.target_folder ?? ''),
    }) as WorkflowDefinition;

    const { data: newWorkflow, error } = await supabase
      .from('wf_workflows')
      .insert({
        org_id: orgId,
        name,
        portal_url,
        workflow_definition: finalDefinition,
        filter_rules: filter_rules || {},
        created_by: userId || null,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ workflow: newWorkflow }, { status: 201 });
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
    const workflowId = body.workflow_id || body.id;
    const {
      name,
      portal_url,
      workflow_definition,
      filter_rules,
      upload_to_cloud,
      target_folder,
    } = body;

    if (!workflowId) {
      return NextResponse.json(
        { error: 'Missing required field: workflow_id' },
        { status: 400 }
      );
    }

    const { data: currentWf, error: fetchError } = await supabase
      .from('wf_workflows')
      .select('*')
      .eq('id', workflowId)
      .maybeSingle();

    if (fetchError || !currentWf) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }

    if (currentWf.org_id !== orgId) {
      return NextResponse.json(
        { error: 'Unauthorized: Workflow belongs to a different organization' },
        { status: 403 }
      );
    }

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (name !== undefined) updatePayload.name = name;
    if (portal_url !== undefined) updatePayload.portal_url = portal_url;
    if (filter_rules !== undefined) updatePayload.filter_rules = filter_rules;

    let updatedDefinition: WorkflowDefinition =
      typeof currentWf.workflow_definition === 'object' && currentWf.workflow_definition !== null
        ? { ...currentWf.workflow_definition }
        : {};
    let definitionModified = false;

    if (workflow_definition !== undefined && typeof workflow_definition === 'object' && workflow_definition !== null) {
      updatedDefinition = { ...updatedDefinition, ...workflow_definition };
      definitionModified = true;
    }

    if (upload_to_cloud !== undefined) {
      updatedDefinition.upload_to_cloud = Boolean(upload_to_cloud);
      definitionModified = true;
    }

    if (target_folder !== undefined) {
      updatedDefinition.target_folder = String(target_folder);
      definitionModified = true;
    }

    if (definitionModified) {
      updatedDefinition = normalizeLoopFlags(updatedDefinition) as WorkflowDefinition;
      updatePayload.workflow_definition = updatedDefinition;
    }

    const { data: updatedWorkflow, error: updateError } = await supabase
      .from('wf_workflows')
      .update(updatePayload)
      .eq('id', workflowId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ workflow: updatedWorkflow }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid JSON body';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { orgId, supabase } = auth.context;

  try {
    let workflowId: string | null = null;

    // Check query params first
    const searchParams = request.nextUrl.searchParams;
    workflowId = searchParams.get('id') || searchParams.get('workflow_id');

    // If not in query params, inspect body if present
    if (!workflowId) {
      try {
        const body = await request.json();
        workflowId = body.workflow_id || body.id || null;
      } catch {
        // Body may be empty if provided via query param
      }
    }

    if (!workflowId) {
      return NextResponse.json(
        { error: 'Missing required field: workflow_id' },
        { status: 400 }
      );
    }

    // Verify workflow exists and belongs to this organization
    const { data: existingWf, error: fetchError } = await supabase
      .from('wf_workflows')
      .select('id, name, org_id')
      .eq('id', workflowId)
      .maybeSingle();

    if (fetchError || !existingWf) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }

    if (existingWf.org_id !== orgId) {
      return NextResponse.json(
        { error: 'Unauthorized: Workflow belongs to a different organization' },
        { status: 403 }
      );
    }

    // Guard: Prevent deletion if any run is currently active (pending, running, requires_action)
    const { data: activeRuns, error: activeRunsError } = await supabase
      .from('wf_execution_runs')
      .select('id, status')
      .eq('workflow_id', workflowId)
      .in('status', ['pending', 'running', 'requires_action']);

    if (activeRunsError) {
      return NextResponse.json({ error: activeRunsError.message }, { status: 500 });
    }

    if (activeRuns && activeRuns.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot delete workflow while an execution run is active. Please stop the run first.',
          active_run_id: activeRuns[0].id,
          active_run_status: activeRuns[0].status,
        },
        { status: 409 }
      );
    }

    // Cascade delete: find all runs for this workflow
    const { data: wfRuns } = await supabase
      .from('wf_execution_runs')
      .select('id')
      .eq('workflow_id', workflowId);

    if (wfRuns && wfRuns.length > 0) {
      const runIds = wfRuns.map((r: { id: string }) => r.id);
      // Delete associated artifacts
      await supabase
        .from('wf_run_artifacts')
        .delete()
        .in('run_id', runIds);

      // Delete associated execution runs
      await supabase
        .from('wf_execution_runs')
        .delete()
        .eq('workflow_id', workflowId);
    }

    // Delete the workflow itself
    const { error: deleteError } = await supabase
      .from('wf_workflows')
      .delete()
      .eq('id', workflowId)
      .eq('org_id', orgId);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `Workflow '${existingWf.name}' and associated history deleted successfully`,
      id: workflowId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

