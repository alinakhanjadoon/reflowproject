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
  Globe,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  Clock,
  Check,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Filter,
  Calendar,
  Layers3,
  Flame,
  ArrowRight,
  Sliders,
  CheckSquare,
  FileCode,
  Tag
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
  outerStartIndex: number;
  tableStepIndex: number;
  innerStartIndex: number;
  innerEndIndex: number;
} {
  if (!Array.isArray(steps) || steps.length < 3) {
    return { hasTwoLevel: false, dropdownStepIndex: -1, outerStartIndex: 0, tableStepIndex: -1, innerStartIndex: 0, innerEndIndex: 0 };
  }

  const isScrollOrNav = (s: any) => {
    if (!s) return true;
    const type = String(s.type || s.action || '').toUpperCase();
    const name = String(s.name || s.elementName || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    return type === 'SCROLL' || type === 'NAVIGATE' || /scroll/i.test(name);
  };

  const isAuth = (s: any) => {
    if (!s) return false;
    const name = String(s.name || s.elementName || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const tag = String(s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toLowerCase();
    const inputType = String(s.target?.fingerprint?.type || s.fingerprint?.type || '').toLowerCase();
    if (/(username|password|email|sign[-_\s]*in|login|authenticat)/i.test(name)) return true;
    if (tag === 'input' && (inputType === 'password' || inputType === 'email')) return true;
    return false;
  };

  let dropdownStepIndex = -1;
  let outerStartIndex = -1;
  let tableStepIndex = -1;

  // Pass 1: Find Company Anchor
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isScrollOrNav(s) || isAuth(s)) continue;

    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();
    const text = (s.name || s.elementName || s.description || s.target?.elementName || s.target?.friendlyName || '').toLowerCase();
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');

    const isOptionItem = Boolean(
      tag === 'MAT-OPTION' || tag === 'OPTION' || role === 'option' ||
      /\b(mat-option|\[role=["']option["']\]|select\s*>\s*option|tt-suggestion|data-company|x-boundlist-item)\b/i.test(selectors)
    );

    const isCompanyItem = /(company|customer|account|entity)/i.test(text) || /(company|customer|account|entity)/i.test(selectors);

    if (isOptionItem && (isCompanyItem || !/select\s*all/i.test(text))) {
      dropdownStepIndex = i;
      break;
    }
  }

  // Fallback for Company Anchor if no mat-option/tt-suggestion found
  if (dropdownStepIndex === -1) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (isScrollOrNav(s) || isAuth(s)) continue;
      const text = (s.name || s.elementName || s.description || '').toLowerCase();
      const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
      const selectors = candidates.map((c: any) => c.value || '').join(' ');
      if (/(company|customer|account|entity)/i.test(text) && !/change company button|submit/i.test(text) && !/menu|link/i.test(text)) {
        dropdownStepIndex = i;
        break;
      }
    }
  }

  // Determine outerStartIndex: look back from dropdownStepIndex for the trigger that opened the dropdown/menu/modal
  if (dropdownStepIndex > 0) {
    outerStartIndex = dropdownStepIndex;
    for (let j = dropdownStepIndex - 1; j >= 0; j--) {
      const ps = steps[j];
      if (isAuth(ps) || isScrollOrNav(ps)) break;
      const ptext = (ps.name || ps.elementName || ps.description || '').toLowerCase();
      const pcandidates = Array.isArray(ps.target?.candidates) ? ps.target.candidates : [];
      const pselectors = pcandidates.map((c: any) => c.value || '').join(' ');
      if (/(company|customer|select\s*all|entity|charge\s*up)/i.test(ptext) || /(mat-select|select|dropdown|entity)/i.test(pselectors)) {
        outerStartIndex = j;
      } else {
        break;
      }
    }
  } else {
    outerStartIndex = 0;
  }

  // Pass 2: Find Record Anchor (Level 2)
  const minTableIndex = dropdownStepIndex !== -1 ? dropdownStepIndex + 1 : 0;
  for (let i = minTableIndex; i < steps.length; i++) {
    const s = steps[i];
    if (isScrollOrNav(s) || isAuth(s)) continue;

    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');
    const text = (s.name || s.elementName || s.description || '').toLowerCase();

    // Exclude header buttons or top navigation links (e.g. "Invoices Link")
    if (/menu-link|screen-text|button#|btnChange/i.test(selectors)) continue;
    if (tag === 'A' && /invoices\s*link/i.test(text)) continue;

    const isTableRecord = Boolean(
      tag === 'TR' || tag === 'TD' || role === 'row' || role === 'gridcell' ||
      s.isCheckbox || (tag === 'INPUT' && s.target?.fingerprint?.type === 'checkbox') ||
      /\b(tr\b|td\b|tbody|x-grid-item|x-grid-row|x-grid-cell|gridcell|table.*input)\b/i.test(selectors)
    );

    if (isTableRecord) {
      tableStepIndex = i;
      break;
    }
  }

  const innerStartIndex = tableStepIndex !== -1 ? tableStepIndex : 0;
  const innerEndIndex = steps.length > 0 ? steps.length - 1 : 0;

  const hasTwoLevel = dropdownStepIndex !== -1 && tableStepIndex !== -1 && tableStepIndex > dropdownStepIndex;
  return { hasTwoLevel, dropdownStepIndex, outerStartIndex, tableStepIndex, innerStartIndex, innerEndIndex };
}

function detectLoopCandidate(steps: Array<any>): number {
  if (!Array.isArray(steps) || steps.length === 0) return 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.role === 'LOOP' || s.isLoop || s.isLoopCandidate || s.loopMode === 'sequential_iteration') {
      return i;
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const type = (s.type || s.action || '').toUpperCase();
    if (type === 'EXTRACT_TABLE' || type === 'EXTRACT_TEXT' || type === 'LOOP_START') {
      return i;
    }
  }

  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const tag = (s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
    const role = (s.target?.fingerprint?.role || '').toLowerCase();
    const text = (s.name || s.elementName || s.description || '').toLowerCase();
    const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
    const selectors = candidates.map((c: any) => c.value || '').join(' ');

    if (tag === 'TR' || tag === 'TD' || role === 'row' || role === 'gridcell') return i;
    if (/\b(tr:nth-child|tbody\s*>\s*tr|x-grid-row|row-\d+|item-\d+|\[role=["']row["']\])\b/i.test(selectors)) return i;
    if (text.includes('checkbox') || text.includes('row') || text.includes('invoice') || text.includes('item')) return i;
  }

  return 0;
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
  const type = String(step.type || step.action || '').toUpperCase();
  const typeBadge = type === 'SCROLL' ? ' (Scroll)' : '';
  return `Step #${idx + 1}: ${label}${typeBadge}${role}`;
}

export function ExecutionPreflightModal({
  isOpen,
  onClose,
  workflow,
  onRunDispatched
}: ExecutionPreflightModalProps) {
  const { orgId, isRunnerOnline, refreshDashboard, openRunDetails } = useDashboard();

  // Wizard Step Tracker: 1 = Mode, 2 = Loop Steps, 3 = Filters & Limits, 4 = Review & Dispatch
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  // Core execution configuration
  const [execMode, setExecMode] = useState<'standard' | 'loop'>('standard');
  const [newOnly, setNewOnly] = useState(false);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [activeField, setActiveField] = useState<string>('Type');

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

  // Limits & bounds
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
  const [scanningColumns, setScanningColumns] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extract workflow steps
  const steps = useMemo(() => getWorkflowSteps(workflow), [workflow]);
  const twoLevelInfo = useMemo(() => detectTwoLevelCandidates(steps), [steps]);

  // Initialize settings when workflow opens
  useEffect(() => {
    if (!isOpen || !workflow) return;

    setCurrentStep(1);
    setError(null);
    setScanMessage(null);

    const initialColumns = extractWorkflowColumns(workflow);
    setAvailableColumns(initialColumns);
    if (initialColumns[0]) {
      setActiveField(initialColumns[0]);
    }

    const valuesMap = extractFieldValuesMap(workflow);
    setFieldValuesMap(valuesMap);

    const wd = (workflow.workflow_definition || {}) as Record<string, unknown>;

    // Check shared loop signal
    const signals = deriveLoopSignals(wd);
    const hasLoopSignal = signals.isLoop;

    if (hasLoopSignal || twoLevelInfo.hasTwoLevel) {
      setExecMode('loop');
    } else {
      setExecMode('standard');
    }

    const detectedAnchor = detectLoopCandidate(steps);
    setAnchorStepIndex(detectedAnchor);
    setStartStepIndex(detectedAnchor);
    setEndStepIndex(steps.length > 0 ? steps.length - 1 : 0);

    if (twoLevelInfo.hasTwoLevel) {
      setIsTwoLevel(true);
      setOuterAnchorIndex(twoLevelInfo.dropdownStepIndex);
      setOuterStartIndex(twoLevelInfo.outerStartIndex !== undefined && twoLevelInfo.outerStartIndex >= 0 ? twoLevelInfo.outerStartIndex : twoLevelInfo.dropdownStepIndex);
      setOuterEndIndex(steps.length > 0 ? steps.length - 1 : 0);
      setInnerAnchorIndex(twoLevelInfo.tableStepIndex);
      setInnerStartIndex(twoLevelInfo.innerStartIndex !== undefined && twoLevelInfo.innerStartIndex >= 0 ? twoLevelInfo.innerStartIndex : twoLevelInfo.tableStepIndex);
      setInnerEndIndex(twoLevelInfo.innerEndIndex !== undefined && twoLevelInfo.innerEndIndex >= 0 ? twoLevelInfo.innerEndIndex : Math.max(twoLevelInfo.tableStepIndex, steps.length - 1));
    } else {
      setIsTwoLevel(false);
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
  }, [isOpen, workflow, steps, twoLevelInfo]);

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
    if (filterConditions.length > 0) {
      if (col === '__custom__') {
        handleUpdateCondition(filterConditions[0].id, { field: '__custom__' });
      } else {
        handleUpdateCondition(filterConditions[0].id, { field: col, customField: '' });
      }
    }
  };

  const handleSelectValuePill = (val: string) => {
    if (filterConditions.length > 0) {
      handleUpdateCondition(filterConditions[0].id, { value: val });
    }
  };

  // Re-scan columns from bridge or cloud
  const handleRefreshFields = async () => {
    if (!workflow) return;
    setScanningColumns(true);
    setScanMessage(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      let res = await fetch('http://127.0.0.1:49152/discover', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          workflow,
          loopStepIndex: anchorStepIndex,
          anchorStepIndex,
          url: workflow.portal_url
        })
      }).catch(() => null);

      if (!res || !res.ok) {
        res = await fetch(`/api/v1/workflows/${workflow.id}/discover`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => null);
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

        if (data?.availableFields && Array.isArray(data.availableFields)) {
          data.availableFields.forEach((f: any) => {
            if (typeof f === 'string' && f.trim()) discovered.add(f.trim());
          });
        }
        if (data?.items && Array.isArray(data.items)) {
          data.items.slice(0, 20).forEach((item: any) => {
            if (item && typeof item === 'object') {
              Object.entries(item).forEach(([k, v]) => {
                discovered.add(k);
                appendVal(k, v);
              });
            }
          });
        }

        if (discovered.size > 0) {
          const newCols = Array.from(discovered);
          setAvailableColumns((prev) => Array.from(new Set([...prev, ...newCols])));
          setFieldValuesMap((prev) => {
            const merged = { ...prev };
            Object.entries(nextValMap).forEach(([k, vals]) => {
              merged[k] = Array.from(new Set([...(merged[k] || []), ...vals]));
            });
            return merged;
          });
          setScanMessage(`Discovered ${discovered.size} column(s) from page`);
        } else {
          setScanMessage('Scan complete; using recorded workflow columns');
        }
      } else {
        setScanMessage('Desktop bridge idle; using recorded workflow columns');
      }
    } catch {
      setScanMessage('Bridge unavailable; using recorded workflow columns');
    } finally {
      setScanningColumns(false);
      setTimeout(() => setScanMessage(null), 3500);
    }
  };

  // Step range validation
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

  // Dispatch execution preserving exact backend schema
  const handleDispatchExecution = async () => {
    if (!workflow) return;
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
        const validConditions = filterConditions.map((c) => ({
          field: c.field === '__custom__' ? c.customField.trim() : c.field.trim(),
          operator: c.operator,
          value: c.operator === 'dateBetween' ? { from: c.dateFrom, to: c.dateTo } : c.value.trim()
        })).filter((c) => c.field && (typeof c.value === 'object' ? (c.value as any).from : c.value));

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
        mode: execMode === 'standard' ? 'single' : 'loop',
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

  const domain = formatDomain(workflow.portal_url);

  // Companion Robot dynamic info per step
  const mascotInfo = {
    1: {
      image: REFLOW_MASCOT_URL,
      title: 'Choose Execution Strategy',
      speech: 'Hi! How would you like me to run this workflow? Choose Standard Run for a single 1x execution, or Loop / Batch to repeat across rows or multiple companies!',
      status: 'Step 1 of 4 · Execution Strategy',
      badge: 'Assistant Online'
    },
    2: {
      image: REFLOW_MASCOT_INSPECTING_URL,
      title: 'Review Repeating Steps & Anchor',
      speech: 'Here are your exact recorded steps! I auto-detected the collection anchor and loop range below. Check which steps should repeat for every item.',
      status: 'Step 2 of 4 · Step Sequence & Anchors',
      badge: 'Inspecting Steps'
    },
    3: {
      image: REFLOW_MASCOT_URL,
      title: 'Target Records & Filters',
      speech: 'Tell me which records you need! You can process all records, only new records (NEW_ONLY), or filter by clicking discovered column and option pills!',
      status: 'Step 3 of 4 · Filters & Scope',
      badge: 'Listening'
    },
    4: {
      image: REFLOW_MASCOT_URL,
      title: 'Ready for Dispatch',
      speech: 'Everything is verified and ready to run! Review the final summary below, then click Dispatch Execution to launch.',
      status: 'Step 4 of 4 · Review & Launch',
      badge: 'Ready to Dispatch'
    }
  }[currentStep];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-xl animate-in fade-in duration-200">
      <div className="relative mx-auto flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-cyan-500/25 bg-[#0c1427]/98 shadow-[0_24px_64px_rgba(0,0,0,0.85)]">
        
        {/* TOP MODAL HEADER & 4-STAGE INTERACTIVE STEPPER */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-cyan-500/15 bg-[#101b33]/90 px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-black shadow-md">
              <Sparkles className="h-5 w-5" />
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-cyan-300 ring-2 ring-[#101b33] animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white tracking-tight">{workflow.name}</span>
                {domain && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/15 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                    <Globe className="h-3 w-3 text-cyan-400" />
                    {domain}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">Execution Preflight & Dispatch Mission Control</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Interactive Step Buttons */}
            <div className="hidden sm:flex items-center gap-1 bg-slate-900/80 p-1 rounded-2xl border border-slate-800">
              {[
                { step: 1 as const, label: 'Mode' },
                { step: 2 as const, label: 'Loop Steps' },
                { step: 3 as const, label: 'Filters' },
                { step: 4 as const, label: 'Dispatch' }
              ].map(({ step, label }) => (
                <button
                  key={step}
                  type="button"
                  onClick={() => setCurrentStep(step)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                    currentStep === step
                      ? 'bg-cyan-500 text-black shadow-[0_0_12px_rgba(6,182,212,0.4)]'
                      : step < currentStep
                      ? 'text-cyan-300 hover:bg-slate-800'
                      : 'text-slate-400 hover:bg-slate-800/50'
                  }`}
                >
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                    currentStep === step ? 'bg-black text-cyan-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {step < currentStep ? '✓' : step}
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800/80 transition cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* MODAL MAIN BODY: Mascot Left Column + Step Content Right Column */}
        <div className="grid flex-1 grid-cols-1 overflow-y-auto p-5 sm:p-6 lg:grid-cols-12 gap-6 max-h-[76vh]">
          
          {/* LEFT COLUMN: Companion Mascot & Conversational Speech Bubble */}
          <div className="flex flex-col items-center justify-start lg:col-span-4 space-y-4">
            <div className="relative group w-full flex flex-col items-center rounded-3xl border border-cyan-500/20 bg-gradient-to-b from-[#13203c]/90 to-[#0e172a]/90 p-5 shadow-xl backdrop-blur-xl">
              
              {/* Mascot 3D Portrait */}
              <div className="relative flex items-center justify-center mb-3">
                <div className="absolute inset-0 rounded-full bg-cyan-500/20 blur-xl group-hover:bg-cyan-500/30 transition-all" />
                <img
                  src={mascotInfo.image}
                  alt="ReFlow Assistant Companion"
                  className="relative h-32 w-32 object-contain drop-shadow-[0_12px_24px_rgba(6,182,212,0.3)] transition-transform duration-300 hover:scale-105"
                />
              </div>

              {/* Speech Bubble */}
              <div className="relative w-full rounded-2xl border border-cyan-500/25 bg-[#0a1020]/90 p-3.5 shadow-md">
                <div className="text-xs font-bold text-cyan-300 mb-1 flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>{mascotInfo.title}</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {mascotInfo.speech}
                </p>
              </div>

              {/* Status Pill */}
              <div className="mt-4 flex w-full items-center justify-between px-2 text-[11px] text-slate-400 border-t border-slate-800 pt-3">
                <span>Assistant Status</span>
                <span className="flex items-center gap-1 font-semibold text-cyan-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  {mascotInfo.badge}
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Interactive Configuration Workspace */}
          <div className="flex flex-col justify-between lg:col-span-8 space-y-6">

            {/* STEP 1: EXECUTION STRATEGY & TWO-LEVEL TOGGLE */}
            {currentStep === 1 && (
              <div className="space-y-4 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Step 1 · Execution Strategy
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    What would you like me to do?
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Choose how ReFlow should execute this recorded workflow.
                  </p>
                </div>

                {/* Strategy Cards */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-1">
                  {/* Option 1: Standard Run */}
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
                        Standard Run
                      </h3>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                        Replay recorded workflow once from start to finish. Ideal for spot-checking, manual verification, or single tests.
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-cyan-400">
                      <Clock className="h-3.5 w-3.5" />
                      <span>Instant 1x execution</span>
                    </div>
                  </div>

                  {/* Option 2: Loop / Batch */}
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
                        Loop / Batch
                      </h3>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                        Iterate across repeating table rows, invoices, or records and download files automatically.
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-cyan-400">
                      <Layers className="h-3.5 w-3.5" />
                      <span>Batch array processing</span>
                    </div>
                  </div>
                </div>

                {/* If Loop mode: Two-Level Iteration toggle & callout banner */}
                {execMode === 'loop' && (
                  <div className="space-y-3 pt-2">
                    {/* Controlled Two-Level Iteration Switch Card */}
                    <div className="flex items-center justify-between p-4 rounded-2xl border border-cyan-500/25 bg-[#101c36] shadow-sm">
                      <div className="space-y-0.5">
                        <div className="text-xs font-bold text-white flex items-center gap-2">
                          <span>Two-Level Iteration (Company → Records)</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 uppercase">
                            Controlled
                          </span>
                        </div>
                        <p className="text-xs text-slate-400">
                          Outer loop selects companies; inner loop processes all invoices/records per company.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsTwoLevel(!isTwoLevel)}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          isTwoLevel ? 'bg-cyan-500' : 'bg-slate-700'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                            isTwoLevel ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    {/* Auto-detected Dropdown & Table records callout */}
                    {twoLevelInfo.hasTwoLevel && (
                      <div className="p-4 bg-cyan-950/40 border border-cyan-500/30 rounded-2xl text-xs space-y-1.5">
                        <div className="font-bold text-cyan-300 flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-cyan-400" />
                          <span>Filter Dropdown & Table Records Detected</span>
                        </div>
                        <p className="text-slate-300 text-xs leading-relaxed">
                          This portal has a filter option (Step #{twoLevelInfo.dropdownStepIndex + 1}) and data table records (Step #{twoLevelInfo.tableStepIndex + 1}).
                          In <strong>Single-Loop</strong> mode, ReFlow iterates over the table records.
                          If you want to cycle through each customer in the dropdown and download their records, toggle on <strong>Controlled Two-Level Iteration</strong> above.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* STEP 2: LOOP STEPS & RANGE ("WHAT TO LOOP ON") */}
            {currentStep === 2 && (
              <div className="space-y-5 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Step 2 · Step Selection & Loop Range
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    Which steps should repeat?
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {execMode === 'standard'
                      ? 'Standard Run will execute all recorded steps once from start to finish.'
                      : 'Choose the collection anchor that identifies rows, and define the start and end steps for the loop.'}
                  </p>
                </div>

                {execMode === 'loop' && (
                  <div className="space-y-4">
                    {/* TWO-LEVEL ITERATION STEPS */}
                    {isTwoLevel ? (
                      <div className="space-y-3">
                        {/* Company Outer Loop */}
                        <div className="space-y-3 p-4 rounded-2xl border border-cyan-500/30 bg-[#101c36]/90">
                          <div className="flex items-center justify-between border-b border-cyan-500/20 pb-2">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                              <span className="text-xs font-bold text-white uppercase tracking-wider">
                                Level 1: Company Collection (Outer Loop)
                              </span>
                            </div>
                            <span className="text-xs font-mono font-semibold text-cyan-300">
                              Company Anchor: Step #{outerAnchorIndex + 1}
                            </span>
                          </div>

                          <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-slate-300">
                              Company Anchor Step (Selects Company in Portal)
                            </label>
                            <select
                              value={outerAnchorIndex}
                              onChange={(e) => {
                                const idx = parseInt(e.target.value, 10);
                                setOuterAnchorIndex(idx);
                                if (idx < outerStartIndex) setOuterStartIndex(idx);
                              }}
                              className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
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
                              <label className="block text-[11px] text-slate-400 mb-1">
                                Outer Start Step
                              </label>
                              <select
                                value={outerStartIndex}
                                onChange={(e) => setOuterStartIndex(parseInt(e.target.value, 10))}
                                className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                              >
                                {steps.map((step: any, idx: number) => (
                                  <option key={idx} value={idx}>
                                    #{idx + 1}: {formatStepLabel(step, idx)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[11px] text-slate-400 mb-1">
                                Return Step to Company View (Outer End)
                              </label>
                              <select
                                value={outerEndIndex}
                                onChange={(e) => setOuterEndIndex(parseInt(e.target.value, 10))}
                                className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
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

                        {/* Record Inner Loop */}
                        <div className="space-y-3 p-4 rounded-2xl border border-emerald-500/30 bg-[#0d222a]/90">
                          <div className="flex items-center justify-between border-b border-emerald-500/20 pb-2">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                              <span className="text-xs font-bold text-white uppercase tracking-wider">
                                Level 2: Record Collection (Inner Invoices)
                              </span>
                            </div>
                            <span className="text-xs font-mono font-semibold text-emerald-300">
                              Record Anchor: Step #{innerAnchorIndex + 1}
                            </span>
                          </div>

                          <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-slate-300">
                              Record Anchor Step (Identifies Rows to Iterate)
                            </label>
                            <select
                              value={innerAnchorIndex}
                              onChange={(e) => {
                                const idx = parseInt(e.target.value, 10);
                                setInnerAnchorIndex(idx);
                                if (idx < innerStartIndex) setInnerStartIndex(idx);
                              }}
                              className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
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
                              <label className="block text-[11px] text-slate-400 mb-1">
                                Inner Start Step
                              </label>
                              <select
                                value={innerStartIndex}
                                onChange={(e) => setInnerStartIndex(parseInt(e.target.value, 10))}
                                className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                              >
                                {steps.map((step: any, idx: number) => (
                                  <option key={idx} value={idx}>
                                    #{idx + 1}: {formatStepLabel(step, idx)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[11px] text-slate-400 mb-1">
                                Inner End Step
                              </label>
                              <select
                                value={innerEndIndex}
                                onChange={(e) => setInnerEndIndex(parseInt(e.target.value, 10))}
                                className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
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
                      </div>
                    ) : (
                      /* SINGLE COLLECTION LOOP */
                      <div className="space-y-4">
                        {/* Collection Anchor Dropdown */}
                        <div className="space-y-1.5 p-4 rounded-2xl border border-cyan-500/25 bg-[#101c36]">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-xs font-bold text-white">
                              Collection Anchor Step (Identifies Rows / Items)
                            </label>
                            <span className="text-xs font-mono font-semibold text-cyan-300">
                              Step #{anchorStepIndex + 1}
                            </span>
                          </div>
                          <select
                            value={anchorStepIndex}
                            onChange={(e) => {
                              const idx = parseInt(e.target.value, 10);
                              setAnchorStepIndex(idx);
                              if (idx < startStepIndex) setStartStepIndex(idx);
                              if (idx > endStepIndex) setEndStepIndex(idx);
                            }}
                            className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                          >
                            {steps.map((step: any, idx: number) => {
                              const isDetected = idx === detectLoopCandidate(steps);
                              return (
                                <option key={idx} value={idx}>
                                  {formatStepLabel(step, idx)} {isDetected ? '(Auto-detected Collection Anchor)' : ''}
                                </option>
                              );
                            })}
                          </select>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Identifies the collection (table, list, cards) to iterate over.
                          </p>
                        </div>

                        {/* Loop Range: Start & End */}
                        <div className="space-y-3 p-4 rounded-2xl border border-slate-800 bg-[#0e172a]">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-white">
                              Loop Range (Steps Repeated per Item)
                            </span>
                            <span className="text-xs font-mono text-cyan-400">
                              Steps #{startStepIndex + 1}..#{endStepIndex + 1} ({Math.max(1, endStepIndex - startStepIndex + 1)} steps)
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[11px] text-slate-400 mb-1">
                                Start Step (Inclusive)
                              </label>
                              <select
                                value={startStepIndex}
                                onChange={(e) => setStartStepIndex(parseInt(e.target.value, 10))}
                                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                              >
                                {steps.map((step: any, idx: number) => (
                                  <option key={idx} value={idx}>
                                    #{idx + 1}: {formatStepLabel(step, idx)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[11px] text-slate-400 mb-1">
                                End Step (Inclusive)
                              </label>
                              <select
                                value={endStepIndex}
                                onChange={(e) => setEndStepIndex(parseInt(e.target.value, 10))}
                                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                              >
                                {steps.map((step: any, idx: number) => (
                                  <option key={idx} value={idx}>
                                    #{idx + 1}: {formatStepLabel(step, idx)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {/* 3 Summary Breakdown Cards */}
                          <div className="grid grid-cols-3 gap-2 pt-2 text-center text-xs">
                            <div className="p-2.5 rounded-xl border border-slate-800 bg-slate-900/60">
                              <span className="text-[10px] text-slate-400 block font-medium">Setup (Once)</span>
                              <span className="font-semibold text-slate-200 mt-0.5 block">
                                {startStepIndex > 0 ? `Steps 1..${startStepIndex}` : 'None'}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl border border-cyan-500/30 bg-cyan-950/20">
                              <span className="text-[10px] text-cyan-400 block font-medium">Loop (Per Item)</span>
                              <span className="font-bold text-cyan-300 mt-0.5 block">
                                Steps {startStepIndex + 1}..{endStepIndex + 1}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl border border-slate-800 bg-slate-900/60">
                              <span className="text-[10px] text-slate-400 block font-medium">Teardown (Once)</span>
                              <span className="font-semibold text-slate-200 mt-0.5 block">
                                {endStepIndex < steps.length - 1 ? `Steps ${endStepIndex + 2}..${steps.length}` : 'None'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* VISUAL STEP SEQUENCE TIMELINE */}
                <div className="space-y-2 p-4 rounded-2xl border border-slate-800 bg-[#0e172a]/90">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Layers3 className="h-4 w-4 text-cyan-400" />
                      <span>Recorded Steps Sequence ({steps.length} total)</span>
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Step execution breakdown
                    </span>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {steps.map((step: any, idx: number) => {
                      const isCompany = isTwoLevel && idx === outerAnchorIndex;
                      const isRecord = (isTwoLevel && idx === innerAnchorIndex) || (!isTwoLevel && idx === anchorStepIndex);
                      const inLoop = isTwoLevel
                        ? (idx >= innerStartIndex && idx <= innerEndIndex)
                        : (idx >= startStepIndex && idx <= endStepIndex);
                      const isSetup = isTwoLevel ? (idx < outerStartIndex) : (idx < startStepIndex);
                      const isTeardown = isTwoLevel ? (idx > outerEndIndex) : (idx > endStepIndex);

                      return (
                        <div
                          key={idx}
                          className={`flex items-center justify-between p-2 rounded-xl border text-xs transition-colors ${
                            isRecord
                              ? 'border-emerald-500/50 bg-emerald-950/20 text-emerald-200'
                              : isCompany
                              ? 'border-cyan-500/50 bg-cyan-950/20 text-cyan-200'
                              : inLoop
                              ? 'border-cyan-500/25 bg-cyan-950/10 text-slate-200'
                              : 'border-slate-800/80 bg-slate-900/40 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className="font-mono font-bold text-[11px] text-slate-400">
                              #{idx + 1}
                            </span>
                            <span className="truncate font-medium">
                              {step.name || step.elementName || step.target?.friendlyName || step.description || step.type || 'Action'}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {isCompany && (
                              <span className="rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 px-2 py-0.5 text-[9px] font-bold">
                                Company Anchor
                              </span>
                            )}
                            {isRecord && (
                              <span className="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 text-[9px] font-bold">
                                Record Anchor
                              </span>
                            )}
                            {!isCompany && !isRecord && inLoop && (
                              <span className="rounded-full bg-cyan-500/10 text-cyan-400 px-2 py-0.5 text-[9px] font-medium">
                                🔁 Loop
                              </span>
                            )}
                            {isSetup && (
                              <span className="rounded-full bg-slate-800 text-slate-400 px-2 py-0.5 text-[9px]">
                                Setup (1x)
                              </span>
                            )}
                            {isTeardown && (
                              <span className="rounded-full bg-slate-800 text-slate-400 px-2 py-0.5 text-[9px]">
                                Teardown (1x)
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: SELECT RECORDS & FILTERS */}
            {currentStep === 3 && (
              <div className="space-y-5 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Step 3 · Scope & Record Criteria
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    Which records to process?
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Define limits, deduplication rules, and item filtering conditions.
                  </p>
                </div>

                {/* BATCH ITERATION LIMITS */}
                <div className="space-y-3 p-4 rounded-2xl border border-slate-800 bg-[#0e172a]">
                  <div className="flex items-center gap-2">
                    <Sliders className="h-4 w-4 text-cyan-400" />
                    <span className="text-xs font-bold text-white uppercase tracking-wider">
                      Batch Iteration Limits
                    </span>
                  </div>

                  {/* Max Items Limit Input */}
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-300">
                      Max Items Limit
                    </label>
                    <input
                      type="number"
                      min="1"
                      placeholder="All items (no limit)"
                      value={maxItems}
                      onChange={(e) => setMaxItems(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  {/* Process New Records Only (NEW_ONLY) Toggle */}
                  <div className="flex items-center justify-between p-3 rounded-xl border border-slate-800/80 bg-slate-900/60">
                    <div className="space-y-0.5">
                      <div className="text-xs font-bold text-white flex items-center gap-2">
                        <span>Process New Records Only (NEW_ONLY)</span>
                        <span className="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 text-[9px] font-bold uppercase">
                          Deduplication
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Skip previously processed records across runs using composite identity (recordId).
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNewOnly(!newOnly)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        newOnly ? 'bg-cyan-500' : 'bg-slate-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                          newOnly ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* ITEM FILTER RULES */}
                <div className="space-y-3 p-4 rounded-2xl border border-cyan-500/25 bg-[#101c36]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Filter className="h-4 w-4 text-cyan-400" />
                      <span className="text-xs font-bold text-white uppercase tracking-wider">
                        Item Filter Rules
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400">Row criteria filter</span>
                  </div>

                  {/* Filter Mode Selector: All Items vs Filter Items */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setFilterEnabled(false)}
                      className={`px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        !filterEnabled
                          ? 'border border-cyan-400 bg-cyan-500 text-black shadow-md'
                          : 'border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-white'
                      }`}
                    >
                      Process all items (No filter)
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterEnabled(true)}
                      className={`px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        filterEnabled
                          ? 'border border-cyan-400 bg-cyan-500 text-black shadow-md'
                          : 'border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-white'
                      }`}
                    >
                      Filter items by condition
                    </button>
                  </div>

                  {/* Conditions & Column Discovery */}
                  {filterEnabled && (
                    <div className="space-y-4 pt-2 border-t border-slate-800">
                      {/* Match Mode & Rescan Buttons */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-medium">Match Mode:</span>
                          <button
                            type="button"
                            onClick={() => setMatchMode('all')}
                            className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                              matchMode === 'all'
                                ? 'bg-cyan-500 text-black'
                                : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            ALL rules (AND)
                          </button>
                          <button
                            type="button"
                            onClick={() => setMatchMode('any')}
                            className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                              matchMode === 'any'
                                ? 'bg-cyan-500 text-black'
                                : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            ANY rule (OR)
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={handleRefreshFields}
                          disabled={scanningColumns}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800 text-cyan-400 text-xs font-medium hover:bg-slate-700 transition cursor-pointer"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${scanningColumns ? 'animate-spin' : ''}`} />
                          <span>{scanningColumns ? 'Scanning...' : 'Re-scan Columns'}</span>
                        </button>
                      </div>

                      {scanMessage && (
                        <p className="text-[11px] text-cyan-300 italic">{scanMessage}</p>
                      )}

                      {/* QUICK PICK: DISCOVERED COLUMNS PILLS */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                            <Tag className="h-3 w-3 text-cyan-400" />
                            <span>Quick Pick: Discovered Columns</span>
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {availableColumns.length} detected
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {availableColumns.map((col) => (
                            <button
                              key={col}
                              type="button"
                              onClick={() => handleSelectColumnPill(col)}
                              className={`px-2.5 py-1 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                                activeField.toLowerCase() === col.toLowerCase()
                                  ? 'bg-cyan-500 text-black font-bold shadow-[0_0_10px_rgba(6,182,212,0.4)]'
                                  : 'bg-slate-900 border border-slate-800 text-slate-300 hover:border-slate-700'
                              }`}
                            >
                              {col}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => handleSelectColumnPill('__custom__')}
                            className={`px-2.5 py-1 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                              activeField === '__custom__'
                                ? 'bg-cyan-500 text-black font-bold'
                                : 'bg-slate-900/60 border border-dashed border-slate-700 text-slate-400 hover:text-white'
                            }`}
                          >
                            Custom...
                          </button>
                        </div>
                      </div>

                      {/* DETECTED OPTIONS FOR ACTIVE FIELD */}
                      {getValuesForField(activeField).length > 0 && (
                        <div className="space-y-1.5 p-3 rounded-xl border border-slate-800/80 bg-slate-900/50">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-300">
                              Detected Options for &ldquo;{activeField}&rdquo;:
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {getValuesForField(activeField).length} option(s)
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
                            {getValuesForField(activeField).map((optVal) => (
                              <button
                                key={optVal}
                                type="button"
                                onClick={() => handleSelectValuePill(optVal)}
                                className="px-2.5 py-0.5 rounded-lg text-[11px] bg-slate-800 border border-slate-700 text-cyan-300 hover:bg-cyan-500 hover:text-black transition-colors cursor-pointer"
                              >
                                {optVal}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* DYNAMIC FILTER CONDITION BUILDER */}
                      <div className="space-y-2 pt-1">
                        <label className="block text-[11px] font-bold text-slate-300">
                          Active Filter Rules
                        </label>
                        {filterConditions.map((cond, cIdx) => (
                          <div key={cond.id} className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl border border-slate-800 bg-slate-900/70">
                            {/* Column Select */}
                            <select
                              value={cond.field}
                              onChange={(e) => handleUpdateCondition(cond.id, { field: e.target.value })}
                              className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer min-w-[120px]"
                            >
                              {availableColumns.map((col) => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                              <option value="__custom__">Custom field...</option>
                            </select>

                            {cond.field === '__custom__' && (
                              <input
                                type="text"
                                placeholder="Column name..."
                                value={cond.customField}
                                onChange={(e) => handleUpdateCondition(cond.id, { customField: e.target.value })}
                                className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-32"
                              />
                            )}

                            {/* Operator Select */}
                            <select
                              value={cond.operator}
                              onChange={(e) => handleUpdateCondition(cond.id, { operator: e.target.value as any })}
                              className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer min-w-[100px]"
                            >
                              <option value="contains">contains</option>
                              <option value="equals">equals</option>
                              <option value="dateBetween">date between</option>
                            </select>

                            {/* Value Input */}
                            {cond.operator === 'dateBetween' ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="date"
                                  value={cond.dateFrom}
                                  onChange={(e) => handleUpdateCondition(cond.id, { dateFrom: e.target.value })}
                                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-cyan-500"
                                />
                                <span className="text-slate-500 text-xs">to</span>
                                <input
                                  type="date"
                                  value={cond.dateTo}
                                  onChange={(e) => handleUpdateCondition(cond.id, { dateTo: e.target.value })}
                                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-cyan-500"
                                />
                              </div>
                            ) : (
                              <input
                                type="text"
                                placeholder="Filter value..."
                                value={cond.value}
                                onChange={(e) => handleUpdateCondition(cond.id, { value: e.target.value })}
                                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 min-w-[130px]"
                              />
                            )}

                            {/* Remove Condition */}
                            {filterConditions.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveCondition(cond.id)}
                                className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        ))}

                        <button
                          type="button"
                          onClick={handleAddCondition}
                          className="flex items-center gap-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition cursor-pointer pt-1"
                        >
                          <Plus className="h-4 w-4" />
                          <span>Add Filter Rule</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* STEP 4: REVIEW & DISPATCH */}
            {currentStep === 4 && (
              <div className="space-y-5 animate-in fade-in duration-150">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                    Step 4 · Confirmation & Dispatch
                  </span>
                  <h2 className="text-xl font-bold text-white sm:text-2xl">
                    Review execution plan
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Verify all execution settings before launching to your desktop worker.
                  </p>
                </div>

                {/* Strategy Summary Bento Card */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-2xl border border-cyan-500/25 bg-[#0e172a]">
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Execution Mode
                    </span>
                    <p className="text-sm font-bold text-white flex items-center gap-1.5">
                      {execMode === 'standard' ? (
                        <>
                          <Play className="h-4 w-4 text-cyan-400" />
                          <span>Standard Run (1x)</span>
                        </>
                      ) : isTwoLevel ? (
                        <>
                          <Repeat className="h-4 w-4 text-cyan-400" />
                          <span>Controlled Two-Level Iteration</span>
                        </>
                      ) : (
                        <>
                          <Repeat className="h-4 w-4 text-cyan-400" />
                          <span>Loop / Batch Mode</span>
                        </>
                      )}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Target Portal
                    </span>
                    <p className="text-xs font-semibold text-cyan-300 truncate">
                      {workflow.portal_url || 'Active browser tab'}
                    </p>
                  </div>

                  {execMode === 'loop' && (
                    <>
                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Repeating Step Range
                        </span>
                        <p className="text-xs font-mono font-bold text-slate-200">
                          {isTwoLevel
                            ? `Outer: #${outerStartIndex + 1}..#${outerEndIndex + 1} | Inner: #${innerStartIndex + 1}..#${innerEndIndex + 1}`
                            : `Steps #${startStepIndex + 1}..#${endStepIndex + 1} (${endStepIndex - startStepIndex + 1} repeated steps)`}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Collection Anchor
                        </span>
                        <p className="text-xs font-semibold text-slate-200 truncate">
                          {isTwoLevel
                            ? `Company #${outerAnchorIndex + 1} • Record #${innerAnchorIndex + 1}`
                            : `Step #${anchorStepIndex + 1}: ${formatStepLabel(steps[anchorStepIndex], anchorStepIndex)}`}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Deduplication
                        </span>
                        <p className="text-xs font-semibold text-slate-200">
                          {newOnly ? 'Only Process New Records (NEW_ONLY)' : 'All Records (Allow repeats)'}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Filter Criteria
                        </span>
                        <p className="text-xs font-semibold text-slate-200">
                          {filterEnabled && filterConditions.length > 0
                            ? `${filterConditions.length} rule(s) (${matchMode.toUpperCase()})`
                            : 'No filter (process all items)'}
                        </p>
                      </div>
                    </>
                  )}
                </div>

                {/* Worker Readiness Status Card */}
                <div className={`flex items-start gap-3 p-4 rounded-2xl border text-xs ${
                  isRunnerOnline
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                }`}>
                  {isRunnerOnline ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <Cpu className="h-4 w-4" />
                      <span>{isRunnerOnline ? 'Desktop Worker Online & Connected' : 'Desktop Worker Offline'}</span>
                    </div>
                    <p className="text-slate-400 mt-0.5 text-xs">
                      {isRunnerOnline
                        ? 'CDP browser automation is ready. Execution will begin immediately upon dispatch.'
                        : 'Worker is currently disconnected. Run will queue in pending state until worker reconnects.'}
                    </p>
                  </div>
                </div>

                {/* Validation Error Alert */}
                {loopValidationError && (
                  <div className="flex items-center gap-2 p-3.5 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs text-rose-300 font-semibold">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                    <span>{loopValidationError}</span>
                  </div>
                )}
                {error && (
                  <div className="flex items-center gap-2 p-3.5 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs text-rose-300 font-semibold">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            )}

            {/* BOTTOM MODAL CONTROLS */}
            <div className="flex items-center justify-between border-t border-cyan-500/15 pt-5">
              {currentStep > 1 ? (
                <button
                  type="button"
                  onClick={() => setCurrentStep((prev) => (prev - 1) as any)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-800 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition cursor-pointer"
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span>Back</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                >
                  Cancel
                </button>
              )}

              <div className="flex items-center gap-3">
                {currentStep < 4 ? (
                  <button
                    type="button"
                    onClick={() => setCurrentStep((prev) => (prev + 1) as any)}
                    className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-black text-xs font-bold hover:shadow-[0_0_20px_rgba(6,182,212,0.4)] transition cursor-pointer"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleDispatchExecution}
                    disabled={submitting || Boolean(loopValidationError)}
                    className={`flex items-center gap-2 px-7 py-3 rounded-2xl text-xs font-bold transition shadow-lg cursor-pointer ${
                      submitting || Boolean(loopValidationError)
                        ? 'opacity-50 cursor-not-allowed bg-slate-800 text-slate-400'
                        : 'bg-gradient-to-r from-cyan-400 via-cyan-500 to-blue-600 text-black hover:shadow-[0_0_28px_rgba(6,182,212,0.6)]'
                    }`}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Dispatching...</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 fill-current" />
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
