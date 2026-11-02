import { NextRequest, NextResponse } from 'next/server';
import { authenticateRunnerOrUser } from '@/lib/auth/runner-auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;

function cleanStringValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (EXPANDER_GLYPH_REGEX.test(str)) return '';
  str = str.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
  return str;
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
) {
  const auth = await authenticateRunnerOrUser(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { id } = await params;
  const { orgId, supabase } = auth.context;

  if (!id) {
    return NextResponse.json({ error: 'Missing workflow ID' }, { status: 400 });
  }

  const { data: workflow, error } = await supabase
    .from('wf_workflows')
    .select('*')
    .eq('id', id)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!workflow) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const fields = new Set<string>();
  const fieldValuesMap: Record<string, string[]> = {};

  const addVal = (field: string, val: unknown) => {
    const clean = cleanStringValue(val);
    if (!clean) return;
    const k = field.trim();
    if (!fieldValuesMap[k]) fieldValuesMap[k] = [];
    if (!fieldValuesMap[k].includes(clean)) {
      fieldValuesMap[k].push(clean);
    }
  };

  const addCol = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    let str = raw.trim();
    if (!str || str.length > 50 || str.startsWith('{') || str.startsWith('<')) return;
    if (EXPANDER_GLYPH_REGEX.test(str)) return;
    str = str.replace(/^(click|select|enter|type|open|download|view|press)\s+/i, '').trim();
    if (!str || str.length > 50) return;
    fields.add(str);
  };

  // 1. From workflow filter_rules
  const fr = (workflow.filter_rules || {}) as Record<string, unknown>;
  if (Array.isArray(fr.available_fields)) fr.available_fields.forEach(addCol);
  if (Array.isArray(fr.columns)) fr.columns.forEach(addCol);
  if (fr.fieldValues && typeof fr.fieldValues === 'object') {
    Object.entries(fr.fieldValues).forEach(([k, vals]) => {
      if (Array.isArray(vals)) vals.forEach(v => addVal(k, v));
    });
  }

  // 2. From workflow_definition
  const wd = (workflow.workflow_definition || {}) as Record<string, unknown>;
  if (Array.isArray(wd.available_fields)) wd.available_fields.forEach(addCol);
  if (Array.isArray(wd.columns)) wd.columns.forEach(addCol);
  if (wd.fieldValues && typeof wd.fieldValues === 'object') {
    Object.entries(wd.fieldValues).forEach(([k, vals]) => {
      if (Array.isArray(vals)) vals.forEach(v => addVal(k, v));
    });
  }

  // 3. From steps
  const steps = Array.isArray(wd.steps) && wd.steps.length > 0
    ? wd.steps
    : (Array.isArray(wd.actions) ? wd.actions : []);

  steps.forEach((step: any) => {
    if (!step) return;
    addCol(step.extract_column);
    addCol(step.column);
    addCol(step.field);
    addCol(step.columnName);
    addCol(step.headerName);

    const target = step.target || {};
    addCol(target.elementName);
    addCol(target.friendlyName);
    addCol(step.elementName);

    const targetField = step.extract_column || step.column || step.field ||
      target.fingerprint?.columnName || step.fingerprint?.columnName ||
      target.fingerprint?.headerName || step.fingerprint?.headerName ||
      target.friendlyName || target.elementName || step.elementName;

    const fp = target.fingerprint || step.fingerprint;
    if (fp) {
      addCol(fp.columnName);
      addCol(fp.headerName);
      if (fp.attributes && typeof fp.attributes === 'object') {
        addCol(fp.attributes['data-column']);
        addCol(fp.attributes['data-field']);
        addCol(fp.attributes['name']);
        addCol(fp.attributes['id']);
        addCol(fp.attributes['aria-label']);
        addCol(fp.attributes['placeholder']);
      }
    }

    if (Array.isArray(step.options)) {
      step.options.forEach((opt: any) => {
        const text = typeof opt === 'string' ? opt : (opt.text || opt.label || opt.value);
        if (targetField) addVal(targetField, text);
        addVal('Type', text);
      });
    }

    if (step.value && typeof step.value === 'string' && !step.value.startsWith('{{')) {
      if (targetField) addVal(targetField, step.value);
    }
  });

  // 4. Extract any captured sample items or table rows
  const sampleItems: Array<any> = Array.isArray(fr.sampleItems) && fr.sampleItems.length > 0
    ? fr.sampleItems
    : (Array.isArray(wd.sampleItems) ? wd.sampleItems : []);

  // 5. Default portal fields
  ['Type', 'Status', 'Invoice Number', 'Due Date', 'Amount'].forEach(addCol);
  const defaults: Record<string, string[]> = {
    Type: ['Invoice', 'Bill', 'Statement', 'Credit Note', 'Receipt', 'Payment', 'Order'],
    Status: ['Open', 'Pending', 'Paid', 'Overdue', 'Unpaid', 'Draft', 'Closed', 'Processing', 'Active'],
    Priority: ['High', 'Normal', 'Low', 'Urgent'],
  };
  Object.entries(defaults).forEach(([col, defVals]) => {
    defVals.forEach((val) => addVal(col, val));
  });

  return NextResponse.json({
    success: true,
    workflow_id: id,
    collectionType: 'table-row',
    availableFields: Array.from(fields),
    fieldValues: fieldValuesMap,
    itemCount: sampleItems.length,
    items: sampleItems.slice(0, 50)
  });
}
