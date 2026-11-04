'use client';

import React, { useState, useEffect } from 'react';
import { 
  Play, 
  X, 
  Layers, 
  Repeat, 
  AlertCircle, 
  CheckCircle, 
  Cpu, 
  Settings2, 
  Globe, 
  Loader2,
  ListFilter,
  Plus,
  Trash2,
  RefreshCw,
  Clock,
  Eye
} from 'lucide-react';
import { Workflow } from '@/lib/types/database';
import { DrawerRunItem } from './RunDetailsDrawer';
import { useDashboard } from '@/context/DashboardContext';
import { deriveLoopSignals } from '@/lib/workflows/loop-signals';

interface ExecutionPreflightModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflow: Workflow | null;
  onRunDispatched?: (run: DrawerRunItem) => void;
}

interface FilterConditionRow {
  id: string;
  field: string;
  customField: string;
  operator: 'contains' | 'equals' | 'dateBetween';
  value: string;
  dateFrom: string;
  dateTo: string;
}

function formatDomain(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function getWorkflowSteps(workflow: Workflow | null): any[] {
  if (!workflow) return [];
  const wd = (workflow.workflow_definition || {}) as Record<string, unknown>;
  if (Array.isArray(wd.steps) && wd.steps.length > 0) return wd.steps;
  if (Array.isArray(wd.actions) && wd.actions.length > 0) return wd.actions;
  const wf = workflow as any;
  if (Array.isArray(wf.steps) && wf.steps.length > 0) return wf.steps;
  if (Array.isArray(wf.actions) && wf.actions.length > 0) return wf.actions;
  return [];
}

function detectLoopCandidate(steps: Array<any>, savedIndex?: unknown): number {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  if (typeof savedIndex === 'number' && Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < steps.length) {
    return savedIndex;
  }

  // 1. Explicit role === 'LOOP' or step marked with loop
  const roleIdx = steps.findIndex(
    (s: any) => s && (s.role === 'LOOP' || s.isLoopCandidate === true || s.isLoop === true || s.loopMode === 'sequential_iteration')
  );
  if (roleIdx >= 0) return roleIdx;

  // Helper to identify auth, login, setup inputs, and navigation actions
  const isAuthOrSetup = (s: any) => {
    if (!s) return false;
    const name = String(s.name || s.elementName || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const type = String(s.type || s.action || '').toUpperCase();
    const tag = String(s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toLowerCase();
    const inputType = String(s.target?.fingerprint?.type || s.fingerprint?.type || '').toLowerCase();
    if (type === 'NAVIGATE') return true;
    if (/(username|password|email|sign[-_\s]*in|login|authenticat)/i.test(name)) return true;
    if (tag === 'input' && (inputType === 'password' || inputType === 'email')) return true;
    return false;
  };

  // 2. Step targeting table rows, grid cells, or records (prioritized over all other patterns)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isAuthOrSetup(s)) continue;

    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();
    const text = (s.name || s.elementName || s.description || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');

    const isTableRowOrGrid = Boolean(
      tag === 'TR' ||
      tag === 'TD' ||
      role === 'row' ||
      role === 'gridcell' ||
      /\b(table\[\d+\]|table:nth-of-type|tbody\s*>\s*tr|tr:nth-(?:child|of-type)|\[role=["']row["']\]|\[role=["']gridcell["']\]|\.x-grid-row|\.x-grid-item|\.x-grid-cell|\.data-row|\.grid-row)\b/i.test(selectors) ||
      /\b(table\s*row|grid\s*row|invoice\s*row|row\s*item)\b/i.test(text)
    );

    if (isTableRowOrGrid) return i;
  }

  // 3. Dropdown options or list items
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isAuthOrSetup(s)) continue;

    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');

    const isOptionOrListItem = Boolean(
      tag === 'MAT-OPTION' || tag === 'OPTION' || tag === 'LI' ||
      role === 'option' || role === 'listitem' ||
      /\b(mat-option|\[role=["']option["']\]|select\s*>\s*option|li:nth-child)\b/i.test(selectors)
    );

    if (isOptionOrListItem) return i;
  }

  // 4. Fallback: find the first non-login non-setup business action
  const nonLoginIdx = steps.findIndex((s: any, idx: number) => {
    if (idx === 0) return false;
    return !isAuthOrSetup(s);
  });
  if (nonLoginIdx >= 0) return nonLoginIdx;

  if (steps.length > 1) return 1;
  return 0;
}

function extractWorkflowColumns(workflow: Workflow | null): string[] {
  if (!workflow) return ['Type', 'Status', 'Invoice Number', 'Due Date', 'Amount'];
  const fields = new Set<string>();

  const IGNORED_COLUMN_NAMES = /^(select|selection|checkbox|actions?|operations?|manage|controls?|tools?|_cells|_rawtext|text|label|fulltext|username(\s*input)?|email|password(\s*password\s*field)?|login(\s*button)?|sign\s*in|company(\s*input|\s*link)?|close(\s*button)?|submit|button|element|click|open\s*selected|scroll.*)$/i;

  const addCleanCol = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    let str = raw.trim();
    if (!str || str.length > 50 || str.startsWith('{') || str.startsWith('<')) return;
    if (EXPANDER_GLYPH_REGEX.test(str)) return;
    if (IGNORED_COLUMN_NAMES.test(str)) return;
    str = str.replace(/^(click|select|enter|type|open|download|view|press)\s+/i, '').trim();
    if (!str || str.length > 50) return;
    if (IGNORED_COLUMN_NAMES.test(str)) return;
    // Exclude action buttons, input fields, interactive control names, and document ID tokens from table column list
    if (/\b(button|link|input|field|element)\b/i.test(str) && !/^(Invoice|Payment|Customer|Company|Date)\s+Field$/i.test(str)) return;
    if (/^(open selected|export a report|save it to the disk)/i.test(str)) return;
    if (/^[A-Z]{2,4}-\d+/i.test(str)) return;
    fields.add(str);
  };

  // 1. From workflow filter_rules (Highest priority: actual captured table headers)
  const fr = (workflow.filter_rules || {}) as Record<string, unknown>;
  if (Array.isArray(fr.available_fields)) fr.available_fields.forEach(addCleanCol);
  if (Array.isArray(fr.columns)) fr.columns.forEach(addCleanCol);
  if (fr.fieldValues && typeof fr.fieldValues === 'object') {
    Object.keys(fr.fieldValues).forEach(addCleanCol);
  }

  // 2. From workflow_definition
  const wd = (workflow.workflow_definition || {}) as Record<string, unknown>;
  if (Array.isArray(wd.available_fields)) wd.available_fields.forEach(addCleanCol);
  if (Array.isArray(wd.columns)) wd.columns.forEach(addCleanCol);
  const wdFr = (wd.filter_rules || {}) as Record<string, unknown>;
  if (Array.isArray(wdFr.available_fields)) wdFr.available_fields.forEach(addCleanCol);
  if (Array.isArray(wdFr.columns)) wdFr.columns.forEach(addCleanCol);
  if (wdFr.fieldValues && typeof wdFr.fieldValues === 'object') {
    Object.keys(wdFr.fieldValues).forEach(addCleanCol);
  }

  // 3. From table context in recorded steps
  const steps = getWorkflowSteps(workflow);
  steps.forEach((step: any) => {
    if (!step) return;
    addCleanCol(step.extract_column);
    addCleanCol(step.column);
    addCleanCol(step.columnName);
    addCleanCol(step.headerName);

    if (step.context) {
      if (Array.isArray(step.context.columns)) step.context.columns.forEach(addCleanCol);
      if (Array.isArray(step.context.table?.headers)) step.context.table.headers.forEach(addCleanCol);
      if (step.context.fieldValues && typeof step.context.fieldValues === 'object') {
        Object.keys(step.context.fieldValues).forEach(addCleanCol);
      }
    }

    const fp = step.target?.fingerprint || step.fingerprint;
    if (fp) {
      addCleanCol(fp.columnName);
      addCleanCol(fp.headerName);
      if (fp.attributes && typeof fp.attributes === 'object') {
        addCleanCol(fp.attributes['data-column']);
        addCleanCol(fp.attributes['data-field']);
      }
    }
  });

  // If table columns were captured, return them cleanly
  if (fields.size > 0) {
    return Array.from(fields);
  }

  // Fallback common table fields only if no columns were discovered
  const commonFields = ['Type', 'Status', 'Invoice Number', 'Due Date', 'Amount'];
  commonFields.forEach(addCleanCol);

  return Array.from(fields);
}

const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;

function cleanStringValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (EXPANDER_GLYPH_REGEX.test(str)) return '';
  str = str.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
  return str;
}

function isDateField(fieldName: string): boolean {
  if (!fieldName) return false;
  return /date|due|created|posted|time|expire|billing/i.test(fieldName.trim());
}

function getTodayIsoDate(): string {
  return new Date().toISOString().split('T')[0];
}

function extractFieldValuesMap(workflow: Workflow | null): Record<string, string[]> {
  const result: Record<string, Set<string>> = {};

  const addValue = (field: string, val: unknown) => {
    const cleaned = cleanStringValue(val);
    if (!cleaned) return;
    const fKey = field.trim();
    if (!result[fKey]) {
      result[fKey] = new Set<string>();
    }
    result[fKey].add(cleaned);
  };

  // 1. From workflow filter_rules
  if (workflow?.filter_rules && typeof workflow.filter_rules === 'object') {
    const fr = workflow.filter_rules as any;
    if (fr.fieldValues && typeof fr.fieldValues === 'object') {
      Object.entries(fr.fieldValues).forEach(([k, vals]) => {
        if (Array.isArray(vals)) {
          vals.forEach((v) => addValue(k, v));
        }
      });
    }
    const savedFilter = fr.itemFilter || fr;
    if (Array.isArray(savedFilter.conditions)) {
      savedFilter.conditions.forEach((c: any) => {
        if (c.field && c.value && typeof c.value === 'string') {
          addValue(c.field, c.value);
        }
      });
    }
  }

  // 2. From workflow_definition and steps
  if (workflow?.workflow_definition && typeof workflow.workflow_definition === 'object') {
    const wd = workflow.workflow_definition as any;
    if (wd.fieldValues && typeof wd.fieldValues === 'object') {
      Object.entries(wd.fieldValues).forEach(([k, vals]) => {
        if (Array.isArray(vals)) {
          vals.forEach((v) => addValue(k, v));
        }
      });
    }
    if (wd.filter_rules?.fieldValues && typeof wd.filter_rules.fieldValues === 'object') {
      Object.entries(wd.filter_rules.fieldValues).forEach(([k, vals]) => {
        if (Array.isArray(vals)) {
          vals.forEach((v) => addValue(k, v));
        }
      });
    }
  }

  const steps = getWorkflowSteps(workflow);
  steps.forEach((step: any) => {
    if (!step) return;
    const targetField = step.extract_column || step.column || step.field ||
      step.target?.fingerprint?.columnName || step.fingerprint?.columnName ||
      step.target?.fingerprint?.headerName || step.fingerprint?.headerName ||
      step.context?.table?.activeColumn ||
      step.target?.friendlyName || step.target?.elementName || step.elementName;

    if (step.context) {
      if (step.context.fieldValues && typeof step.context.fieldValues === 'object') {
        Object.entries(step.context.fieldValues).forEach(([k, vals]) => {
          if (Array.isArray(vals)) vals.forEach((v) => addValue(k, v));
        });
      }
      if (step.context.table?.rowValues && typeof step.context.table.rowValues === 'object') {
        Object.entries(step.context.table.rowValues).forEach(([k, vals]) => {
          if (Array.isArray(vals)) vals.forEach((v) => addValue(k, v));
        });
      }
    }

    if (Array.isArray(step.options)) {
      step.options.forEach((opt: any) => {
        const text = typeof opt === 'string' ? opt : (opt.text || opt.label || opt.value);
        if (targetField) addValue(targetField, text);
        addValue('Type', text);
      });
    }
    if (Array.isArray(step.selectOptions)) {
      step.selectOptions.forEach((opt: any) => {
        const text = typeof opt === 'string' ? opt : (opt.text || opt.label || opt.value);
        if (targetField) addValue(targetField, text);
        addValue('Type', text);
      });
    }

    if (step.value && typeof step.value === 'string' && !step.value.startsWith('{{')) {
      if (targetField) addValue(targetField, step.value);
      if (/SI-|INV-|DR-|TX-|CM-|\b\d{4,10}\b/i.test(step.value)) {
        addValue('Invoice Number', step.value);
      }
    }

    const fpText = step.target?.fingerprint?.text || step.fingerprint?.text;
    if (fpText && typeof fpText === 'string' && fpText.length < 50) {
      if (targetField) addValue(targetField, fpText);
      if (/SI-|INV-|DR-|TX-|CM-|\b\d{4,10}\b/i.test(fpText)) {
        addValue('Invoice Number', fpText);
      }
    }
  });

  // 3. Domain defaults for common columns
  const defaults: Record<string, string[]> = {
    Type: ['Invoice', 'Bill', 'Statement', 'Credit Note', 'Receipt', 'Payment', 'Order'],
    Status: ['Open', 'Pending', 'Paid', 'Overdue', 'Unpaid', 'Draft', 'Closed', 'Processing', 'Active'],
    Priority: ['High', 'Normal', 'Low', 'Urgent'],
  };

  Object.entries(defaults).forEach(([col, defVals]) => {
    defVals.forEach((val) => addValue(col, val));
  });

  const finalMap: Record<string, string[]> = {};
  Object.entries(result).forEach(([k, valSet]) => {
    finalMap[k] = Array.from(valSet).slice(0, 30);
  });
  return finalMap;
}

function formatStepLabel(step: any, idx: number): string {
  if (!step) return `Step #${idx + 1}`;
  const label = step.name || step.elementName || step.target?.friendlyName || step.target?.elementName || step.description || step.type || 'Action';
  const role = step.role === 'LOOP' ? ' [LOOP]' : '';
  return `Step #${idx + 1}: ${label}${role}`;
}

export function ExecutionPreflightModal({
  isOpen,
  onClose,
  workflow,
  onRunDispatched
}: ExecutionPreflightModalProps) {
  const { orgId, isRunnerOnline, refreshDashboard, openRunDetails } = useDashboard();
  const [execMode, setExecMode] = useState<'single' | 'loop'>('single');
  const [maxItems, setMaxItems] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Simple-loop configuration state (anchor, start, end)
  const [anchorStepIndex, setAnchorStepIndex] = useState<number>(0);
  const [startStepIndex, setStartStepIndex] = useState<number>(0);
  const [endStepIndex, setEndStepIndex] = useState<number>(0);
  const [loopStepIndex, setLoopStepIndex] = useState<number>(0);
  const [autoDetectedIndex, setAutoDetectedIndex] = useState<number>(0);

  // Two-level (nested) loop state: Company (Outer) -> Record/Invoice (Inner)
  const [isTwoLevel, setIsTwoLevel] = useState<boolean>(false);
  const [outerAnchorIndex, setOuterAnchorIndex] = useState<number>(0);
  const [outerStartIndex, setOuterStartIndex] = useState<number>(0);
  const [outerEndIndex, setOuterEndIndex] = useState<number>(0);
  const [outerMaxItems, setOuterMaxItems] = useState<string>('');
  const [innerAnchorIndex, setInnerAnchorIndex] = useState<number>(0);
  const [innerStartIndex, setInnerStartIndex] = useState<number>(0);
  const [innerEndIndex, setInnerEndIndex] = useState<number>(0);
  const [innerMaxItems, setInnerMaxItems] = useState<string>('');
  const [newOnly, setNewOnly] = useState<boolean>(false);

  // Discovered records preview state
  const [discoveredRecords, setDiscoveredRecords] = useState<Array<any>>([]);
  const [discoveredCollectionType, setDiscoveredCollectionType] = useState<string>('table-row');
  const [discoveredItemCount, setDiscoveredItemCount] = useState<number>(0);

  // Filter rules state
  const [filterEnabled, setFilterEnabled] = useState<boolean>(false);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const [fieldValuesMap, setFieldValuesMap] = useState<Record<string, string[]>>({});
  const [activeField, setActiveField] = useState<string>('Type');
  const [scanningColumns, setScanningColumns] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [conditions, setConditions] = useState<FilterConditionRow[]>([
    {
      id: 'c_initial',
      field: 'Type',
      customField: '',
      operator: 'contains',
      value: '',
      dateFrom: '',
      dateTo: '',
    }
  ]);

  useEffect(() => {
    if (workflow) {
      const steps = getWorkflowSteps(workflow);
      // Shared derivation: this is what keeps "recorded as loop" from silently
      // running as a single pass (recorder metadata + extraction steps +
      // per-step flags all feed the same answer).
      const loopSignals = deriveLoopSignals(workflow.workflow_definition, steps);
      const isConfiguredAsLoop = Boolean(
        loopSignals.isLoop ||
        (workflow as any).isLoop === true ||
        (workflow as any).mode === 'loop'
      );
      if (isConfiguredAsLoop) {
        setExecMode('loop');
      }

      const savedLoop = loopSignals.loop;
      const savedLoopIdx = savedLoop?.anchorStepIndex ?? loopSignals.loopStepIndex ?? (workflow as any).loopStepIndex;
      const bestCandidate = detectLoopCandidate(steps, savedLoopIdx);
      setAutoDetectedIndex(bestCandidate);

      const anchor = savedLoop?.anchorStepIndex ?? bestCandidate;
      const start = savedLoop?.startStepIndex ?? anchor;
      const end = savedLoop?.endStepIndex ?? (steps.length > 0 ? steps.length - 1 : start);

      setAnchorStepIndex(anchor);
      setStartStepIndex(start);
      setEndStepIndex(end);
      setLoopStepIndex(anchor);

      // Detect or restore two-level (nested) loop configuration
      const savedNested = (workflow.workflow_definition as any)?.nestedLoop ||
                          (workflow.workflow_definition as any)?.itemFilter?.nestedLoop ||
                          ((workflow.filter_rules as any)?.itemFilter?.nestedLoop);
      if (savedNested && savedNested.enabled) {
        setIsTwoLevel(true);
        if (savedNested.outer) {
          if (typeof savedNested.outer.anchorStepIndex === 'number') setOuterAnchorIndex(savedNested.outer.anchorStepIndex);
          if (typeof savedNested.outer.startStepIndex === 'number') setOuterStartIndex(savedNested.outer.startStepIndex);
          if (typeof savedNested.outer.endStepIndex === 'number') setOuterEndIndex(savedNested.outer.endStepIndex);
          if (savedNested.outer.maxItems) setOuterMaxItems(String(savedNested.outer.maxItems));
        }
        if (savedNested.inner) {
          if (typeof savedNested.inner.anchorStepIndex === 'number') setInnerAnchorIndex(savedNested.inner.anchorStepIndex);
          if (typeof savedNested.inner.startStepIndex === 'number') setInnerStartIndex(savedNested.inner.startStepIndex);
          if (typeof savedNested.inner.endStepIndex === 'number') setInnerEndIndex(savedNested.inner.endStepIndex);
          if (savedNested.inner.maxItems) setInnerMaxItems(String(savedNested.inner.maxItems));
        }
      } else if (steps.length >= 4) {
        // Sensible defaults for two-level workflows:
        // Outer anchor at step index 1 (e.g. Select Company), inner anchor at bestCandidate (e.g. Select Invoice)
        const outerCandidate = 1;
        setOuterAnchorIndex(outerCandidate);
        setOuterStartIndex(outerCandidate);
        setOuterEndIndex(steps.length - 1);
        const innerCandidate = bestCandidate > outerCandidate ? bestCandidate : Math.min(3, steps.length - 1);
        setInnerAnchorIndex(innerCandidate);
        setInnerStartIndex(innerCandidate);
        setInnerEndIndex(Math.max(innerCandidate, steps.length - 2));
      }

      // Restore NEW_ONLY state if configured
      const savedNewOnly = (workflow.workflow_definition as any)?.newOnly ??
                           (workflow.workflow_definition as any)?.itemFilter?.newOnly ??
                           ((workflow.filter_rules as any)?.itemFilter?.newOnly);
      if (typeof savedNewOnly === 'boolean') {
        setNewOnly(savedNewOnly);
      }

      const cols = extractWorkflowColumns(workflow);
      setAvailableColumns(cols);

      const valMap = extractFieldValuesMap(workflow);
      setFieldValuesMap(valMap);

      // Check if workflow has saved filter rules or captured columns/values
      const fr = (workflow.filter_rules && Object.keys(workflow.filter_rules).length > 0
        ? workflow.filter_rules
        : ((workflow.workflow_definition as any)?.filter_rules || {})) as any;
      const savedFilter = (fr.itemFilter || fr) as any;
      const hasConditions = Array.isArray(savedFilter.conditions) && savedFilter.conditions.length > 0;
      const hasCapturedRules = (Array.isArray(fr.available_fields) && fr.available_fields.length > 0) ||
        (Array.isArray(fr.columns) && fr.columns.length > 0) ||
        (fr.fieldValues && Object.keys(fr.fieldValues).length > 0);

      if (hasConditions) {
        setFilterEnabled(true);
        setMatchMode(savedFilter.matchMode === 'any' ? 'any' : 'all');
        const restored = savedFilter.conditions.map((c: any, i: number) => {
          const isDate = c.operator === 'dateBetween';
          const isKnown = cols.includes(c.field);
          return {
            id: `c_saved_${i}`,
            field: isKnown ? c.field : '__custom__',
            customField: isKnown ? '' : (c.field || ''),
            operator: (c.operator === 'dateBetween' ? 'dateBetween' : (c.operator === 'equals' ? 'equals' : 'contains')) as 'contains' | 'equals' | 'dateBetween',
            value: isDate ? '' : (typeof c.value === 'string' ? c.value : ''),
            dateFrom: isDate && typeof c.value === 'object' && c.value ? (c.value.from || '') : '',
            dateTo: isDate && typeof c.value === 'object' && c.value ? (c.value.to || '') : '',
          };
        });
        setConditions(restored);
        if (restored[0]) {
          setActiveField(restored[0].field === '__custom__' ? restored[0].customField : restored[0].field);
        }
      } else {
        const firstCol = cols[0] || 'Type';
        setActiveField(firstCol);
        setConditions([
          {
            id: 'c_initial',
            field: firstCol,
            customField: '',
            operator: 'contains',
            value: '',
            dateFrom: '',
            dateTo: '',
          }
        ]);
        setFilterEnabled(hasCapturedRules);
      }
    }
  }, [workflow, isOpen]);

  if (!isOpen || !workflow) return null;

  const domain = formatDomain(workflow.portal_url);
  const steps = getWorkflowSteps(workflow);
  const stepCount = steps.length;

  const handleAddCondition = () => {
    const defaultField = availableColumns[0] || 'Type';
    setConditions((prev) => [
      ...prev,
      {
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        field: defaultField,
        customField: '',
        operator: 'contains',
        value: '',
        dateFrom: '',
        dateTo: '',
      }
    ]);
  };

  const handleRemoveCondition = (index: number) => {
    setConditions((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleUpdateCondition = (index: number, updates: Partial<FilterConditionRow>) => {
    setConditions((prev) => prev.map((c, idx) => (idx === index ? { ...c, ...updates } : c)));
  };

  const getValuesForField = (fieldName: string): string[] => {
    if (!fieldName) return [];
    const norm = fieldName.trim().toLowerCase();
    for (const [k, vals] of Object.entries(fieldValuesMap)) {
      if (k.trim().toLowerCase() === norm) {
        return vals;
      }
    }
    return [];
  };

  const handleSelectColumnPill = (col: string) => {
    setActiveField(col);
    if (conditions.length > 0) {
      if (col === '__custom__') {
        handleUpdateCondition(0, { field: '__custom__' });
      } else {
        handleUpdateCondition(0, { field: col, customField: '' });
      }
    }
  };

  const handleSelectValuePill = (val: string) => {
    if (val === '__all__') {
      if (conditions.length > 0) {
        handleUpdateCondition(0, { value: '' });
      }
      return;
    }
    if (conditions.length > 0) {
      handleUpdateCondition(0, { value: val });
    }
  };

  const applyDatePreset = (preset: 'overdue' | 'upcoming' | 'today') => {
    const todayIso = getTodayIsoDate();
    if (preset === 'overdue') {
      handleUpdateCondition(0, {
        operator: 'dateBetween',
        dateFrom: '',
        dateTo: todayIso,
      });
    } else if (preset === 'upcoming') {
      handleUpdateCondition(0, {
        operator: 'dateBetween',
        dateFrom: todayIso,
        dateTo: '2099-12-31',
      });
    } else if (preset === 'today') {
      handleUpdateCondition(0, {
        operator: 'dateBetween',
        dateFrom: todayIso,
        dateTo: todayIso,
      });
    }
  };

  const doesRecordMatchFilter = (
    recordFields: Record<string, any>,
    rules: FilterConditionRow[],
    mode: 'all' | 'any'
  ): { matches: boolean } => {
    if (!rules || rules.length === 0) return { matches: true };
    const results: boolean[] = [];

    for (const c of rules) {
      const isCustom = c.field === '__custom__';
      const fieldName = (isCustom ? c.customField : c.field).trim();
      if (!fieldName) continue;

      let rawVal: any = undefined;
      for (const [k, v] of Object.entries(recordFields)) {
        if (k.toLowerCase() === fieldName.toLowerCase()) {
          rawVal = v;
          break;
        }
      }

      if (rawVal === undefined || rawVal === null || rawVal === '') {
        results.push(false);
        continue;
      }

      const strVal = String(rawVal).trim();
      if (c.operator === 'dateBetween') {
        const from = (c.dateFrom || '').trim();
        const to = (c.dateTo || '').trim();
        const d = strVal.slice(0, 10);
        let ok = true;
        if (from && d < from) ok = false;
        if (to && d > to) ok = false;
        results.push(ok);
      } else if (c.operator === 'equals') {
        results.push(strVal.toLowerCase() === (c.value || '').trim().toLowerCase());
      } else {
        results.push(strVal.toLowerCase().includes((c.value || '').trim().toLowerCase()));
      }
    }

    if (results.length === 0) return { matches: true };
    return { matches: mode === 'any' ? results.some(Boolean) : results.every(Boolean) };
  };

  const handleRefreshFields = async (targetWorkflow?: Workflow | null, overrideAnchorIdx?: number) => {
    const wf = targetWorkflow || workflow;
    const effectiveAnchor = Number.isInteger(overrideAnchorIdx) ? overrideAnchorIdx : anchorStepIndex;
    setScanningColumns(true);
    setScanMessage(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      // 1. Try dedicated live discovery endpoint on local desktop worker bridge
      let res = await fetch('http://127.0.0.1:49152/discover', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          workflow: wf,
          loopStepIndex: effectiveAnchor,
          anchorStepIndex: effectiveAnchor,
          url: wf?.portal_url
        })
      }).catch(() => null);

      if (!res || !res.ok) {
        res = await fetch('http://127.0.0.1:49152/api/discover', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            workflow: wf,
            loopStepIndex: effectiveAnchor,
            anchorStepIndex: effectiveAnchor,
            url: wf?.portal_url
          })
        }).catch(() => null);
      }

      if (!res || !res.ok) {
        res = await fetch('http://127.0.0.1:49152/record/status', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        }).catch(() => null);
      }

      if (!res || !res.ok) {
        if (wf?.id) {
          res = await fetch(`/api/v1/workflows/${wf.id}/discover`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => null);
        }
      }
      clearTimeout(timeoutId);

      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        const discovered = new Set<string>();
        const nextValMap: Record<string, string[]> = {};
        const appendVal = (col: string, val: unknown) => {
          const clean = cleanStringValue(val);
          if (!clean) return;
          const k = col.trim();
          if (!nextValMap[k]) nextValMap[k] = [];
          if (!nextValMap[k].includes(clean)) {
            nextValMap[k] = [...nextValMap[k], clean].slice(0, 30);
          }
        };

        if (data) {
          if (Array.isArray(data.items)) {
            setDiscoveredRecords(data.items);
          }
          if (data.itemCount !== undefined && data.itemCount !== null) {
            setDiscoveredItemCount(Number(data.itemCount) || 0);
          }
          if (data.collectionType) {
            setDiscoveredCollectionType(data.collectionType);
          }
          if (Array.isArray(data.availableFields)) {
            data.availableFields.forEach((f: any) => { if (typeof f === 'string' && f.trim()) discovered.add(f.trim()); });
          }
          if (Array.isArray(data.columns)) {
            data.columns.forEach((c: any) => { if (typeof c === 'string' && c.trim()) discovered.add(c.trim()); });
          }
          if (data.fieldValues && typeof data.fieldValues === 'object') {
            Object.entries(data.fieldValues).forEach(([k, vals]) => {
              if (Array.isArray(vals)) {
                vals.forEach((v) => appendVal(k, v));
              }
            });
          }
          if (Array.isArray(data.items)) {
            data.items.forEach((item: any) => {
              if (item && typeof item === 'object') {
                const itemFields = item.fields || item;
                Object.entries(itemFields).forEach(([k, v]) => {
                  if (typeof k === 'string' && !k.startsWith('_')) {
                    discovered.add(k.trim());
                    appendVal(k.trim(), v);
                  }
                });
              }
            });
          }
          if (Array.isArray(data.actions)) {
            data.actions.forEach((a: any) => {
              if (a.extract_column) discovered.add(String(a.extract_column).trim());
              if (a.column) discovered.add(String(a.column).trim());
              const fp = a.target?.fingerprint || a.fingerprint;
              if (fp?.columnName) discovered.add(String(fp.columnName).trim());
              if (fp?.headerName) discovered.add(String(fp.headerName).trim());
            });
          }
        }

        setAvailableColumns((prev) => {
          const merged = new Set([...prev, ...discovered]);
          return Array.from(merged);
        });

        setFieldValuesMap((prev) => {
          const merged: Record<string, string[]> = { ...prev };
          Object.entries(nextValMap).forEach(([col, vals]) => {
            if (!merged[col]) {
              merged[col] = vals;
            } else {
              const s = new Set([...merged[col], ...vals]);
              merged[col] = Array.from(s).slice(0, 30);
            }
          });
          return merged;
        });

        const liveCount = data?.itemCount ? ` (${data.itemCount} items on page)` : '';
        setScanMessage(`Discovered ${discovered.size} column(s) from live page${liveCount}`);
      } else {
        setScanMessage('Worker bridge idle; using recorded workflow columns');
      }
    } catch {
      setScanMessage('Worker bridge unavailable; using recorded workflow columns');
    } finally {
      setScanningColumns(false);
      setTimeout(() => setScanMessage(null), 3500);
    }
  };

  let loopValidationError: string | null = null;
  if (execMode === 'loop' && steps.length > 0) {
    if (isTwoLevel) {
      if (outerStartIndex > outerEndIndex) {
        loopValidationError = `Company start step (#${outerStartIndex + 1}) cannot be after company return step (#${outerEndIndex + 1}).`;
      } else if (outerAnchorIndex < outerStartIndex || outerAnchorIndex > outerEndIndex) {
        loopValidationError = `Company anchor step (#${outerAnchorIndex + 1}) must be inside company range [Step #${outerStartIndex + 1}..#${outerEndIndex + 1}].`;
      } else if (innerStartIndex < outerStartIndex || innerEndIndex > outerEndIndex) {
        loopValidationError = `Record loop range [Step #${innerStartIndex + 1}..#${innerEndIndex + 1}] must be enclosed within company range [Step #${outerStartIndex + 1}..#${outerEndIndex + 1}].`;
      } else if (innerStartIndex > innerEndIndex) {
        loopValidationError = `Record start step (#${innerStartIndex + 1}) cannot be after record end step (#${innerEndIndex + 1}).`;
      } else if (innerAnchorIndex < innerStartIndex || innerAnchorIndex > innerEndIndex) {
        loopValidationError = `Record anchor step (#${innerAnchorIndex + 1}) must be inside record range [Step #${innerStartIndex + 1}..#${innerEndIndex + 1}].`;
      }
    } else {
      if (startStepIndex > endStepIndex) {
        loopValidationError = `Start step (#${startStepIndex + 1}) cannot be after end step (#${endStepIndex + 1}).`;
      } else if (anchorStepIndex < startStepIndex || anchorStepIndex > endStepIndex) {
        loopValidationError = `Collection anchor step (#${anchorStepIndex + 1}) must be inside the loop range [Step #${startStepIndex + 1}..#${endStepIndex + 1}].`;
      }
    }
  }

  const handleLaunch = async () => {
    if (execMode === 'loop' && loopValidationError) {
      setError(loopValidationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const itemsLimit = maxItems.trim() ? parseInt(maxItems, 10) : 0;

      let constructedFilter: Record<string, unknown> | null = null;
      if (execMode === 'loop' && filterEnabled) {
        if (!conditions || conditions.length === 0) {
          setError('Please add at least one filter condition, or select "Process all items".');
          setSubmitting(false);
          return;
        }

        const validConditions: Array<{ field: string; operator: string; value: any }> = [];

        for (let i = 0; i < conditions.length; i++) {
          const c = conditions[i];
          const isCustom = c.field === '__custom__';
          const fieldName = (isCustom ? c.customField : c.field).trim();

          if (!fieldName) {
            setError(`Please enter a column header name for condition #${i + 1}.`);
            setSubmitting(false);
            return;
          }

          if (c.operator === 'dateBetween') {
            let from = (c.dateFrom || '').trim();
            let to = (c.dateTo || '').trim();

            if (!from && !to) {
              setError(`Please select a valid date range for "${fieldName}".`);
              setSubmitting(false);
              return;
            }

            if (!from) from = to;
            if (!to) to = from;

            if (from > to) {
              const temp = from;
              from = to;
              to = temp;
            }

            validConditions.push({
              field: fieldName,
              operator: 'dateBetween',
              value: { from, to },
            });
          } else {
            const val = (c.value || '').trim();
            if (!val) {
              setError(`Please enter a filter value for "${fieldName}".`);
              setSubmitting(false);
              return;
            }

            validConditions.push({
              field: fieldName,
              operator: c.operator,
              value: val,
            });
          }
        }

        if (validConditions.length === 0) {
          setError('Please configure at least one active filter condition, or select "Process all items".');
          setSubmitting(false);
          return;
        }

        constructedFilter = {
          matchMode,
          conditions: validConditions,
        };

        if (validConditions.length === 1) {
          constructedFilter.field = validConditions[0].field;
          constructedFilter.operator = validConditions[0].operator;
          constructedFilter.value = validConditions[0].value;
        }
      }

      const constructedNestedLoop = (execMode === 'loop' && isTwoLevel) ? {
        enabled: true,
        mode: 'two_level',
        outer: {
          name: 'company',
          anchorStepIndex: outerAnchorIndex,
          startStepIndex: outerStartIndex,
          endStepIndex: outerEndIndex,
          maxItems: outerMaxItems.trim() ? parseInt(outerMaxItems, 10) : null,
        },
        inner: {
          name: 'record',
          anchorStepIndex: innerAnchorIndex,
          startStepIndex: innerStartIndex,
          endStepIndex: innerEndIndex,
          maxItems: innerMaxItems.trim() ? parseInt(innerMaxItems, 10) : (itemsLimit > 0 ? itemsLimit : null),
          filter: constructedFilter,
        }
      } : null;

      const res = await fetch('/api/v1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow_id: workflow.id,
          org_id: orgId,
          status: 'pending',
          total_items_discovered: itemsLimit || 0,
          mode: execMode,
          isLoop: execMode === 'loop',
          loopStepIndex: execMode === 'loop' ? (isTwoLevel ? innerAnchorIndex : anchorStepIndex) : null,
          loop: execMode === 'loop' ? {
            enabled: true,
            anchorStepIndex: isTwoLevel ? innerAnchorIndex : anchorStepIndex,
            startStepIndex: isTwoLevel ? innerStartIndex : startStepIndex,
            endStepIndex: isTwoLevel ? innerEndIndex : endStepIndex,
            maxItems: itemsLimit > 0 ? itemsLimit : null
          } : { enabled: false },
          loopLimit: execMode === 'loop' && itemsLimit > 0 ? itemsLimit : null,
          itemFilter: constructedFilter,
          nestedLoop: constructedNestedLoop,
          newOnly: execMode === 'loop' && newOnly,
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to dispatch workflow execution');
      }

      const json = await res.json();
      const dispatchedRun: DrawerRunItem = {
        ...json.run,
        workflowName: workflow.name,
        wf_workflows: { name: workflow.name }
      };

      await refreshDashboard();
      onClose();
      if (onRunDispatched) {
        onRunDispatched(dispatchedRun);
      }
      openRunDetails(dispatchedRun);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Execution dispatch failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Play className="h-4 w-4 fill-current" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">{workflow.name}</h3>
                {domain && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700/60 text-[11px] text-cyan-300">
                    <Globe className="h-3 w-3 text-cyan-400" />
                    {domain}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">Execution Preflight & Dispatch Mission Control</p>
            </div>
          </div>
          <button 
            type="button"
            onClick={onClose} 
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {/* Runner Readiness Check Badge */}
          <div className={`flex items-start gap-3 p-3.5 rounded-xl border text-xs ${
            isRunnerOnline 
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' 
              : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          }`}>
            {isRunnerOnline ? (
              <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            )}
            <div className="flex-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <Cpu className="h-3.5 w-3.5" />
                <span>{isRunnerOnline ? 'Desktop Worker Online & Ready' : 'Desktop Worker Offline'}</span>
              </div>
              <p className="text-slate-400 mt-0.5">
                {isRunnerOnline 
                  ? 'Local runner active on CDP :9222. Execution will begin immediately upon dispatch.' 
                  : 'Run will queue as "pending" in cloud until runner connects with org pairing token.'}
              </p>
            </div>
          </div>

          {/* Mode Selection */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Execution Mode</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setExecMode('single')}
                className={`flex flex-col p-3.5 rounded-xl border text-left transition cursor-pointer ${
                  execMode === 'single'
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-white ring-1 ring-cyan-500/30'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <Layers className="h-4 w-4 text-cyan-400" />
                  <span>Standard Run</span>
                </div>
                <span className="text-xs text-slate-400 mt-1">Replay recorded workflow once from start to finish.</span>
              </button>

              <button
                type="button"
                onClick={() => setExecMode('loop')}
                className={`flex flex-col p-3.5 rounded-xl border text-left transition cursor-pointer ${
                  execMode === 'loop'
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-white ring-1 ring-cyan-500/30'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <Repeat className="h-4 w-4 text-cyan-400" />
                  <span>Loop / Batch</span>
                </div>
                <span className="text-xs text-slate-400 mt-1">Iterate across repeating table rows and download files.</span>
              </button>
            </div>
          </div>

          {/* Loop Configuration (if loop selected) */}
          {execMode === 'loop' && (
            <div className="space-y-4 animate-in fade-in duration-150">
              {/* Loop Strategy Switch: Single Collection vs Controlled Two-Level Iteration */}
              <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-800 bg-slate-950/40">
                <div className="space-y-0.5">
                  <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <span>Two-Level Iteration (Company → Records)</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-cyan-950 text-cyan-300 border border-cyan-800/60 uppercase">Controlled</span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Outer loop selects companies; inner loop processes all invoices/records per company.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsTwoLevel(!isTwoLevel)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    isTwoLevel ? 'bg-cyan-500' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                      isTwoLevel ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {!isTwoLevel ? (
                <>
                  {/* Single-Level Anchor Step Selector */}
                  <div className="space-y-1.5 p-3.5 rounded-xl border border-slate-800 bg-slate-950/40">
                    <div className="flex items-center justify-between">
                      <label htmlFor="selectAnchorStep" className="block text-xs font-semibold text-slate-300">
                        Collection Anchor Step (Identifies Rows / Items)
                      </label>
                      <span className="text-[11px] text-cyan-400 font-mono">
                        Step #{anchorStepIndex + 1}
                      </span>
                    </div>
                    {steps.length > 0 ? (
                      <select
                        id="selectAnchorStep"
                        value={anchorStepIndex}
                        onChange={(e) => {
                          const idx = parseInt(e.target.value, 10);
                          setAnchorStepIndex(idx);
                          setLoopStepIndex(idx);
                          if (idx < startStepIndex) setStartStepIndex(idx);
                          if (idx > endStepIndex) setEndStepIndex(idx);
                          handleRefreshFields(workflow, idx);
                        }}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                      >
                        {steps.map((step: any, idx: number) => (
                          <option key={idx} value={idx}>
                            {formatStepLabel(step, idx)} {idx === autoDetectedIndex ? '(Auto-detected Collection Anchor)' : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-xs text-slate-500 italic">No recorded steps found in this workflow.</p>
                    )}
                    <p className="text-[11px] text-slate-400">
                      Identifies the collection (table, list, cards) to iterate over.
                    </p>
                  </div>

                  {/* Loop Step Range (Start & End) */}
                  <div className="space-y-3 p-3.5 rounded-xl border border-slate-800 bg-slate-950/40">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-semibold text-slate-300">
                        Loop Range (Steps Repeated per Item)
                      </label>
                      <span className="text-[11px] text-cyan-400 font-mono">
                        Steps #{startStepIndex + 1}..#{endStepIndex + 1} ({Math.max(0, endStepIndex - startStepIndex + 1)} step{endStepIndex === startStepIndex ? '' : 's'})
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="selectStartStep" className="block text-[11px] text-slate-400 mb-1">
                          Start Step (Inclusive)
                        </label>
                        <select
                          id="selectStartStep"
                          value={startStepIndex}
                          onChange={(e) => setStartStepIndex(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                        >
                          {steps.map((step: any, idx: number) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}: {formatStepLabel(step, idx)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="selectEndStep" className="block text-[11px] text-slate-400 mb-1">
                          End Step (Inclusive)
                        </label>
                        <select
                          id="selectEndStep"
                          value={endStepIndex}
                          onChange={(e) => setEndStepIndex(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                        >
                          {steps.map((step: any, idx: number) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}: {formatStepLabel(step, idx)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Validation Error if any */}
                    {loopValidationError && (
                      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                        <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                        <span>{loopValidationError}</span>
                      </div>
                    )}

                    {/* Execution Plan Flow */}
                    <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
                      <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800/80">
                        <div className="font-semibold text-slate-300">Setup (Once)</div>
                        <div className="text-slate-400 mt-0.5">
                          {startStepIndex > 0 ? `Steps 1..${startStepIndex}` : 'None'}
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-cyan-950/30 border border-cyan-800/40">
                        <div className="font-semibold text-cyan-300">Loop (Per Item)</div>
                        <div className="text-cyan-400 mt-0.5">
                          Steps {startStepIndex + 1}..{endStepIndex + 1}
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800/80">
                        <div className="font-semibold text-slate-300">Teardown (Once)</div>
                        <div className="text-slate-400 mt-0.5">
                          {endStepIndex < steps.length - 1 ? `Steps ${endStepIndex + 2}..${steps.length}` : 'None'}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Two-Level: Outer Level (Company Collection) */}
                  <div className="space-y-3 p-3.5 rounded-xl border border-cyan-900/40 bg-cyan-950/20">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-cyan-400"></span>
                        <span className="text-xs font-bold text-white uppercase tracking-wider">Level 1: Company Collection (Outer)</span>
                      </div>
                      <span className="text-[11px] text-cyan-400 font-mono">
                        Company Anchor: Step #{outerAnchorIndex + 1}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="selectOuterAnchorStep" className="block text-xs font-semibold text-slate-300">
                        Company Anchor Step (Selects Company in Portal)
                      </label>
                      <select
                        id="selectOuterAnchorStep"
                        value={outerAnchorIndex}
                        onChange={(e) => {
                          const idx = parseInt(e.target.value, 10);
                          setOuterAnchorIndex(idx);
                          if (idx < outerStartIndex) setOuterStartIndex(idx);
                        }}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                      >
                        {steps.map((step: any, idx: number) => (
                          <option key={idx} value={idx}>
                            {formatStepLabel(step, idx)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label htmlFor="selectOuterStartStep" className="block text-[11px] text-slate-400 mb-1">
                          Outer Start Step
                        </label>
                        <select
                          id="selectOuterStartStep"
                          value={outerStartIndex}
                          onChange={(e) => setOuterStartIndex(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                        >
                          {steps.map((step: any, idx: number) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}: {formatStepLabel(step, idx)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="selectOuterEndStep" className="block text-[11px] text-slate-400 mb-1">
                          Return Step to Company View (Outer End)
                        </label>
                        <select
                          id="selectOuterEndStep"
                          value={outerEndIndex}
                          onChange={(e) => setOuterEndIndex(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                        >
                          {steps.map((step: any, idx: number) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}: {formatStepLabel(step, idx)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Two-Level: Inner Level (Record / Invoice Collection) */}
                  <div className="space-y-3 p-3.5 rounded-xl border border-emerald-900/40 bg-emerald-950/20">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                        <span className="text-xs font-bold text-white uppercase tracking-wider">Level 2: Record Collection (Inner Invoices)</span>
                      </div>
                      <span className="text-[11px] text-emerald-400 font-mono">
                        Record Anchor: Step #{innerAnchorIndex + 1}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="selectInnerAnchorStep" className="block text-xs font-semibold text-slate-300">
                        Record Anchor Step (Identifies Rows to Iterate)
                      </label>
                      <select
                        id="selectInnerAnchorStep"
                        value={innerAnchorIndex}
                        onChange={(e) => {
                          const idx = parseInt(e.target.value, 10);
                          setInnerAnchorIndex(idx);
                          if (idx < innerStartIndex) setInnerStartIndex(idx);
                          if (idx > innerEndIndex) setInnerEndIndex(idx);
                          handleRefreshFields(workflow, idx);
                        }}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 transition cursor-pointer"
                      >
                        {steps.map((step: any, idx: number) => (
                          <option key={idx} value={idx}>
                            {formatStepLabel(step, idx)} {idx === autoDetectedIndex ? '(Auto-detected Record Anchor)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label htmlFor="selectInnerStartStep" className="block text-[11px] text-slate-400 mb-1">
                          Record Actions Start
                        </label>
                        <select
                          id="selectInnerStartStep"
                          value={innerStartIndex}
                          onChange={(e) => setInnerStartIndex(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 transition cursor-pointer"
                        >
                          {steps.map((step: any, idx: number) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}: {formatStepLabel(step, idx)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="selectInnerEndStep" className="block text-[11px] text-slate-400 mb-1">
                          Record Actions End
                        </label>
                        <select
                          id="selectInnerEndStep"
                          value={innerEndIndex}
                          onChange={(e) => setInnerEndIndex(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 transition cursor-pointer"
                        >
                          {steps.map((step: any, idx: number) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}: {formatStepLabel(step, idx)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Validation Error if any */}
                  {loopValidationError && (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                      <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                      <span>{loopValidationError}</span>
                    </div>
                  )}

                  {/* 5-Phase Execution Plan Flow */}
                  <div className="space-y-2 p-3.5 rounded-xl border border-slate-800 bg-slate-950/40">
                    <div className="text-xs font-semibold text-slate-300">Controlled Execution Sequence</div>
                    <div className="grid grid-cols-5 gap-1.5 pt-1 text-[10px]">
                      <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800/80 text-center">
                        <div className="font-semibold text-slate-400 uppercase">Phase 1</div>
                        <div className="font-medium text-slate-200 mt-0.5 truncate">Login / Setup</div>
                        <div className="text-slate-500 mt-1 font-mono">
                          {outerStartIndex > 0 ? `1..${outerStartIndex}` : 'None'}
                        </div>
                        <span className="inline-block mt-1 px-1 rounded bg-slate-800 text-[9px] text-slate-400">Once</span>
                      </div>
                      <div className="p-2 rounded-lg bg-cyan-950/40 border border-cyan-800/40 text-center">
                        <div className="font-semibold text-cyan-400 uppercase">Phase 2</div>
                        <div className="font-medium text-cyan-200 mt-0.5 truncate">Select Co.</div>
                        <div className="text-cyan-400/80 mt-1 font-mono">
                          {outerStartIndex + 1}..{innerStartIndex}
                        </div>
                        <span className="inline-block mt-1 px-1 rounded bg-cyan-900/60 text-[9px] text-cyan-300">Per Co.</span>
                      </div>
                      <div className="p-2 rounded-lg bg-emerald-950/40 border border-emerald-800/40 text-center">
                        <div className="font-semibold text-emerald-400 uppercase">Phase 3</div>
                        <div className="font-medium text-emerald-200 mt-0.5 truncate">Records</div>
                        <div className="text-emerald-400/80 mt-1 font-mono">
                          {innerStartIndex + 1}..{innerEndIndex + 1}
                        </div>
                        <span className="inline-block mt-1 px-1 rounded bg-emerald-900/60 text-[9px] text-emerald-300">Per Rec.</span>
                      </div>
                      <div className="p-2 rounded-lg bg-cyan-950/40 border border-cyan-800/40 text-center">
                        <div className="font-semibold text-cyan-400 uppercase">Phase 4</div>
                        <div className="font-medium text-cyan-200 mt-0.5 truncate">Return Co.</div>
                        <div className="text-cyan-400/80 mt-1 font-mono">
                          {innerEndIndex + 1 < outerEndIndex + 1 ? `${innerEndIndex + 2}..${outerEndIndex + 1}` : `${outerEndIndex + 1}`}
                        </div>
                        <span className="inline-block mt-1 px-1 rounded bg-cyan-900/60 text-[9px] text-cyan-300">Per Co.</span>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800/80 text-center">
                        <div className="font-semibold text-slate-400 uppercase">Phase 5</div>
                        <div className="font-medium text-slate-200 mt-0.5 truncate">Teardown</div>
                        <div className="text-slate-500 mt-1 font-mono">
                          {outerEndIndex < steps.length - 1 ? `${outerEndIndex + 2}..${steps.length}` : 'None'}
                        </div>
                        <span className="inline-block mt-1 px-1 rounded bg-slate-800 text-[9px] text-slate-400">Once</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Discovered Records Preview */}
              <div className="space-y-3 p-3.5 rounded-xl border border-slate-800 bg-slate-950/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Eye className="h-4 w-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-white">Discovered Records Preview</span>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-cyan-950 text-cyan-300 border border-cyan-800/60 uppercase">
                      {discoveredCollectionType}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-cyan-400 font-mono">
                      {discoveredItemCount > 0 ? `${discoveredItemCount} record${discoveredItemCount === 1 ? '' : 's'} discovered` : 'Live DOM verification'}
                    </span>
                    <button
                      type="button"
                      disabled={scanningColumns}
                      onClick={() => handleRefreshFields(workflow, anchorStepIndex)}
                      className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition cursor-pointer"
                      title="Rescan Records from Active Browser Tab"
                    >
                      <RefreshCw className={`h-3 w-3 ${scanningColumns ? 'animate-spin text-cyan-400' : ''}`} />
                    </button>
                  </div>
                </div>

                {discoveredRecords.length > 0 ? (
                  <div className="space-y-2">
                    <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-800/80 bg-slate-900/60 divide-y divide-slate-800/60 text-xs">
                      {discoveredRecords.slice(0, 5).map((rec, idx) => {
                        const recFields = rec.fields || {};
                        const filterCheck = filterEnabled && conditions.length > 0
                          ? doesRecordMatchFilter(recFields, conditions, matchMode)
                          : { matches: true };
                        const displayId = rec.id || recFields['Invoice Number'] || recFields['Invoice No'] || recFields['Invoice #'] || recFields['ID'] || `Record #${idx + 1}`;
                        
                        return (
                          <div key={idx} className="p-2.5 flex items-center justify-between gap-3 hover:bg-slate-800/30 transition">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span className="text-[10px] text-slate-500 font-mono shrink-0">#{idx + 1}</span>
                              <span className="font-semibold text-slate-200 truncate">{displayId}</span>
                              {recFields['Status'] && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-300 shrink-0">
                                  {recFields['Status']}
                                </span>
                              )}
                              {recFields['Date'] && (
                                <span className="text-[11px] text-slate-400 shrink-0">{recFields['Date']}</span>
                              )}
                              {recFields['Amount'] && (
                                <span className="text-[11px] text-emerald-400 shrink-0 font-mono">{recFields['Amount']}</span>
                              )}
                            </div>
                            <div className="shrink-0">
                              {filterEnabled ? (
                                filterCheck.matches ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                                    ✓ Matches
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700/60">
                                    ⊘ Excluded
                                  </span>
                                )
                              ) : (
                                <span className="text-[10px] text-cyan-400/80 font-mono">Will process</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {discoveredRecords.length > 5 && (
                      <p className="text-[11px] text-slate-500 text-right">
                        Showing 5 of {discoveredRecords.length} discovered items
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="p-3 rounded-lg bg-slate-900/40 border border-slate-800/60 text-center text-xs text-slate-400">
                    {scanningColumns ? (
                      <div className="flex items-center justify-center gap-2 text-cyan-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Scanning active browser tab for repeating records...</span>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <p>No preview records captured yet.</p>
                        <p className="text-[11px] text-slate-500">
                          Anchor is set to <strong className="text-cyan-300 font-mono">Step #{anchorStepIndex + 1}</strong>. When connected to the desktop worker, click <button type="button" onClick={() => handleRefreshFields(workflow, anchorStepIndex)} className="text-cyan-400 hover:underline">Scan Records</button> to inspect live DOM rows.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Batch Iteration Limits */}
              <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400">
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>Batch Iteration Limits</span>
                </div>

                <div className={isTwoLevel ? "grid grid-cols-2 gap-3" : ""}>
                  {isTwoLevel && (
                    <div>
                      <label htmlFor="inputMaxCompanies" className="block text-xs text-slate-300 mb-1 font-medium">Max Companies</label>
                      <input
                        id="inputMaxCompanies"
                        type="number"
                        min="1"
                        placeholder="All companies"
                        value={outerMaxItems}
                        onChange={(e) => setOuterMaxItems(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition"
                      />
                    </div>
                  )}
                  <div>
                    <label htmlFor="inputMaxItems" className="block text-xs text-slate-300 mb-1 font-medium">
                      {isTwoLevel ? 'Max Records per Company' : 'Max Items Limit'}
                    </label>
                    <input
                      id="inputMaxItems"
                      type="number"
                      min="1"
                      placeholder="All items (no limit)"
                      value={maxItems}
                      onChange={(e) => setMaxItems(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition"
                    />
                  </div>
                </div>

                {/* NEW_ONLY deduplication toggle */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-800/80">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                      <span>Process New Records Only (NEW_ONLY)</span>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-950 text-emerald-300 border border-emerald-800/60 uppercase">Deduplication</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Skip previously processed records across runs using composite identity ({isTwoLevel ? 'companyId / recordId' : 'recordId'}).
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setNewOnly(!newOnly)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      newOnly ? 'bg-emerald-500' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                        newOnly ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Filter Rules Section */}
              <div className="space-y-3 p-4 rounded-xl border border-slate-800 bg-slate-950/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ListFilter className="h-4 w-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-white">Item Filter Rules</span>
                  </div>
                  <span className="text-[11px] text-slate-400">Row criteria filter</span>
                </div>

                {/* Filter Mode Toggle */}
                <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-slate-900 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setFilterEnabled(false)}
                    className={`py-1.5 px-3 rounded-md text-xs font-semibold transition cursor-pointer ${
                      !filterEnabled
                        ? 'bg-slate-800 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-300'
                    }`}
                  >
                    Process all items (No filter)
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterEnabled(true)}
                    className={`py-1.5 px-3 rounded-md text-xs font-semibold transition cursor-pointer ${
                      filterEnabled
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-300'
                    }`}
                  >
                    Filter items by condition
                  </button>
                </div>

                {/* Filter Conditions Editor (When Enabled) */}
                {filterEnabled && (
                  <div className="space-y-3 pt-1 animate-in fade-in duration-150">
                    {/* Controls Bar: Match Mode + Refresh Fields */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-slate-300">Match Mode:</span>
                        <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-0.5">
                          <button
                            type="button"
                            onClick={() => setMatchMode('all')}
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                              matchMode === 'all'
                                ? 'bg-cyan-500 text-slate-950 font-bold'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            ALL rules (AND)
                          </button>
                          <button
                            type="button"
                            onClick={() => setMatchMode('any')}
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                              matchMode === 'any'
                                ? 'bg-cyan-500 text-slate-950 font-bold'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            ANY rule (OR)
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleRefreshFields()}
                        disabled={scanningColumns}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-800 bg-slate-900 text-[11px] text-slate-300 hover:text-white hover:border-slate-700 transition cursor-pointer disabled:opacity-50"
                        title="Scan columns from local worker bridge"
                      >
                        <RefreshCw className={`h-3 w-3 text-cyan-400 ${scanningColumns ? 'animate-spin' : ''}`} />
                        <span>{scanningColumns ? 'Scanning...' : 'Re-scan Columns'}</span>
                      </button>
                    </div>

                    {scanMessage && (
                      <p className="text-[11px] text-cyan-400/90 italic bg-cyan-500/10 px-2.5 py-1 rounded border border-cyan-500/20">
                        {scanMessage}
                      </p>
                    )}

                    {/* Section 2a: Quick Column / Field Pills */}
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                          <Layers className="h-3 w-3 text-cyan-400" />
                          Quick Pick: Discovered Columns
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {availableColumns.length} detected
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {availableColumns.map((col) => {
                          const isColActive = (conditions[0]?.field || activeField) === col;
                          return (
                            <button
                              key={col}
                              type="button"
                              onClick={() => handleSelectColumnPill(col)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition cursor-pointer ${
                                isColActive
                                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold'
                                  : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                              }`}
                            >
                              {col}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => handleSelectColumnPill('__custom__')}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition cursor-pointer ${
                            (conditions[0]?.field || activeField) === '__custom__'
                              ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold'
                              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                          }`}
                        >
                          Custom...
                        </button>
                      </div>
                    </div>

                    {/* Section 2b: Smart Date & Lifecycle Logic (When Date field detected) */}
                    {(() => {
                      const activeColName = conditions[0]?.field === '__custom__'
                        ? (conditions[0]?.customField || 'Custom')
                        : (conditions[0]?.field || activeField || availableColumns[0] || 'Type');
                      const isDateCol = isDateField(activeColName);
                      if (!isDateCol) return null;

                      return (
                        <div className="p-2.5 rounded-lg border border-cyan-500/30 bg-cyan-950/20 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-cyan-300 flex items-center gap-1.5">
                              <Clock className="h-3 w-3 text-cyan-400" />
                              Quick Date Filter for &ldquo;{activeColName}&rdquo;:
                            </span>
                            <span className="text-[10px] font-semibold text-cyan-400/80">
                              Live Runtime Filtering
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => applyDatePreset('overdue')}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cyan-500/40 bg-slate-900 text-cyan-300 hover:bg-cyan-500/20 transition cursor-pointer"
                              title="Due date has passed (Due Date <= Today)"
                            >
                              Overdue (on or before today)
                            </button>
                            <button
                              type="button"
                              onClick={() => applyDatePreset('upcoming')}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cyan-500/40 bg-slate-900 text-cyan-300 hover:bg-cyan-500/20 transition cursor-pointer"
                              title="Due date has not arrived yet (Due Date >= Today)"
                            >
                              Upcoming (after today)
                            </button>
                            <button
                              type="button"
                              onClick={() => applyDatePreset('today')}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cyan-500/40 bg-slate-900 text-cyan-300 hover:bg-cyan-500/20 transition cursor-pointer"
                              title="Due date is today"
                            >
                              Due Today
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Section 2c: Quick Detected Options for current field */}
                    {(() => {
                      const activeColName = conditions[0]?.field === '__custom__'
                        ? (conditions[0]?.customField || '')
                        : (conditions[0]?.field || activeField || availableColumns[0] || 'Type');
                      const detectedValues = getValuesForField(activeColName);
                      if (detectedValues.length === 0) return null;

                      return (
                        <div className="space-y-1.5 pt-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                              <ListFilter className="h-3 w-3 text-cyan-400" />
                              Detected Options for &ldquo;{activeColName}&rdquo;:
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {detectedValues.length} option(s)
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {detectedValues.map((v) => {
                              const isValSelected = conditions.some((c) => c.value?.toLowerCase() === v.toLowerCase());
                              return (
                                <button
                                  key={v}
                                  type="button"
                                  onClick={() => handleSelectValuePill(v)}
                                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition cursor-pointer ${
                                    isValSelected
                                      ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold'
                                      : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                                  }`}
                                  title={`Filter by '${v}'`}
                                >
                                  {v}
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() => handleSelectValuePill('__all__')}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-800 bg-slate-900 text-slate-400 hover:text-white hover:border-slate-700 transition cursor-pointer"
                              title="Clear filter value"
                            >
                              Fetch All
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Condition Rows */}
                    <div className="space-y-2">
                      {conditions.map((cond, idx) => {
                        const isCustom = cond.field === '__custom__';
                        const isDate = cond.operator === 'dateBetween';
                        const fieldNameForOptions = isCustom ? cond.customField : cond.field;
                        const rowOptions = getValuesForField(fieldNameForOptions);

                        return (
                          <div
                            key={cond.id}
                            className="p-2.5 rounded-lg border border-slate-800 bg-slate-900/80 space-y-2"
                          >
                            <div className="grid grid-cols-12 gap-2 items-center">
                              {/* Field Dropdown */}
                              <div className="col-span-4">
                                <select
                                  aria-label="Filter Field"
                                  value={cond.field}
                                  onChange={(e) => {
                                    handleUpdateCondition(idx, { field: e.target.value });
                                    if (idx === 0) setActiveField(e.target.value);
                                  }}
                                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                                >
                                  {availableColumns.map((col) => (
                                    <option key={col} value={col}>
                                      {col}
                                    </option>
                                  ))}
                                  <option value="__custom__">Custom column...</option>
                                </select>
                              </div>

                              {/* Operator Dropdown */}
                              <div className="col-span-3">
                                <select
                                  aria-label="Filter Operator"
                                  value={cond.operator}
                                  onChange={(e) => {
                                    const nextOp = e.target.value as 'contains' | 'equals' | 'dateBetween';
                                    handleUpdateCondition(idx, { operator: nextOp });
                                  }}
                                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition cursor-pointer"
                                >
                                  <option value="contains">contains</option>
                                  <option value="equals">equals</option>
                                  <option value="dateBetween">dateBetween</option>
                                </select>
                              </div>

                              {/* Value Input or Date Pickers */}
                              <div className={conditions.length > 1 ? 'col-span-4' : 'col-span-5'}>
                                {isDate ? (
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="date"
                                      aria-label="From Date"
                                      value={cond.dateFrom}
                                      onChange={(e) => handleUpdateCondition(idx, { dateFrom: e.target.value })}
                                      className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[11px] text-white focus:outline-none focus:border-cyan-500"
                                      title="From Date"
                                    />
                                    <span className="text-[10px] text-slate-500 shrink-0">to</span>
                                    <input
                                      type="date"
                                      aria-label="To Date"
                                      value={cond.dateTo}
                                      onChange={(e) => handleUpdateCondition(idx, { dateTo: e.target.value })}
                                      className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[11px] text-white focus:outline-none focus:border-cyan-500"
                                      title="To Date"
                                    />
                                  </div>
                                ) : (
                                  <div>
                                    <input
                                      type="text"
                                      placeholder="Filter value..."
                                      list={`datalist_${cond.id}`}
                                      value={cond.value}
                                      onChange={(e) => handleUpdateCondition(idx, { value: e.target.value })}
                                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition"
                                    />
                                    <datalist id={`datalist_${cond.id}`}>
                                      {rowOptions.map((opt) => (
                                        <option key={opt} value={opt} />
                                      ))}
                                    </datalist>
                                  </div>
                                )}
                              </div>

                              {/* Remove Button */}
                              {conditions.length > 1 && (
                                <div className="col-span-1 flex justify-end">
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveCondition(idx)}
                                    className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition cursor-pointer"
                                    title="Remove Condition"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>

                            {/* Quick Suggestion Chips under input */}
                            {rowOptions.length > 0 && !isDate && (
                              <div className="flex flex-wrap items-center gap-1 pt-1">
                                <span className="text-[10px] text-slate-500">Suggested:</span>
                                {rowOptions.slice(0, 5).map((opt) => (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => handleUpdateCondition(idx, { value: opt })}
                                    className={`text-[10px] px-1.5 py-0.5 rounded border transition cursor-pointer ${
                                      cond.value === opt
                                        ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold'
                                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                                    }`}
                                  >
                                    {opt}
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Custom Column Input if selected */}
                            {isCustom && (
                              <div className="pt-1">
                                <input
                                  type="text"
                                  placeholder="Enter exact column header name..."
                                  value={cond.customField}
                                  onChange={(e) => handleUpdateCondition(idx, { customField: e.target.value })}
                                  className="w-full bg-slate-900 border border-cyan-500/40 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Add Condition Button */}
                    <div className="flex justify-end pt-1">
                      <button
                        type="button"
                        onClick={handleAddCondition}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-xs text-cyan-400 hover:text-cyan-300 hover:bg-slate-800 transition cursor-pointer"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Add Condition</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Workflow Summary Metadata */}
          <div className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-slate-950/40 border border-slate-800/80 text-[11px] text-slate-400">
            <span>Workflow ID: <code className="text-slate-300 font-mono">{workflow.id.slice(0, 8)}...</code></span>
            <span>Recorded Steps: <span className="text-cyan-300 font-medium">{stepCount}</span></span>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 bg-slate-950/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || Boolean(execMode === 'loop' && loopValidationError)}
            onClick={handleLaunch}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 text-xs font-bold shadow-lg shadow-cyan-500/20 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            <span>{submitting ? 'Dispatching...' : 'Dispatch Execution'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
