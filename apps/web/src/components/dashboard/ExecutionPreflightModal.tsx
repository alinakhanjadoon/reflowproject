'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Play,
  X,
  Layers,
  Repeat,
  AlertCircle,
  CheckCircle2,
  Cpu,
  Settings2,
  Globe,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  Clock,
  Eye,
  Check,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Sparkles,
  Download,
  CheckSquare,
  FileCode,
  Filter,
  Sliders,
  Info,
  Calendar,
  Layers3,
  Flame,
  ArrowRight,
  HelpCircle,
  Table as TableIcon
} from 'lucide-react';
import { Workflow } from '@/lib/types/database';
import { DrawerRunItem } from './RunDetailsDrawer';
import { useDashboard } from '@/context/DashboardContext';
import { deriveLoopSignals } from '@/lib/workflows/loop-signals';
import { REFLOW_MASCOT_URL, REFLOW_MASCOT_INSPECTING_URL } from './RobotAvatar';

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

function detectTwoLevelCandidates(steps: Array<any>): {
  hasTwoLevel: boolean;
  dropdownStepIndex: number;
  tableStepIndex: number;
} {
  if (!Array.isArray(steps) || steps.length < 3) {
    return { hasTwoLevel: false, dropdownStepIndex: -1, tableStepIndex: -1 };
  }

  const isAuthOrSetup = (s: any) => {
    if (!s) return false;
    const name = String(s.name || s.elementName || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const type = String(s.type || s.action || '').toUpperCase();
    const tag = String(s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toLowerCase();
    const inputType = String(s.target?.fingerprint?.type || s.fingerprint?.type || '').toLowerCase();
    if (type === 'NAVIGATE' || type === 'SCROLL' || /scroll/i.test(name)) return true;
    if (/(username|password|email|sign[-_\s]*in|login|authenticat)/i.test(name)) return true;
    if (tag === 'input' && (inputType === 'password' || inputType === 'email')) return true;
    return false;
  };

  let dropdownStepIndex = -1;
  let tableStepIndex = -1;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isAuthOrSetup(s)) continue;

    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();
    const text = (s.name || s.elementName || s.description || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');

    const isOptionOrDropdown = Boolean(
      tag === 'MAT-OPTION' || tag === 'OPTION' || tag === 'LI' ||
      role === 'option' || role === 'listitem' ||
      /\b(mat-option|\[role=["']option["']\]|select\s*>\s*option|li:nth-child|data-company)\b/i.test(selectors)
    );

    const isTableRowOrGrid = Boolean(
      tag === 'TR' || tag === 'TD' ||
      role === 'row' || role === 'gridcell' ||
      /\b(table\[\d+\]|table:nth-of-type|tbody\s*>\s*tr|tr:nth-(?:child|of-type)|\[role=["']row["']\]|\[role=["']gridcell["']\]|\.x-grid-row|\.x-grid-item|\.x-grid-cell|\.data-row|\.grid-row)\b/i.test(selectors) ||
      /\b(table\s*row|grid\s*row|invoice\s*row|row\s*item)\b/i.test(text)
    );

    if (dropdownStepIndex === -1 && isOptionOrDropdown) {
      dropdownStepIndex = i;
    }
    if (isTableRowOrGrid) {
      tableStepIndex = i;
    }
  }

  const hasTwoLevel = dropdownStepIndex >= 0 && tableStepIndex > dropdownStepIndex;
  return { hasTwoLevel, dropdownStepIndex, tableStepIndex };
}

function detectLoopCandidate(steps: Array<any>, savedIndex?: unknown): number {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  if (typeof savedIndex === 'number' && Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < steps.length) {
    return savedIndex;
  }

  const twoLevel = detectTwoLevelCandidates(steps);

  const roleIdx = steps.findIndex(
    (s: any) => s && (s.role === 'LOOP' || s.isLoopCandidate === true || s.isLoop === true || s.loopMode === 'sequential_iteration')
  );
  if (roleIdx >= 0) {
    if (twoLevel.hasTwoLevel && roleIdx === twoLevel.dropdownStepIndex) {
      return twoLevel.tableStepIndex;
    }
    return roleIdx;
  }

  const isAuthOrSetup = (s: any) => {
    if (!s) return false;
    const name = String(s.name || s.elementName || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const type = String(s.type || s.action || '').toUpperCase();
    const tag = String(s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toLowerCase();
    const inputType = String(s.target?.fingerprint?.type || s.fingerprint?.type || '').toLowerCase();
    if (type === 'NAVIGATE' || type === 'SCROLL' || /scroll/i.test(name)) return true;
    if (/(username|password|email|sign[-_\s]*in|login|authenticat)/i.test(name)) return true;
    if (tag === 'input' && (inputType === 'password' || inputType === 'email')) return true;
    return false;
  };

  const businessSteps = steps.filter((s: any, idx: number) => idx > 0 && !isAuthOrSetup(s));
  const candidatePool = businessSteps.length > 0 ? businessSteps : steps;

  for (const s of candidatePool) {
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');
    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();

    const isTable = Boolean(
      tag === 'TR' || tag === 'TD' ||
      role === 'row' || role === 'gridcell' ||
      /\b(table\[\d+\]|table:nth-of-type|tbody\s*>\s*tr|tr:nth-(?:child|of-type)|\[role=["']row["']\]|\[role=["']gridcell["']\]|\.x-grid-row|\.x-grid-item|\.x-grid-cell|\.data-row|\.grid-row)\b/i.test(selectors)
    );
    if (isTable) {
      const idx = steps.indexOf(s);
      if (idx >= 0) return idx;
    }
  }

  const nonLoginIdx = steps.findIndex((s: any, idx: number) => idx > 0 && !isAuthOrSetup(s));
  if (nonLoginIdx >= 0) return nonLoginIdx;

  return steps.length > 1 ? 1 : 0;
}

const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;

function cleanStringValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (EXPANDER_GLYPH_REGEX.test(str)) return '';
  str = str.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
  return str;
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
    if (/\b(button|link|input|field|element)\b/i.test(str) && !/^(Invoice|Payment|Customer|Company|Date)\s+Field$/i.test(str)) return;
    if (/^(open selected|export a report|save it to the disk)/i.test(str)) return;
    if (/^[A-Z]{2,4}-\d+/i.test(str)) return;
    fields.add(str);
  };

  const fr = (workflow.filter_rules || {}) as Record<string, unknown>;
  if (Array.isArray(fr.available_fields)) fr.available_fields.forEach(addCleanCol);
  if (Array.isArray(fr.columns)) fr.columns.forEach(addCleanCol);
  if (fr.fieldValues && typeof fr.fieldValues === 'object') {
    Object.keys(fr.fieldValues).forEach(addCleanCol);
  }

  const wd = (workflow.workflow_definition || {}) as Record<string, unknown>;
  if (Array.isArray(wd.available_fields)) wd.available_fields.forEach(addCleanCol);
  if (Array.isArray(wd.columns)) wd.columns.forEach(addCleanCol);
  const wdFr = (wd.filter_rules || {}) as Record<string, unknown>;
  if (Array.isArray(wdFr.available_fields)) wdFr.available_fields.forEach(addCleanCol);
  if (Array.isArray(wdFr.columns)) wdFr.columns.forEach(addCleanCol);
  if (wdFr.fieldValues && typeof wdFr.fieldValues === 'object') {
    Object.keys(wdFr.fieldValues).forEach(addCleanCol);
  }

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

  if (fields.size > 0) {
    return Array.from(fields);
  }

  return ['Type', 'Status', 'Invoice Number', 'Due Date', 'Amount'];
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

  if (workflow?.filter_rules && typeof workflow.filter_rules === 'object') {
    const fr = workflow.filter_rules as any;
    if (fr.fieldValues && typeof fr.fieldValues === 'object') {
      Object.entries(fr.fieldValues).forEach(([k, vals]) => {
        if (Array.isArray(vals)) vals.forEach((v) => addValue(k, v));
      });
    }
    const savedFilter = fr.itemFilter || fr;
    if (Array.isArray(savedFilter.conditions)) {
      savedFilter.conditions.forEach((c: any) => {
        if (c.field && c.value && typeof c.value === 'string') addValue(c.field, c.value);
      });
    }
  }

  const steps = getWorkflowSteps(workflow);
  steps.forEach((step: any) => {
    if (!step) return;
    const targetField = step.extract_column || step.column || step.field ||
      step.target?.fingerprint?.columnName || step.fingerprint?.columnName ||
      step.target?.fingerprint?.headerName || step.fingerprint?.headerName;

    if (Array.isArray(step.options)) {
      step.options.forEach((opt: any) => {
        const text = typeof opt === 'string' ? opt : (opt.text || opt.label || opt.value);
        if (targetField) addValue(targetField, text);
        if (targetField && /type/i.test(targetField)) addValue('Type', text);
      });
    }

    if (step.value && typeof step.value === 'string' && !step.value.startsWith('{{')) {
      if (targetField) addValue(targetField, step.value);
    }
  });

  const fallbackDefaults: Record<string, string[]> = {
    Type: ['Invoice', 'Credit Memo'],
    Status: ['Open', 'Pending', 'Paid', 'Closed'],
    Priority: ['High', 'Normal', 'Low'],
  };

  Object.entries(fallbackDefaults).forEach(([col, defVals]) => {
    if (!result[col] || result[col].size === 0) {
      defVals.forEach((val) => addValue(col, val));
    }
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

  // Wizard Step Tracker: 1 = Mode, 2 = Collection & Actions, 3 = Records & Filters, 4 = Review & Launch
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  // Core execution configuration
  const [execMode, setExecMode] = useState<'standard' | 'loop'>('standard');
  const [newOnly, setNewOnly] = useState(false);
  const [recordScope, setRecordScope] = useState<'all' | 'new' | 'custom'>('all');
  const [targetAction, setTargetAction] = useState<'download' | 'select' | 'process'>('download');
  const [selectedCollection, setSelectedCollection] = useState<string>('primary_table');

  // Filter configuration
  const [filterConditions, setFilterConditions] = useState<FilterConditionRow[]>([
    {
      id: 'cond_1',
      field: 'Type',
      customField: '',
      operator: 'contains',
      value: 'Invoice',
      dateFrom: '',
      dateTo: ''
    }
  ]);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');

  // Advanced settings & bounds
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [maxItems, setMaxItems] = useState<string>('');
  const [anchorStepIndex, setAnchorStepIndex] = useState<number>(0);
  const [startStepIndex, setStartStepIndex] = useState<number>(0);
  const [endStepIndex, setEndStepIndex] = useState<number>(0);

  // Two-Level Iteration (Company + Record)
  const [isTwoLevel, setIsTwoLevel] = useState<boolean>(false);
  const [outerAnchorIndex, setOuterAnchorIndex] = useState<number>(0);
  const [innerAnchorIndex, setInnerAnchorIndex] = useState<number>(0);
  const [outerStartIndex, setOuterStartIndex] = useState<number>(0);
  const [outerEndIndex, setOuterEndIndex] = useState<number>(0);
  const [innerStartIndex, setInnerStartIndex] = useState<number>(0);
  const [innerEndIndex, setInnerEndIndex] = useState<number>(0);
  const [outerMaxItems, setOuterMaxItems] = useState<string>('');
  const [innerMaxItems, setInnerMaxItems] = useState<string>('');

  // Scan & Column metadata
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const [fieldValuesMap, setFieldValuesMap] = useState<Record<string, string[]>>({});
  const [discoveredRecords, setDiscoveredRecords] = useState<any[]>([]);
  const [discoveredItemCount, setDiscoveredItemCount] = useState<number>(0);
  const [scanningColumns, setScanningColumns] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extract workflow steps
  const steps = useMemo(() => getWorkflowSteps(workflow), [workflow]);

  // Initialize settings when workflow opens
  useEffect(() => {
    if (!isOpen || !workflow) return;

    setCurrentStep(1);
    setError(null);

    const initialColumns = extractWorkflowColumns(workflow);
    setAvailableColumns(initialColumns);

    const valuesMap = extractFieldValuesMap(workflow);
    setFieldValuesMap(valuesMap);

    const wd = (workflow.workflow_definition || {}) as Record<string, unknown>;
    const twoLevelCand = detectTwoLevelCandidates(steps);

    // Check shared loop signal
    const signals = deriveLoopSignals(wd);
    const hasLoopSignal = signals.isLoop;

    if (hasLoopSignal || twoLevelCand.hasTwoLevel) {
      setExecMode('loop');
    } else {
      setExecMode('standard');
    }

    const detectedAnchor = detectLoopCandidate(steps);
    setAnchorStepIndex(detectedAnchor);
    setStartStepIndex(detectedAnchor);
    setEndStepIndex(steps.length > 0 ? steps.length - 1 : 0);

    if (twoLevelCand.hasTwoLevel) {
      setIsTwoLevel(true);
      setOuterAnchorIndex(twoLevelCand.dropdownStepIndex);
      setOuterStartIndex(twoLevelCand.dropdownStepIndex);
      setOuterEndIndex(steps.length > 0 ? steps.length - 1 : 0);
      setInnerAnchorIndex(twoLevelCand.tableStepIndex);
      setInnerStartIndex(twoLevelCand.tableStepIndex);
      setInnerEndIndex(Math.max(twoLevelCand.tableStepIndex, steps.length - 1));
    }

    // Set initial filter condition from discovered values
    if (initialColumns.length > 0) {
      const firstCol = initialColumns[0];
      const sampleVal = valuesMap[firstCol]?.[0] || 'Invoice';
      setFilterConditions([
        {
          id: 'cond_1',
          field: firstCol,
          customField: '',
          operator: 'contains',
          value: sampleVal,
          dateFrom: '',
          dateTo: ''
        }
      ]);
    }
  }, [isOpen, workflow, steps]);

  // Keep newOnly state in sync with recordScope
  useEffect(() => {
    if (recordScope === 'new') {
      setNewOnly(true);
    } else {
      setNewOnly(false);
    }
  }, [recordScope]);

  // Live filter condition manipulation
  const handleAddCondition = () => {
    const defaultField = availableColumns[0] || 'Type';
    const sampleVal = fieldValuesMap[defaultField]?.[0] || '';
    setFilterConditions((prev) => [
      ...prev,
      {
        id: `cond_${Date.now()}`,
        field: defaultField,
        customField: '',
        operator: 'contains',
        value: sampleVal,
        dateFrom: '',
        dateTo: ''
      }
    ]);
  };

  const handleRemoveCondition = (id: string) => {
    setFilterConditions((prev) => (prev.length > 1 ? prev.filter((c) => c.id !== id) : prev));
  };

  const handleUpdateCondition = (id: string, updates: Partial<FilterConditionRow>) => {
    setFilterConditions((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...updates };
        if (updates.field && updates.field !== '__custom__') {
          const vals = fieldValuesMap[updates.field];
          if (vals && vals.length > 0 && !updates.value) {
            next.value = vals[0];
          }
        }
        return next;
      })
    );
  };

  // Dispatch execution preserving exact backend schema
  const handleDispatchExecution = async () => {
    if (!workflow) return;
    setSubmitting(true);
    setError(null);

    try {
      const itemsLimit = maxItems.trim() ? parseInt(maxItems, 10) : 0;

      let constructedFilter: Record<string, unknown> | null = null;
      if (execMode === 'loop' && recordScope === 'custom') {
        const validConditions = filterConditions.map((c) => ({
          field: c.field === '__custom__' ? c.customField.trim() : c.field.trim(),
          operator: c.operator,
          value: c.operator === 'dateBetween' ? { from: c.dateFrom, to: c.dateTo } : c.value.trim()
        })).filter((c) => c.field && (typeof c.value === 'object' ? c.value.from : c.value));

        if (validConditions.length > 0) {
          constructedFilter = {
            matchMode,
            conditions: validConditions
          };
          if (validConditions.length === 1) {
            constructedFilter.field = validConditions[0].field;
            constructedFilter.operator = validConditions[0].operator;
            constructedFilter.value = validConditions[0].value;
          }
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

      const payload = {
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
      };

      const res = await fetch('/api/v1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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

  if (!isOpen || !workflow) return null;

  // Mascot dynamic messages and icons per step
  const mascotInfo = {
    1: {
      image: REFLOW_MASCOT_URL,
      title: 'How should we run this?',
      speech: 'Hi! How would you like me to run this workflow? Pick Run Once for a quick single test, or Repeat Tasks to automatically handle batches of invoices, customers, or items!',
      status: 'Logic Mode: Workflow Ingestion',
      badge: 'Active & Ready'
    },
    2: {
      image: REFLOW_MASCOT_INSPECTING_URL,
      title: 'Collection & Action Selection',
      speech: 'Great! I scanned your target webpage and found repeating data records. Choose which collection you want me to process, and what action to perform on each.',
      status: 'DOM Recognition: Tables & Rows',
      badge: 'Inspecting Data'
    },
    3: {
      image: REFLOW_MASCOT_URL,
      title: 'Define Data Target Scope',
      speech: 'Almost ready! Tell me which specific records to run. You can process everything, or set a simple filter so we only touch what you need.',
      status: 'Listening & Tuning Filters',
      badge: 'Target Scope'
    },
    4: {
      image: REFLOW_MASCOT_URL,
      title: 'Ready for Dispatch',
      speech: 'All set! Review your automation plan below. If you need special settings like multi-company loops or step ranges, check Advanced Settings, then click Dispatch Execution!',
      status: 'Ready for Dispatch',
      badge: 'System Ready'
    }
  }[currentStep];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-200">
      <div className="relative mx-auto flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-cyan-500/20 bg-[#0c1427]/98 shadow-[0_24px_64px_rgba(0,0,0,0.85)]">
        
        {/* TOP MODAL HEADER & 4-STAGE PROGRESS BAR */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-cyan-500/15 bg-[#101b33]/90 px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-black shadow-md">
              <Sparkles className="h-5 w-5" />
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-cyan-300 ring-2 ring-[#101b33] animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">ReFlow Assistant</span>
                <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                  Interactive Setup
                </span>
              </div>
              <p className="text-xs text-slate-400">Let's set up your automation together!</p>
            </div>
          </div>

          <div className="flex items-center gap-5">
            {/* 4-Stage Segmented Progress Bar */}
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <span>Step</span>
                <span className="font-bold text-cyan-400">{currentStep}</span>
                <span>of 4</span>
              </div>
              <div className="grid w-36 grid-cols-4 gap-1.5 h-2">
                {[1, 2, 3, 4].map((stepNum) => (
                  <div
                    key={stepNum}
                    className={`h-full rounded-full transition-all duration-300 ${
                      stepNum <= currentStep
                        ? 'bg-gradient-to-r from-cyan-400 to-blue-500 shadow-[0_0_8px_rgba(6,182,212,0.5)]'
                        : 'bg-slate-800'
                    }`}
                  />
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-white transition-colors"
              aria-label="Close assistant"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ERROR NOTIFICATION BANNER */}
        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
            <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-400" />
            <span className="flex-1 font-medium">{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-slate-400 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* MAIN BODY: 2-COLUMN SPLIT (Left 35% Mascot Assistant | Right 65% Interactive Decision Cards) */}
        <div className="grid flex-1 grid-cols-1 overflow-y-auto p-6 gap-6 lg:grid-cols-12">
          
          {/* LEFT COLUMN: 3D Companion Mascot & Speech Bubble */}
          <div className="flex flex-col items-center justify-start lg:col-span-4">
            <div className="relative w-full rounded-2xl border border-cyan-500/15 bg-[#111a31]/80 p-5 shadow-xl backdrop-blur-md">
              {/* Character 3D Portrait */}
              <div className="relative mx-auto flex h-44 w-44 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-cyan-500/20 blur-xl animate-pulse" />
                <div className="relative h-40 w-40 overflow-hidden rounded-full bg-[#1b2642] p-1.5 shadow-2xl border border-cyan-500/30">
                  <img
                    src={mascotInfo.image}
                    alt="ReFlow AI Robot Mascot"
                    className="h-full w-full object-contain transition-transform duration-500 hover:scale-105"
                  />
                </div>
                <div className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500 text-black shadow-lg">
                  <Sparkles className="h-4 w-4" />
                </div>
              </div>

              {/* Conversational Speech Bubble */}
              <div className="relative mt-4 rounded-2xl border border-cyan-500/20 bg-[#16223e] p-4 shadow-md">
                <p className="text-xs leading-relaxed text-slate-200">
                  {mascotInfo.speech}
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-slate-700/60 pt-2 text-[10px] text-slate-400">
                  <span>AI Voice Tone</span>
                  <span className="flex items-center gap-1 font-semibold text-cyan-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    {mascotInfo.badge}
                  </span>
                </div>
              </div>

              {/* Mascot Status Pill */}
              <div className="mt-3 flex items-center justify-center gap-1.5 rounded-full bg-slate-900/60 px-3 py-1 text-[11px] text-slate-400">
                <Cpu className="h-3.5 w-3.5 text-cyan-400" />
                <span>{mascotInfo.status}</span>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Interactive Decision Workspace */}
          <div className="flex flex-col justify-between lg:col-span-8 space-y-6">
            
            {/* STEP 1: EXECUTION MODE (Run Once vs Repeat Tasks) */}
            {currentStep === 1 && (
              <div className="space-y-4 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Configuration Choice
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    What would you like me to do?
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Choose how ReFlow should execute this recorded workflow.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-2">
                  {/* Option 1: Run Once */}
                  <div
                    onClick={() => setExecMode('standard')}
                    className={`group relative flex cursor-pointer flex-col justify-between rounded-2xl p-5 transition-all duration-200 ${
                      execMode === 'standard'
                        ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_24px_rgba(6,182,212,0.35)]'
                        : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className={`flex h-12 w-12 items-center justify-center rounded-xl transition-all ${
                        execMode === 'standard' ? 'bg-cyan-500 text-black shadow-md' : 'bg-slate-800 text-cyan-400'
                      }`}>
                        <Play className="h-6 w-6 fill-current ml-0.5" />
                      </div>
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full ${
                        execMode === 'standard' ? 'bg-cyan-500 text-black' : 'border border-slate-700 opacity-40'
                      }`}>
                        <Check className="h-3.5 w-3.5 font-bold" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-base font-bold text-white group-hover:text-cyan-300 transition-colors">
                        Run Once
                      </h3>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                        Complete the workflow one single time. Ideal for spot-checking, manual verification, or single data points.
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-cyan-400">
                      <Clock className="h-3.5 w-3.5" />
                      <span>Instant 1x execution</span>
                    </div>
                  </div>

                  {/* Option 2: Repeat Tasks */}
                  <div
                    onClick={() => setExecMode('loop')}
                    className={`group relative flex cursor-pointer flex-col justify-between rounded-2xl p-5 transition-all duration-200 ${
                      execMode === 'loop'
                        ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_24px_rgba(6,182,212,0.35)]'
                        : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className={`flex h-12 w-12 items-center justify-center rounded-xl transition-all ${
                        execMode === 'loop' ? 'bg-cyan-500 text-black shadow-md' : 'bg-slate-800 text-cyan-400'
                      }`}>
                        <Repeat className="h-6 w-6" />
                      </div>
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full ${
                        execMode === 'loop' ? 'bg-cyan-500 text-black' : 'border border-slate-700 opacity-40'
                      }`}>
                        <Check className="h-3.5 w-3.5 font-bold" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-base font-bold text-white group-hover:text-cyan-300 transition-colors">
                        Repeat Tasks
                      </h3>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                        Process multiple records automatically. Loops sequentially through invoices, tables, contacts, or spreadsheet rows.
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-cyan-400">
                      <Layers className="h-3.5 w-3.5" />
                      <span>Batch array processing</span>
                    </div>
                  </div>
                </div>

                {/* Pro Tip Banner */}
                <div className="mt-4 flex items-center gap-3 rounded-2xl border border-cyan-500/20 bg-[#101c36] p-4 text-xs">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-400">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    <strong className="text-cyan-300">Pro Tip:</strong> Choose <em>Repeat Tasks</em> if you want to download multiple invoices, process tables of leads, or automate large queues in one click.
                  </p>
                </div>
              </div>
            )}

            {/* STEP 2: WHAT TO REPEAT & ACTION SEQUENCE */}
            {currentStep === 2 && (
              <div className="space-y-5 animate-in fade-in duration-150">
                {/* Question 1: What would you like me to repeat? */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                        Step 2 · Item Selection
                      </span>
                      <h2 className="text-lg font-bold text-white sm:text-xl">
                        What would you like me to repeat?
                      </h2>
                    </div>
                    <span className="text-xs text-slate-400">3 patterns found</span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {/* Collection 1: Invoice Records */}
                    <button
                      type="button"
                      onClick={() => setSelectedCollection('primary_table')}
                      className={`group relative rounded-2xl p-4 text-left transition-all ${
                        selectedCollection === 'primary_table'
                          ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_20px_-4px_rgba(6,182,212,0.4)]'
                          : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-400">
                          <TableIcon className="h-4 w-4" />
                        </div>
                        <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          selectedCollection === 'primary_table' ? 'bg-cyan-500 text-black' : 'opacity-0'
                        }`}>
                          <Check className="h-3 w-3 font-bold" />
                        </div>
                      </div>
                      <div className="font-bold text-xs text-white group-hover:text-cyan-300">Invoice Records</div>
                      <span className="text-[10px] font-semibold text-cyan-300">Recommended</span>
                      <p className="mt-1 text-[11px] text-slate-400 line-clamp-2">
                        Extracted table dataset matching rows #inv-2024
                      </p>
                      <div className="mt-3 flex items-center justify-between text-[10px]">
                        <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-cyan-300 font-semibold">
                          48 items
                        </span>
                        <span className="text-slate-400 font-mono">100% match</span>
                      </div>
                    </button>

                    {/* Collection 2: Customer Contact List */}
                    <button
                      type="button"
                      onClick={() => setSelectedCollection('customer_list')}
                      className={`group relative rounded-2xl p-4 text-left transition-all ${
                        selectedCollection === 'customer_list'
                          ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_20px_-4px_rgba(6,182,212,0.4)]'
                          : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-purple-500/20 text-purple-400">
                          <Layers className="h-4 w-4" />
                        </div>
                        <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          selectedCollection === 'customer_list' ? 'bg-cyan-500 text-black' : 'opacity-0'
                        }`}>
                          <Check className="h-3 w-3 font-bold" />
                        </div>
                      </div>
                      <div className="font-bold text-xs text-white group-hover:text-cyan-300">Customer List</div>
                      <span className="text-[10px] font-semibold text-slate-400">Secondary Element</span>
                      <p className="mt-1 text-[11px] text-slate-400 line-clamp-2">
                        Customer dropdown accounts embedded within selector
                      </p>
                      <div className="mt-3 flex items-center justify-between text-[10px]">
                        <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-purple-300 font-semibold">
                          12 items
                        </span>
                        <span className="text-slate-400 font-mono">Dropdown</span>
                      </div>
                    </button>

                    {/* Collection 3: Product Inventory Rows */}
                    <button
                      type="button"
                      onClick={() => setSelectedCollection('inventory_rows')}
                      className={`group relative rounded-2xl p-4 text-left transition-all ${
                        selectedCollection === 'inventory_rows'
                          ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_20px_-4px_rgba(6,182,212,0.4)]'
                          : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-500/20 text-blue-400">
                          <Layers3 className="h-4 w-4" />
                        </div>
                        <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          selectedCollection === 'inventory_rows' ? 'bg-cyan-500 text-black' : 'opacity-0'
                        }`}>
                          <Check className="h-3 w-3 font-bold" />
                        </div>
                      </div>
                      <div className="font-bold text-xs text-white group-hover:text-cyan-300">Inventory Rows</div>
                      <span className="text-[10px] font-semibold text-slate-400">Catalog View</span>
                      <p className="mt-1 text-[11px] text-slate-400 line-clamp-2">
                        Nested SKU table with price and stock status
                      </p>
                      <div className="mt-3 flex items-center justify-between text-[10px]">
                        <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-blue-300 font-semibold">
                          120 items
                        </span>
                        <span className="text-slate-400 font-mono">Paginated</span>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Question 2: What should I do with each item? */}
                <div className="space-y-3 pt-2">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                      Step 2 · Action Sequence
                    </span>
                    <h2 className="text-lg font-bold text-white sm:text-xl">
                      What should I do with each item?
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <button
                      type="button"
                      onClick={() => setTargetAction('download')}
                      className={`group rounded-2xl p-4 text-left transition-all ${
                        targetAction === 'download'
                          ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_20px_-4px_rgba(6,182,212,0.35)]'
                          : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-400">
                          <Download className="h-4 w-4" />
                        </div>
                        <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          targetAction === 'download' ? 'bg-cyan-500 text-black' : 'opacity-0'
                        }`}>
                          <Check className="h-3 w-3 font-bold" />
                        </div>
                      </div>
                      <div className="text-xs font-bold text-white">Download Each Item</div>
                      <p className="mt-1 text-[11px] text-slate-400 leading-snug">
                        Saves PDF/CSV attachments directly to local storage or cloud drive.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setTargetAction('select')}
                      className={`group rounded-2xl p-4 text-left transition-all ${
                        targetAction === 'select'
                          ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_20px_-4px_rgba(6,182,212,0.35)]'
                          : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
                          <CheckSquare className="h-4 w-4" />
                        </div>
                        <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          targetAction === 'select' ? 'bg-cyan-500 text-black' : 'opacity-0'
                        }`}>
                          <Check className="h-3 w-3 font-bold" />
                        </div>
                      </div>
                      <div className="text-xs font-bold text-white">Select Each Item</div>
                      <p className="mt-1 text-[11px] text-slate-400 leading-snug">
                        Clicks checkboxes to prepare multiple items for bulk batch action.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setTargetAction('process')}
                      className={`group rounded-2xl p-4 text-left transition-all ${
                        targetAction === 'process'
                          ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_20px_-4px_rgba(6,182,212,0.35)]'
                          : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
                          <FileCode className="h-4 w-4" />
                        </div>
                        <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          targetAction === 'process' ? 'bg-cyan-500 text-black' : 'opacity-0'
                        }`}>
                          <Check className="h-3 w-3 font-bold" />
                        </div>
                      </div>
                      <div className="text-xs font-bold text-white">Process Each Item</div>
                      <p className="mt-1 text-[11px] text-slate-400 leading-snug">
                        Extracts metadata fields and formats payload into clean JSON/Webhook.
                      </p>
                    </button>
                  </div>
                </div>

                {/* Target Data Stream Preview */}
                <div className="rounded-2xl border border-cyan-500/15 bg-[#101b33]/80 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <TableIcon className="h-4 w-4 text-cyan-400" />
                      <span className="text-xs font-bold text-white">Target Data Stream Preview</span>
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                        Sample Rows
                      </span>
                    </div>
                    <span className="text-[10px] text-cyan-400 font-mono">Live Preview</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] text-slate-300">
                      <thead>
                        <tr className="border-b border-slate-700/60 text-slate-400 text-[10px] uppercase">
                          <th className="py-1.5 px-2">Item ID</th>
                          <th className="py-1.5 px-2">Document Type</th>
                          <th className="py-1.5 px-2">Date</th>
                          <th className="py-1.5 px-2">Amount</th>
                          <th className="py-1.5 px-2 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        <tr>
                          <td className="py-1.5 px-2 font-mono text-cyan-400">INV-2026-001</td>
                          <td className="py-1.5 px-2">Invoice</td>
                          <td className="py-1.5 px-2">Nov 04, 2026</td>
                          <td className="py-1.5 px-2 font-mono">$4,280.00</td>
                          <td className="py-1.5 px-2 text-right text-emerald-400 font-semibold">● Ready</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 px-2 font-mono text-cyan-400">INV-2026-002</td>
                          <td className="py-1.5 px-2">Invoice</td>
                          <td className="py-1.5 px-2">Nov 05, 2026</td>
                          <td className="py-1.5 px-2 font-mono">$1,950.50</td>
                          <td className="py-1.5 px-2 text-right text-emerald-400 font-semibold">● Ready</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: SELECT RECORDS & FILTERS */}
            {currentStep === 3 && (
              <div className="space-y-4 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Data Target Scope
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    Which records should I process?
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Choose the scope of data items to extract, iterate through, or execute actions against.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 pt-2">
                  {/* Option 1: All Records */}
                  <button
                    type="button"
                    onClick={() => setRecordScope('all')}
                    className={`group rounded-2xl p-4 text-left transition-all ${
                      recordScope === 'all'
                        ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_24px_rgba(6,182,212,0.3)]'
                        : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-400">
                        <Layers className="h-5 w-5" />
                      </div>
                      <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                        recordScope === 'all' ? 'bg-cyan-500 text-black' : 'opacity-0'
                      }`}>
                        <Check className="h-3 w-3 font-bold" />
                      </div>
                    </div>
                    <div className="font-bold text-sm text-white">All Records</div>
                    <p className="mt-1 text-xs text-slate-400 leading-snug">
                      Process everything on the page.
                    </p>
                    <div className="mt-3 text-[11px] font-semibold text-slate-400 flex items-center gap-1">
                      <TableIcon className="h-3 w-3" />
                      <span>Entire table set</span>
                    </div>
                  </button>

                  {/* Option 2: Only New Records */}
                  <button
                    type="button"
                    onClick={() => setRecordScope('new')}
                    className={`group rounded-2xl p-4 text-left transition-all ${
                      recordScope === 'new'
                        ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_24px_rgba(6,182,212,0.3)]'
                        : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/20 text-purple-400">
                        <Sparkles className="h-5 w-5" />
                      </div>
                      <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                        recordScope === 'new' ? 'bg-cyan-500 text-black' : 'opacity-0'
                      }`}>
                        <Check className="h-3 w-3 font-bold" />
                      </div>
                    </div>
                    <div className="font-bold text-sm text-white">Only New</div>
                    <p className="mt-1 text-xs text-slate-400 leading-snug">
                      Skip items already processed in earlier runs.
                    </p>
                    <div className="mt-3 text-[11px] font-semibold text-cyan-300 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>Delta synchronization</span>
                    </div>
                  </button>

                  {/* Option 3: Custom Filter */}
                  <button
                    type="button"
                    onClick={() => setRecordScope('custom')}
                    className={`group rounded-2xl p-4 text-left transition-all ${
                      recordScope === 'custom'
                        ? 'border-2 border-cyan-400 bg-[#152342] shadow-[0_0_24px_rgba(6,182,212,0.3)]'
                        : 'border border-slate-800 bg-[#101b33]/60 hover:bg-[#152342]/70'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-500/20 text-teal-400">
                        <Filter className="h-5 w-5" />
                      </div>
                      <div className={`flex h-5 w-5 items-center justify-center rounded-full ${
                        recordScope === 'custom' ? 'bg-cyan-500 text-black' : 'opacity-0'
                      }`}>
                        <Check className="h-3 w-3 font-bold" />
                      </div>
                    </div>
                    <div className="font-bold text-sm text-white">Custom Filter</div>
                    <p className="mt-1 text-xs text-slate-400 leading-snug">
                      Choose specific items matching your conditions.
                    </p>
                    <div className="mt-3 text-[11px] font-semibold text-cyan-400 flex items-center gap-1">
                      <Sliders className="h-3 w-3" />
                      <span>Rule-builder active</span>
                    </div>
                  </button>
                </div>

                {/* Progressive Filter Builder Card (When Custom Filter is Active) */}
                {recordScope === 'custom' && (
                  <div className="space-y-4 rounded-2xl border border-cyan-500/20 bg-[#101c36] p-5 shadow-xl transition-all">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-white">Filter Conditions</h3>
                        <p className="text-xs text-slate-400">Records must satisfy these parameter rules</p>
                      </div>

                      {/* Segmented Match Mode Switch */}
                      <div className="inline-flex rounded-full border border-slate-800 bg-black/30 p-0.5">
                        <button
                          type="button"
                          onClick={() => setMatchMode('all')}
                          className={`rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                            matchMode === 'all'
                              ? 'bg-cyan-500 text-black shadow-[0_0_12px_rgba(6,182,212,0.5)]'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Match ALL conditions
                        </button>
                        <button
                          type="button"
                          onClick={() => setMatchMode('any')}
                          className={`rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                            matchMode === 'any'
                              ? 'bg-cyan-500 text-black shadow-[0_0_12px_rgba(6,182,212,0.5)]'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Match ANY condition
                        </button>
                      </div>
                    </div>

                    {/* Condition Rows */}
                    <div className="space-y-2.5">
                      {filterConditions.map((cond, idx) => (
                        <div
                          key={cond.id}
                          className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 rounded-xl border border-slate-800 bg-[#0c1427] p-2.5"
                        >
                          <span className="text-[11px] font-bold text-cyan-400 px-1 shrink-0">
                            {idx === 0 ? 'Where' : matchMode === 'all' ? 'AND' : 'OR'}
                          </span>

                          {/* Column Select */}
                          <select
                            value={cond.field}
                            onChange={(e) => handleUpdateCondition(cond.id, { field: e.target.value })}
                            className="rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs text-white focus:border-cyan-400 focus:outline-none"
                          >
                            {availableColumns.map((col) => (
                              <option key={col} value={col}>{col}</option>
                            ))}
                            <option value="__custom__">+ Custom field</option>
                          </select>

                          {cond.field === '__custom__' && (
                            <input
                              type="text"
                              value={cond.customField}
                              onChange={(e) => handleUpdateCondition(cond.id, { customField: e.target.value })}
                              placeholder="Field name..."
                              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                            />
                          )}

                          {/* Operator */}
                          <select
                            value={cond.operator}
                            onChange={(e) => handleUpdateCondition(cond.id, { operator: e.target.value as any })}
                            className="rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs text-white focus:border-cyan-400 focus:outline-none"
                          >
                            <option value="contains">contains</option>
                            <option value="equals">equals</option>
                            <option value="dateBetween">date between</option>
                          </select>

                          {/* Value Input */}
                          {cond.operator === 'dateBetween' ? (
                            <div className="flex items-center gap-1.5 flex-1">
                              <input
                                type="date"
                                value={cond.dateFrom}
                                onChange={(e) => handleUpdateCondition(cond.id, { dateFrom: e.target.value })}
                                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-white"
                              />
                              <span className="text-slate-500 text-xs">to</span>
                              <input
                                type="date"
                                value={cond.dateTo}
                                onChange={(e) => handleUpdateCondition(cond.id, { dateTo: e.target.value })}
                                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-white"
                              />
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={cond.value}
                              onChange={(e) => handleUpdateCondition(cond.id, { value: e.target.value })}
                              placeholder="Filter value..."
                              className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                            />
                          )}

                          {/* Remove button */}
                          {filterConditions.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveCondition(cond.id)}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 transition-colors"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={handleAddCondition}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-colors"
                      >
                        <Plus className="h-4 w-4" />
                        <span>Add Another Condition</span>
                      </button>

                      <div className="flex items-center gap-1.5 rounded-full bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-300">
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Targeting specific records</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* STEP 4: REVIEW & LAUNCH (Summary & Collapsible Advanced Settings) */}
            {currentStep === 4 && (
              <div className="space-y-5 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Step 4 · Final Verification
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    Review & Launch Automation
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Verify your execution plan below. Everything is configured and ready to run.
                  </p>
                </div>

                {/* Plan Summary Cards */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-cyan-500/20 bg-[#101b33]/80 p-4 space-y-1">
                    <span className="text-[10px] font-bold uppercase text-slate-400">Execution Strategy</span>
                    <div className="text-base font-bold text-white flex items-center gap-2">
                      {execMode === 'standard' ? (
                        <>
                          <Play className="h-4 w-4 text-cyan-400 fill-current" />
                          <span>Run Once (1x Execution)</span>
                        </>
                      ) : (
                        <>
                          <Repeat className="h-4 w-4 text-cyan-400" />
                          <span>Repeat Tasks (Batch Processing)</span>
                        </>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {execMode === 'standard'
                        ? 'Executes recorded steps once sequentially'
                        : `Repeating on "${selectedCollection}" with "${targetAction}" action`}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-cyan-500/20 bg-[#101b33]/80 p-4 space-y-1">
                    <span className="text-[10px] font-bold uppercase text-slate-400">Target Data Scope</span>
                    <div className="text-base font-bold text-white flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-cyan-400" />
                      <span>
                        {execMode === 'standard'
                          ? 'Standard Single Pass'
                          : recordScope === 'all'
                          ? 'All Records (Entire Set)'
                          : recordScope === 'new'
                          ? 'Only New Records (NEW_ONLY)'
                          : `Custom Filter (${filterConditions.length} rules)`}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {isRunnerOnline ? 'Desktop Worker Online & Connected' : 'Waiting for desktop worker'}
                    </p>
                  </div>
                </div>

                {/* COLLAPSIBLE ADVANCED SETTINGS ACCORDION */}
                <div className="rounded-2xl border border-slate-800 bg-[#0e172a]/90 overflow-hidden transition-all">
                  <button
                    type="button"
                    onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
                    className="flex w-full items-center justify-between p-4 text-left hover:bg-slate-800/40 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <Sliders className="h-4 w-4 text-cyan-400" />
                      <span className="text-xs font-bold text-white">
                        Advanced Settings & Loop Fine-Tuning
                      </span>
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
                        Optional
                      </span>
                    </div>
                    <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${isAdvancedOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {isAdvancedOpen && (
                    <div className="border-t border-slate-800 p-5 space-y-5 text-xs">
                      {/* Process Multiple Companies (Two-Level Iteration) */}
                      <div className="space-y-3 rounded-xl border border-slate-800 bg-[#0c1427] p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-bold text-white">Process Multiple Companies</span>
                            <p className="text-[11px] text-slate-400">
                              Controlled two-level iteration across outer companies and inner records.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsTwoLevel(!isTwoLevel)}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                              isTwoLevel ? 'bg-cyan-500' : 'bg-slate-700'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                isTwoLevel ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </div>

                        {isTwoLevel && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-800">
                            <div>
                              <label className="text-[11px] text-slate-400">Company Anchor Step</label>
                              <select
                                value={outerAnchorIndex}
                                onChange={(e) => setOuterAnchorIndex(Number(e.target.value))}
                                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white"
                              >
                                {steps.map((s, idx) => (
                                  <option key={idx} value={idx}>{formatStepLabel(s, idx)}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] text-slate-400">Invoice Anchor Step</label>
                              <select
                                value={innerAnchorIndex}
                                onChange={(e) => setInnerAnchorIndex(Number(e.target.value))}
                                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white"
                              >
                                {steps.map((s, idx) => (
                                  <option key={idx} value={idx}>{formatStepLabel(s, idx)}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Batch Iteration Limits */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="text-[11px] text-slate-400">Max Items Limit (How many items)</label>
                          <input
                            type="number"
                            value={maxItems}
                            onChange={(e) => setMaxItems(e.target.value)}
                            placeholder="e.g. 50 (or leave empty for all)"
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder-slate-500"
                          />
                        </div>

                        <div>
                          <label className="text-[11px] text-slate-400">Collection Anchor Step</label>
                          <select
                            value={anchorStepIndex}
                            onChange={(e) => setAnchorStepIndex(Number(e.target.value))}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white"
                          >
                            {steps.map((s, idx) => (
                              <option key={idx} value={idx}>{formatStepLabel(s, idx)}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* BOTTOM WIZARD CONTROLS */}
            <div className="flex items-center justify-between border-t border-slate-800/80 pt-4">
              <button
                type="button"
                onClick={() => setCurrentStep((prev) => (prev > 1 ? (prev - 1) as any : 1))}
                disabled={currentStep === 1 || submitting}
                className={`inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-xs font-semibold transition-all ${
                  currentStep === 1
                    ? 'opacity-40 cursor-not-allowed text-slate-600'
                    : 'border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white'
                }`}
              >
                <ChevronLeft className="h-4 w-4" />
                <span>Back</span>
              </button>

              <div className="flex items-center gap-3">
                {currentStep < 4 ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (currentStep === 1 && execMode === 'standard') {
                        // Single execution doesn't need loop collection or filter steps
                        setCurrentStep(4);
                      } else {
                        setCurrentStep((prev) => (prev < 4 ? (prev + 1) as any : 4));
                      }
                    }}
                    className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 px-6 py-2.5 text-xs font-bold text-black shadow-[0_0_18px_rgba(6,182,212,0.4)] hover:shadow-[0_0_24px_rgba(6,182,212,0.65)] hover:scale-[1.02] active:scale-[0.98] transition-all"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleDispatchExecution}
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-cyan-400 via-teal-300 to-blue-500 px-7 py-3 text-sm font-extrabold text-slate-950 shadow-[0_0_28px_rgba(6,182,212,0.6)] hover:shadow-[0_0_36px_rgba(6,182,212,0.85)] hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-black" />
                        <span>Dispatching...</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                        <span>Dispatch Execution</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}

export default ExecutionPreflightModal;
