'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { 
  X, 
  Layers, 
  FileCode, 
  Upload, 
  Download,
  Check, 
  AlertCircle, 
  Folder, 
  Cloud, 
  Globe, 
  Clock, 
  Loader2,
  FileCheck2,
  Info,
  Video,
  Circle,
  CheckCircle2,
  RotateCcw,
  MousePointerClick,
  Workflow as WorkflowIcon
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Workflow, CapturedAction, WorkflowRecipe } from '@/lib/types/database';

interface CreatePortalModalProps {
  isOpen: boolean;
  onClose: () => void;
  orgId: string;
  onWorkflowCreated: (newWorkflow: Workflow) => void;
  initialTab?: 'record' | 'canvas' | 'import' | 'quick';
}

type TabType = 'record' | 'canvas' | 'import' | 'quick';
type RecordingPhase = 'idle' | 'starting' | 'recording' | 'preview' | 'saving';

const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;

function consolidateFilterRulesFromRecipe(recipe: any, actions?: any[]): Record<string, unknown> {
  const existing = recipe?.filter_rules || recipe?.metadata?.filter_rules;
  if (
    existing &&
    typeof existing === 'object' &&
    ((Array.isArray(existing.available_fields) && existing.available_fields.length > 0) ||
      (Array.isArray(existing.columns) && existing.columns.length > 0) ||
      (existing.fieldValues && Object.keys(existing.fieldValues).length > 0))
  ) {
    const fields = (Array.isArray(existing.available_fields) && existing.available_fields.length > 0)
      ? existing.available_fields
      : (Array.isArray(existing.columns) && existing.columns.length > 0 ? existing.columns : Object.keys(existing.fieldValues || {}));
    return {
      available_fields: fields,
      columns: fields,
      fieldValues: existing.fieldValues || {},
      ...existing,
    };
  }

  const actList = Array.isArray(actions) && actions.length > 0
    ? actions
    : (Array.isArray(recipe?.actions) ? recipe.actions : (Array.isArray(recipe?.steps) ? recipe.steps : []));

  const fieldsSet = new Set<string>();
  const fieldValuesMap: Record<string, Set<string>> = {};

  const addField = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    let str = raw.trim();
    if (!str || str.length > 60 || str.startsWith('{') || str.startsWith('<') || EXPANDER_GLYPH_REGEX.test(str)) return null;
    str = str.replace(/^(click|select|enter|type|open|download|view|press)\s+/i, '').trim();
    if (!str || str.length > 60) return null;
    fieldsSet.add(str);
    return str;
  };

  const addVal = (f: string, v: unknown) => {
    const cf = addField(f);
    if (!cf || v == null) return;
    let s = String(v).trim().replace(/\s+/g, ' ');
    if (!s || s.length > 100 || EXPANDER_GLYPH_REGEX.test(s)) return;
    s = s.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
    s = s.replace(/[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/, '').trim();
    if (!s) return;
    if (!fieldValuesMap[cf]) fieldValuesMap[cf] = new Set();
    fieldValuesMap[cf].add(s);
  };

  actList.forEach((act: any) => {
    if (!act) return;
    if (act.context) {
      if (Array.isArray(act.context.columns)) act.context.columns.forEach(addField);
      if (act.context.table) {
        if (Array.isArray(act.context.table.headers)) act.context.table.headers.forEach(addField);
        if (act.context.table.columns) act.context.table.columns.forEach(addField);
        if (act.context.table.rowValues && typeof act.context.table.rowValues === 'object') {
          Object.entries(act.context.table.rowValues).forEach(([k, vals]) => {
            if (Array.isArray(vals)) vals.forEach((val) => addVal(k, val));
          });
        }
        if (act.context.table.activeRowValues && typeof act.context.table.activeRowValues === 'object') {
          Object.entries(act.context.table.activeRowValues).forEach(([k, val]) => addVal(k, val));
        }
      }
      if (act.context.fieldValues && typeof act.context.fieldValues === 'object') {
        Object.entries(act.context.fieldValues).forEach(([k, vals]) => {
          if (Array.isArray(vals)) vals.forEach((val) => addVal(k, val));
        });
      }
    }
    if (Array.isArray(act.columns)) act.columns.forEach(addField);
    if (act.table?.headers && Array.isArray(act.table.headers)) act.table.headers.forEach(addField);
    if (act.fieldValues && typeof act.fieldValues === 'object') {
      Object.entries(act.fieldValues).forEach(([k, vals]) => {
        if (Array.isArray(vals)) vals.forEach((val) => addVal(k, val));
      });
    }

    const targetCol = act.extract_column || act.column || act.field ||
      act.target?.fingerprint?.columnName || act.fingerprint?.columnName ||
      act.target?.fingerprint?.headerName || act.fingerprint?.headerName ||
      act.context?.table?.activeColumn ||
      (act.context?.fieldValues && Object.keys(act.context.fieldValues)[0]);

    const opts = act.options || act.selectOptions || act.context?.options;
    if (Array.isArray(opts)) {
      const col = targetCol || act.name || act.elementName || 'Type';
      opts.forEach((opt: any) => addVal(col, typeof opt === 'string' ? opt : (opt.text || opt.label || opt.value)));
    }
    if (act.value && typeof act.value === 'string' && !act.value.startsWith('{{')) {
      if (targetCol) addVal(targetCol, act.value);
      if (/SI-|INV-|DR-|TX-|CM-|\b\d{4,10}\b/i.test(act.value)) {
        addVal('Invoice Number', act.value);
      }
    }
  });

  const finalValues: Record<string, string[]> = {};
  Object.entries(fieldValuesMap).forEach(([k, vSet]) => {
    finalValues[k] = Array.from(vSet);
  });
  const fields = Array.from(fieldsSet);

  return {
    available_fields: fields,
    columns: fields,
    fieldValues: finalValues,
    ...(existing || {})
  };
}

export function CreatePortalModal({
  isOpen,
  onClose,
  orgId,
  onWorkflowCreated,
  initialTab = 'record',
}: CreatePortalModalProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [showMethodPicker, setShowMethodPicker] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Tab: Visual canvas State
  const [canvasName, setCanvasName] = useState('');
  const [canvasUrl, setCanvasUrl] = useState('');
  const [canvasTargetFolder, setCanvasTargetFolder] = useState('~/Documents/ReFlow/Invoices');
  const [canvasUploadToCloud, setCanvasUploadToCloud] = useState(true);

  // Tab: Quick Setup State
  const [quickName, setQuickName] = useState('');
  const [quickUrl, setQuickUrl] = useState('');
  const [quickSchedule, setQuickSchedule] = useState<'manual' | 'hourly' | 'daily' | 'weekly'>('daily');
  const [quickTargetFolder, setQuickTargetFolder] = useState('~/Documents/ReFlow/Invoices');
  const [quickUploadToCloud, setQuickUploadToCloud] = useState(true);

  // Tab: JSON Import State
  const [jsonText, setJsonText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab: Desktop Recording State
  const [agentConnected, setAgentConnected] = useState<boolean | null>(null);
  const [cloudRunnerOnline, setCloudRunnerOnline] = useState<boolean>(false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [recordName, setRecordName] = useState('');
  const [recordUrl, setRecordUrl] = useState('');
  const [recordSchedule, setRecordSchedule] = useState<'manual' | 'hourly' | 'daily' | 'weekly'>('daily');
  const [recordTargetFolder, setRecordTargetFolder] = useState('~/Documents/ReFlow/Invoices');
  const [recordUploadToCloud, setRecordUploadToCloud] = useState(true);
  
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>('idle');
  const [recordedActions, setRecordedActions] = useState<CapturedAction[]>([]);
  const [actionCount, setActionCount] = useState<number>(0);
  const [capturedRecipe, setCapturedRecipe] = useState<WorkflowRecipe | null>(null);

  // Synchronize activeTab when initialTab prop updates (deferred to avoid cascading render warning)
  useEffect(() => {
    if (isOpen && initialTab) {
      const timer = setTimeout(() => {
        setActiveTab(initialTab);
        setShowMethodPicker(initialTab === 'record');
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialTab]);

  // Health check callback for manual button trigger
  const checkDesktopHealth = async () => {
    try {
      setCheckingConnection(true);
      let localOk = false;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('http://127.0.0.1:49152/health', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          localOk = data.status === 'ok';
        }
      } catch {}

      setAgentConnected(localOk);

      try {
        const runnerRes = await fetch('/api/v1/runners', { cache: 'no-store' });
        if (runnerRes.ok) {
          const runnerData = await runnerRes.json();
          setCloudRunnerOnline(Boolean(runnerData.is_online));
        }
      } catch {}
    } catch {
      setAgentConnected(false);
    } finally {
      setCheckingConnection(false);
    }
  };

  // Clean reset helper for all modal & desktop recorder state
  const resetAllState = useCallback(async () => {
    setRecordedActions([]);
    setActionCount(0);
    setCapturedRecipe(null);
    setRecordName('');
    setRecordUrl('');
    setCanvasName('');
    setCanvasUrl('');
    setRecordingPhase('idle');
    setQuickName('');
    setQuickUrl('');
    setJsonText('');
    setFormError(null);
    setSubmitting(false);
  }, []);

  // When modal opens fresh, guarantee clean state from scratch (deferred to avoid synchronous setState warning)
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      if (recordingPhase !== 'recording') {
        const timer = setTimeout(() => {
          resetAllState();
        }, 0);
        return () => clearTimeout(timer);
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, recordingPhase, resetAllState]);

  // Periodic health check for desktop daemon connectivity (does NOT hijack activeTab or force preview)
  useEffect(() => {
    if (!isOpen) return;

    let isSubscribed = true;
    const probe = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('http://127.0.0.1:49152/health', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timeoutId);
        if (isSubscribed) {
          if (res.ok) {
            const data = await res.json();
            setAgentConnected(data.status === 'ok');

            // Only sync actions if recording is actively live in Chrome
            if (data.isRecording) {
              try {
                const statusRes = await fetch('http://127.0.0.1:49152/record/status');
                if (statusRes.ok) {
                  const statusData = await statusRes.json();
                  if (statusData.actions && statusData.actions.length > 0) {
                    setRecordedActions(statusData.actions);
                    setActionCount(statusData.actions.length);
                    if (statusData.name && !recordName) setRecordName(statusData.name);
                    if (statusData.url && !recordUrl) setRecordUrl(statusData.url);
                    if (statusData.recipe) setCapturedRecipe(statusData.recipe);
                    setRecordingPhase('recording');
                  }
                }
              } catch {}
            }
          } else {
            setAgentConnected(false);
          }
        }
      } catch {
        if (isSubscribed) {
          setAgentConnected(false);
          try {
            const runnerRes = await fetch('/api/v1/runners', { cache: 'no-store' });
            if (runnerRes.ok && isSubscribed) {
              const runnerData = await runnerRes.json();
              setCloudRunnerOnline(Boolean(runnerData.is_online));
            }
          } catch {}
        }
      }
    };

    probe();
    const interval = setInterval(probe, 3000);
    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, [isOpen, recordName, recordUrl]);

  // Live polling of /record/status during active recording
  useEffect(() => {
    if (recordingPhase !== 'recording') return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:49152/record/status');
        if (!res.ok) return;

        const data = await res.json();
        if (typeof data.actionCount === 'number') {
          setActionCount(data.actionCount);
        }
        if (Array.isArray(data.actions)) {
          setRecordedActions(data.actions);
          setActionCount(data.actions.length);
        }

        // If user finished in Chrome floating banner or bridge signaled completion
        if (data.completedRecording) {
          setCapturedRecipe(data.recipe || {
            metadata: {
              name: recordName || data.name || 'Recorded Workflow',
              startUrl: recordUrl || data.url || 'https://vendor-portal.com',
            },
            actions: data.actions || [],
          });
          if (data.name && !recordName) setRecordName(data.name);
          if (data.url && !recordUrl) setRecordUrl(data.url);
          setRecordingPhase('preview');
        }
      } catch (err) {
        console.warn('Status poll warning:', err);
      }
    }, 1000);

    return () => clearInterval(pollInterval);
  }, [recordingPhase, recordName, recordUrl]);

  // Clean handleClose: reset state when dismissing
  const handleClose = useCallback(async () => {
    setFormError(null);
    setSubmitting(false);
    if (recordingPhase !== 'recording') {
      await resetAllState();
    }
    onClose();
  }, [onClose, recordingPhase, resetAllState]);

  // Explicit cancel/reset recording session button handler
  const handleResetRecordingState = useCallback(async () => {
    await resetAllState();
  }, [resetAllState]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // Derive parsed metadata and parse errors during render via useMemo
  const { parsedMetadata, jsonParseError } = useMemo(() => {
    const trimmed = jsonText.trim();
    if (!trimmed) {
      return { parsedMetadata: null, jsonParseError: null };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null) {
        return {
          parsedMetadata: null,
          jsonParseError: 'JSON root must be an object.',
        };
      }

      const meta = (parsed as { metadata?: Record<string, unknown> }).metadata || {};
      const parsedRecord = parsed as Record<string, unknown>;
      const name = (meta.name as string) || (parsedRecord.name as string) || 'Imported Workflow';
      const portal_url =
        (meta.startUrl as string) ||
        (parsedRecord.portal_url as string) ||
        (parsedRecord.startUrl as string) ||
        '';

      const actions = Array.isArray(parsedRecord.actions)
        ? parsedRecord.actions
        : Array.isArray(parsedRecord.steps)
        ? parsedRecord.steps
        : [];

      const isLoop = Boolean(meta.isLoop ?? parsedRecord.isLoop ?? false);
      const mode = (meta.mode as string) || (isLoop ? 'LOOP' : 'STANDARD');
      const version = (meta.version as string) || (parsedRecord.schema_version as string) || '1.0.0';

      return {
        parsedMetadata: {
          name,
          portal_url,
          stepCount: actions.length,
          isLoop,
          mode,
          version,
        },
        jsonParseError: null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON format';
      return {
        parsedMetadata: null,
        jsonParseError: `Syntax Error: ${msg}`,
      };
    }
  }, [jsonText]);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setJsonText(content || '');
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith('.json')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setJsonText(content || '');
      };
      reader.readAsText(file);
    } else {
      setFormError('Please drop a valid .json file.');
    }
  };

  const handleCanvasSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!canvasName.trim()) {
      setFormError('Workflow name is required.');
      return;
    }

    if (!canvasUrl.trim()) {
      setFormError('Target portal URL is required.');
      return;
    }

    let normalizedUrl = canvasUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: canvasName.trim(),
        portal_url: normalizedUrl,
        workflow_definition: {
          schedule: 'manual',
          target_folder: canvasTargetFolder || '~/Documents/ReFlow/Invoices',
          upload_to_cloud: canvasUploadToCloud,
          steps: [
            {
              index: 1,
              name: 'Open Portal',
              action: 'NAVIGATE',
              type: 'navigate',
              target: '',
              url: normalizedUrl,
              value: normalizedUrl,
              timeout: 30000,
              role: 'SETUP',
              description: 'Open vendor portal URL',
            },
          ],
          drawflow: {
            Home: {
              data: {
                '1': {
                  id: 1,
                  name: 'NAVIGATE',
                  data: {
                    index: 1,
                    name: 'Open Portal',
                    action: 'NAVIGATE',
                    type: 'navigate',
                    target: '',
                    url: normalizedUrl,
                    value: normalizedUrl,
                    role: 'SETUP',
                    timeout: 30000,
                  },
                  class: 'navigate-node',
                  html: 'NAVIGATE',
                  typenode: false,
                  inputs: {},
                  outputs: {
                    output_1: { connections: [] },
                  },
                  pos_x: 100,
                  pos_y: 140,
                },
              },
            },
          },
        },
        filter_rules: {},
        upload_to_cloud: canvasUploadToCloud,
        target_folder: canvasTargetFolder || '~/Documents/ReFlow/Invoices',
      };

      const res = await fetch('/api/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        const createdWf = data.workflow;
        onWorkflowCreated(createdWf);
        await resetAllState();
        onClose();
        router.push(`/dashboard/workflows/${createdWf.id}/edit`);
        return;
      }

      // Supabase fallback
      const supabase = createClient();
      const { data: wf, error: insertError } = await supabase
        .from('wf_workflows')
        .insert({
          org_id: orgId,
          name: canvasName.trim(),
          portal_url: normalizedUrl,
          schema_version: '1.0.0',
          workflow_definition: payload.workflow_definition,
          filter_rules: {},
        })
        .select()
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      onWorkflowCreated(wf as unknown as Workflow);
      await resetAllState();
      onClose();
      router.push(`/dashboard/workflows/${wf.id}/edit`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create workflow';
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportJson = () => {
    let exportData = jsonText.trim();
    let exportFileName = `${(parsedMetadata?.name || 'reflow-recipe').toLowerCase().replace(/\s+/g, '-')}.json`;

    if (!exportData) {
      const sampleRecipe = {
        name: 'Sample ReFlow Portal Recipe',
        portal_url: 'https://example-portal.com',
        version: '1.0.0',
        metadata: {
          name: 'Sample ReFlow Portal Recipe',
          startUrl: 'https://example-portal.com',
          isLoop: false,
        },
        steps: [
          {
            index: 1,
            action: 'NAVIGATE',
            type: 'navigate',
            name: 'Open Invoices',
            value: 'https://example-portal.com/invoices',
            target: '',
            role: 'SETUP',
          },
          {
            index: 2,
            action: 'CLICK',
            type: 'click',
            name: 'Download Latest Statement',
            target: '#btn-download-pdf',
            role: 'LOOP',
          },
        ],
      };
      exportData = JSON.stringify(sampleRecipe, null, 2);
      exportFileName = 'reflow-sample-recipe.json';
    }

    const blob = new Blob([exportData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!quickName.trim()) {
      setFormError('Portal name is required.');
      return;
    }

    if (!quickUrl.trim()) {
      setFormError('Target portal URL is required.');
      return;
    }

    let normalizedUrl = quickUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: quickName.trim(),
        portal_url: normalizedUrl,
        workflow_definition: {
          schedule: quickSchedule,
          target_folder: quickTargetFolder,
          upload_to_cloud: quickUploadToCloud,
          steps: [
            {
              type: 'navigate',
              url: normalizedUrl,
              description: 'Open vendor portal URL',
            },
          ],
        },
        filter_rules: {},
        upload_to_cloud: quickUploadToCloud,
        target_folder: quickTargetFolder,
      };

      // Try API route first
      const res = await fetch('/api/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        onWorkflowCreated(data.workflow);
        handleClose();
        return;
      }

      // Fallback: direct Supabase insert
      const supabase = createClient();
      const { data: wf, error: insertError } = await supabase
        .from('wf_workflows')
        .insert({
          org_id: orgId,
          name: quickName.trim(),
          portal_url: normalizedUrl,
          schema_version: '1.0.0',
          workflow_definition: payload.workflow_definition,
          filter_rules: {},
        })
        .select()
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      onWorkflowCreated(wf as unknown as Workflow);
      handleClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create portal';
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!parsedMetadata) {
      setFormError('Please provide valid workflow JSON before importing.');
      return;
    }

    if (!parsedMetadata.portal_url) {
      setFormError('Recorded workflow must contain a startUrl or portal_url.');
      return;
    }

    setSubmitting(true);
    try {
      const rawJson = JSON.parse(jsonText);
      const importedFilterRules = consolidateFilterRulesFromRecipe(rawJson, rawJson.actions || rawJson.steps || []);
      const payload = {
        name: parsedMetadata.name,
        portal_url: parsedMetadata.portal_url,
        workflow_definition: {
          ...rawJson,
          filter_rules: importedFilterRules,
          upload_to_cloud: quickUploadToCloud,
          target_folder: quickTargetFolder,
        },
        filter_rules: importedFilterRules,
        upload_to_cloud: quickUploadToCloud,
        target_folder: quickTargetFolder,
      };

      const res = await fetch('/api/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        onWorkflowCreated(data.workflow);
        handleClose();
        return;
      }

      // Fallback: direct Supabase insert
      const supabase = createClient();
      const { data: wf, error: insertError } = await supabase
        .from('wf_workflows')
        .insert({
          org_id: orgId,
          name: parsedMetadata.name,
          portal_url: parsedMetadata.portal_url,
          schema_version: parsedMetadata.version || '1.0.0',
          workflow_definition: payload.workflow_definition,
          filter_rules: importedFilterRules,
        })
        .select()
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      onWorkflowCreated(wf as unknown as Workflow);
      handleClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to import workflow JSON';
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // Tab 3: Desktop Recording Handlers
  const handleStartRecording = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setFormError(null);

    const rawUrl = recordUrl.trim();
    if (!rawUrl) {
      setFormError('Please enter a Website URL to record.');
      return;
    }

    let normalizedUrl = rawUrl;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let finalName = recordName.trim();
    if (!finalName) {
      try {
        const parsed = new URL(normalizedUrl);
        const host = parsed.hostname.replace(/^www\./, '');
        finalName = `${host.charAt(0).toUpperCase() + host.slice(1)} Workflow`;
      } catch {
        finalName = 'Recorded Workflow';
      }
      setRecordName(finalName);
    }

    setRecordingPhase('starting');
    let localStarted = false;

    // Try local 127.0.0.1 bridge first
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:49152/record/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: finalName,
          url: normalizedUrl,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        localStarted = true;
        setRecordedActions([]);
        setActionCount(0);
        setCapturedRecipe(null);
        setRecordingPhase('recording');
      }
    } catch {}

    // If local bridge fetch was blocked by browser security (e.g. Mixed Content), launch via desktop protocol
    if (!localStarted) {
      const deepLink = `reflow://record?url=${encodeURIComponent(normalizedUrl)}&name=${encodeURIComponent(finalName)}`;
      try {
        window.location.href = deepLink;
        setRecordedActions([]);
        setActionCount(0);
        setCapturedRecipe(null);
        setRecordingPhase('recording');
      } catch (err: unknown) {
        const msg = cloudRunnerOnline
          ? "Please click 'Record Workflow' directly in your ReFlow Desktop app window to start recording."
          : (err instanceof Error ? err.message : 'Could not reach desktop recording agent');
        setFormError(msg);
        setRecordingPhase('idle');
      }
    }
  };

  const handleStopRecording = async () => {
    try {
      const res = await fetch('http://127.0.0.1:49152/record/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok) {
        const data = await res.json();
        const recipe = data.recipe || (data.summary ? {
          metadata: { name: recordName, startUrl: recordUrl },
          actions: recordedActions,
        } : null);

        if (recipe) {
          setCapturedRecipe(recipe);
          if (Array.isArray(recipe.actions)) {
            setRecordedActions(recipe.actions);
            setActionCount(recipe.actions.length);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to stop recording cleanly:', err);
    } finally {
      setRecordingPhase('preview');
    }
  };

  const handleCancelRecording = async () => {
    try {
      await fetch('http://127.0.0.1:49152/record/stop', { method: 'POST' });
    } catch {}
    setRecordedActions([]);
    setActionCount(0);
    setCapturedRecipe(null);
    setRecordingPhase('idle');
  };

  const handleSaveRecordedPortal = async () => {
    setRecordingPhase('saving');
    setFormError(null);

    let normalizedUrl = recordUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    const finalRecipe = capturedRecipe || {
      metadata: {
        name: recordName.trim(),
        startUrl: normalizedUrl,
        version: '1.0.0',
        isLoop: false,
        mode: 'STANDARD',
      },
      actions: recordedActions,
      steps: recordedActions,
    };

    const consolidatedFilterRules = consolidateFilterRulesFromRecipe(finalRecipe, recordedActions);

    const payload = {
      name: recordName.trim(),
      portal_url: normalizedUrl,
      workflow_definition: {
        ...finalRecipe,
        filter_rules: consolidatedFilterRules,
        schedule: recordSchedule,
        target_folder: recordTargetFolder,
        upload_to_cloud: recordUploadToCloud,
        steps: recordedActions.length > 0 ? recordedActions : [
          { type: 'navigate', url: normalizedUrl, description: 'Open vendor portal URL' },
        ],
      },
      filter_rules: consolidatedFilterRules,
      upload_to_cloud: recordUploadToCloud,
      target_folder: recordTargetFolder,
    };

    try {
      const res = await fetch('/api/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        onWorkflowCreated(data.workflow);
        await resetAllState();
        onClose();
        return;
      }

      // Direct Supabase fallback
      const supabase = createClient();
      const { data: wf, error: insertError } = await supabase
        .from('wf_workflows')
        .insert({
          org_id: orgId,
          name: recordName.trim(),
          portal_url: normalizedUrl,
          schema_version: finalRecipe.metadata?.version || '1.0.0',
          workflow_definition: payload.workflow_definition,
          filter_rules: consolidatedFilterRules,
        })
        .select()
        .single();

      if (insertError) throw new Error(insertError.message);

      onWorkflowCreated(wf as unknown as Workflow);
      await resetAllState();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save workflow';
      setFormError(msg);
      setRecordingPhase('preview');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-2 sm:p-4 md:p-6"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={() => {
          if (recordingPhase === 'recording') return; // Do not dismiss while recording
          handleClose();
        }}
        aria-hidden="true"
      />

      {/* Modal Dialog Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[calc(100dvh-1rem)] w-full max-w-[690px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#0e1625] shadow-2xl transition-all sm:max-h-[calc(100dvh-2rem)]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-blue-400 border border-blue-500/30">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <h2 id="modal-title" className="text-base font-semibold text-white">
                Create a workflow
              </h2>
              <p className="text-xs text-slate-400">
                {showMethodPicker ? 'Choose how you want to build your automation.' : 'Configure the essentials. You can change optional settings anytime.'}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            aria-label="Close dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Two-step progress indicator */}
        <div className="flex shrink-0 items-center gap-2.5 px-4 pt-3 sm:px-6">
          <div className={`flex items-center gap-2 text-[11px] ${showMethodPicker ? 'text-blue-100' : 'text-blue-300'}`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full border text-[10px] font-bold ${showMethodPicker ? 'border-blue-500 bg-blue-600 text-white' : 'border-blue-500/60 bg-blue-950 text-blue-300'}`}>{showMethodPicker ? '1' : '✓'}</span>
            <span>Choose method</span>
          </div>
          <span className="h-px w-10 bg-slate-700" />
          <div className={`flex items-center gap-2 text-[11px] ${showMethodPicker ? 'text-slate-500' : 'text-blue-100'}`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full border text-[10px] font-bold ${showMethodPicker ? 'border-slate-700 text-slate-500' : 'border-blue-500 bg-blue-600 text-white'}`}>2</span>
            <span>Workflow details</span>
          </div>
        </div>

        {showMethodPicker && (
          <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
            <div className="mb-5">
              <div className="mb-1 flex items-center justify-between gap-3"><h3 className="text-base font-semibold text-slate-100 sm:text-lg">How would you like to start?</h3><span className="shrink-0 text-[11px] text-slate-500">Step 1 of 2</span></div>
              <p className="mt-1.5 text-sm leading-5 text-slate-400">Choose an approach. You can adjust the details later.</p>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {([
                { id: 'record', title: 'Record a browser task', description: 'Perform the task in your browser while ReFlow records your actions.', icon: Video },
                { id: 'canvas', title: 'Build visually', description: 'Create a workflow step by step using the visual editor.', icon: WorkflowIcon },
                { id: 'quick', title: 'Quick setup', description: 'Set up a workflow using a few basic details and preferences.', icon: Layers },
                { id: 'import', title: 'Import workflow', description: 'Bring an existing ReFlow workflow JSON file into your workspace.', icon: FileCode },
              ] as const).map((method) => {
                const MethodIcon = method.icon;
                const selected = activeTab === method.id;
                return (
                  <button key={method.id} type="button" onClick={() => setActiveTab(method.id)} className={`relative flex min-h-[112px] w-full items-start gap-3 rounded-xl border p-3.5 text-left transition sm:min-h-[126px] sm:p-4 ${selected ? 'border-blue-500/80 bg-blue-500/[0.07]' : 'border-slate-800 bg-slate-950/30 hover:border-slate-700 hover:bg-slate-800/50'}`}>
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-blue-500/10 text-blue-300' : 'bg-slate-800 text-slate-300'}`}><MethodIcon className="h-5 w-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 pr-5 text-sm font-semibold text-slate-100">{method.title}</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-400">{method.description}</span>
                    </span>
                    <span className={`absolute right-3 top-3 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-blue-400 bg-blue-400 text-slate-950' : 'border-slate-600 text-transparent'}`}><Check className="h-3 w-3" /></span>
                  </button>
                );
              })}
            </div>
            <div className="sticky bottom-0 mt-5 flex flex-col gap-3 border-t border-slate-800 bg-slate-900/95 pt-4 sm:flex-row sm:items-center sm:gap-2 sm:pt-5">
              <div className="flex items-start gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><p className="flex-1 text-xs leading-5 text-slate-400">You can adjust advanced settings later. Start with the option that best matches how you want to build.</p></div>
              <button type="button" onClick={() => { setFormError(null); setShowMethodPicker(false); }} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 sm:ml-auto sm:w-auto sm:shrink-0">Continue <span aria-hidden="true">→</span></button>
            </div>
          </div>
        )}

        {!showMethodPicker && <>
        {/* Back to method picker */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/30 px-4 py-3 sm:px-6">
          <button type="button" onClick={() => { setFormError(null); setShowMethodPicker(true); }} className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 transition hover:text-white"><span aria-hidden="true">←</span> Back</button>
          <span className="text-right text-[11px] text-slate-400 sm:text-xs">Step 2 of 2 <span className="text-slate-600">·</span> Workflow details</span>
        </div>
        {/* Tab switcher */}
        <div className="hidden shrink-0 border-b border-slate-800 bg-slate-950/40 px-6 pt-3">
          <button
            type="button"
            onClick={() => {
              setActiveTab('record');
              setFormError(null);
            }}
            className={`flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
              activeTab === 'record'
                ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300'
                : 'border-transparent text-slate-200 hover:bg-slate-800/70 hover:text-white'
            }`}
          >
            <Video className="h-4 w-4" />
            Record in Chrome
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('canvas');
              setFormError(null);
            }}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
              activeTab === 'canvas'
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-slate-500 hover:text-slate-200'
            }`}
          >
            <WorkflowIcon className="h-4 w-4" />
            Visual Canvas Builder
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('import');
              setFormError(null);
            }}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
              activeTab === 'import'
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-slate-500 hover:text-slate-200'
            }`}
          >
            <FileCode className="h-4 w-4" />
            Import JSON
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('quick');
              setFormError(null);
            }}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
              activeTab === 'quick'
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-slate-500 hover:text-slate-200'
            }`}
          >
            <Layers className="h-4 w-4" />
            Quick setup
          </button>
        </div>

        {/* Form Body */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <div className="mb-5">
            <h3 className="text-lg font-semibold text-slate-100">
              {activeTab === 'record' ? 'Name your workflow' : activeTab === 'canvas' ? 'Set up your workflow' : activeTab === 'quick' ? 'A few details to get started' : 'Import an existing workflow'}
            </h3>
            <p className="mt-1 text-sm leading-5 text-slate-400">
              {activeTab === 'record'
                ? 'Give it a name and choose the website you want ReFlow to record.'
                : activeTab === 'canvas'
                  ? 'Start with a name and website. You’ll add steps in the visual editor.'
                  : activeTab === 'quick'
                    ? 'Add the basics now. You can adjust the schedule and other settings below.'
                    : 'Choose a workflow file or paste its JSON. ReFlow will validate it before importing.'}
            </p>
          </div>
          {formError && (
            <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{formError}</span>
            </div>
          )}

          {/* Visual Canvas Builder Mode */}
          {activeTab === 'canvas' && (
            <form onSubmit={handleCanvasSubmit} className="space-y-4">
              {/* Workflow Name */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Workflow name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={canvasName}
                  onChange={(e) => setCanvasName(e.target.value)}
                  placeholder="e.g. Pacific Gas & Electric Invoice Capture"
                  className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition"
                />
              </div>

              {/* Target Portal URL */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Website URL <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Globe className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="url"
                    required
                    value={canvasUrl}
                    onChange={(e) => setCanvasUrl(e.target.value)}
                    placeholder="https://customerportal.vendor.com/invoices"
                    className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition"
                  />
                </div>
              </div>

              <details className="group rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <summary className="cursor-pointer list-none text-sm font-medium text-slate-200 marker:hidden">Optional settings <span className="float-right text-slate-500 transition group-open:rotate-180">⌄</span></summary>
                <div className="mt-4 space-y-4">
              {/* Destination Folder */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Local Download Folder
                </label>
                <div className="relative">
                  <Folder className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="text"
                    value={canvasTargetFolder}
                    onChange={(e) => setCanvasTargetFolder(e.target.value)}
                    placeholder="~/Documents/ReFlow/Invoices or C:\ReFlow\Invoices"
                    className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition"
                  />
                </div>
              </div>

              {/* Hybrid Cloud Storage */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <label className="flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20">
                      <Cloud className="h-4 w-4" />
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-white">Hybrid Cloud Storage Sync</span>
                      <p className="text-[11px] text-slate-400">
                        Upload downloaded files to Supabase Storage for direct dashboard access
                      </p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={canvasUploadToCloud}
                    onChange={(e) => setCanvasUploadToCloud(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-600 cursor-pointer"
                  />
                </label>
              </div>

                </div>
              </details>

              {/* Submit Buttons */}
              <div className="sticky bottom-0 z-10 flex flex-col-reverse items-stretch gap-2 border-t border-slate-800 bg-slate-900/95 pt-4 pb-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !canvasName.trim() || !canvasUrl.trim()}
                  className="inline-flex items-center gap-2 w-full justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-blue-500 disabled:opacity-50 cursor-pointer sm:w-auto"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating &amp; Opening Canvas...
                    </>
                  ) : (
                    <>
                      <WorkflowIcon className="h-3.5 w-3.5" /> Open visual editor
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {activeTab === 'quick' && (
            <form onSubmit={handleQuickSubmit} className="space-y-4">
              {/* Portal Name */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Workflow name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  placeholder="e.g. US Oil (iRely Portal) or Pacific Gas & Electric"
                  className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition"
                />
              </div>

              {/* Target URL */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Website URL <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Globe className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="url"
                    required
                    value={quickUrl}
                    onChange={(e) => setQuickUrl(e.target.value)}
                    placeholder="https://customerportal.vendor.com/invoices"
                    className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition"
                  />
                </div>
              </div>

              <details className="group rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <summary className="cursor-pointer list-none text-sm font-medium text-slate-200 marker:hidden">Optional settings <span className="float-right text-slate-500 transition group-open:rotate-180">⌄</span></summary>
                <div className="mt-4 space-y-4">
              {/* Schedule and Trigger dropdown */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Schedule / Execution Trigger
                </label>
                <div className="relative">
                  <Clock className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <select
                    value={quickSchedule}
                    onChange={(e) => setQuickSchedule(e.target.value as 'manual' | 'hourly' | 'daily' | 'weekly')}
                    className="w-full appearance-none rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-sm text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition cursor-pointer"
                  >
                    <option value="daily">Daily Automatic Sync (9:00 AM Local)</option>
                    <option value="hourly">Hourly Polling</option>
                    <option value="weekly">Weekly Sync (Mondays)</option>
                    <option value="manual">Manual / On-Demand Only</option>
                  </select>
                </div>
              </div>

              {/* Local Download Path */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Local Download Path (Target Folder)
                </label>
                <div className="relative">
                  <Folder className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="text"
                    value={quickTargetFolder}
                    onChange={(e) => setQuickTargetFolder(e.target.value)}
                    placeholder="~/Documents/ReFlow/Invoices or C:\ReFlow\Invoices"
                    className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition"
                  />
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Desktop Runner daemon saves downloaded PDF invoices directly to this folder on the runner host.
                </p>
              </div>

              {/* Hybrid Storage Toggle */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <label className="flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20">
                      <Cloud className="h-4 w-4" />
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-white">Hybrid Cloud Storage Sync</span>
                      <p className="text-[11px] text-slate-400">
                        Automatically register SHA-256 hashes and mirror downloaded files into Supabase Storage
                      </p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={quickUploadToCloud}
                    onChange={(e) => setQuickUploadToCloud(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-slate-900 cursor-pointer"
                  />
                </label>
              </div>

                </div>
              </details>

              {/* Submit Buttons */}
              <div className="sticky bottom-0 z-10 flex flex-col-reverse items-stretch gap-2 border-t border-slate-800 bg-slate-900/95 pt-4 pb-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 w-full justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-blue-500 disabled:opacity-50 transition cursor-pointer sm:w-auto"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving Portal...
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" /> Create workflow
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {activeTab === 'import' && (
            <form onSubmit={handleImportSubmit} className="space-y-4">
              {/* Drag and Drop Box */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition ${
                  isDragging
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-700 hover:border-slate-600 bg-slate-950/40'
                }`}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".json,application/json"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/10 text-blue-400 border border-blue-500/20 mb-3">
                  <Upload className="h-6 w-6" />
                </div>
                <div className="text-xs font-semibold text-white">
                  Drop a workflow file here, or{' '}
                  <span className="text-blue-400 underline">browse</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Supports ReFlow workflow JSON files
                </div>
              </div>

              <details className="group rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <summary className="cursor-pointer list-none text-sm font-medium text-slate-200">Advanced: paste workflow JSON <span className="float-right text-slate-500 transition group-open:rotate-180">⌄</span></summary>
                <div className="mt-4">
              {/* Paste JSON Textarea */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Or Paste Recorded Workflow JSON Directly:
                </label>
                <textarea
                  rows={6}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={`{\n  "metadata": {\n    "name": "US Oil Portal Export",\n    "startUrl": "https://customerportal.usoil.com/#/home",\n    "isLoop": false\n  },\n  "actions": [ ... ]\n}`}
                  className="w-full font-mono text-xs rounded-xl border border-slate-700/80 bg-slate-950/70 p-3 text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition"
                />
                </div>
                </div>
              </details>

              {jsonParseError && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                  <span>{jsonParseError}</span>
                </div>
              )}

              {/* Metadata Preview Card */}
              {parsedMetadata && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                    <FileCheck2 className="h-4 w-4" />
                    <span>Workflow Schema Validated</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-slate-400 block text-[11px]">Workflow Name:</span>
                      <span className="font-semibold text-white">{parsedMetadata.name}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Start URL:</span>
                      <span className="font-mono text-slate-200 truncate block">
                        {parsedMetadata.portal_url || 'N/A'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Recorded Actions:</span>
                      <span className="font-semibold text-white">{parsedMetadata.stepCount} steps</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Execution Mode:</span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                        {parsedMetadata.mode}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <details className="group rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <summary className="cursor-pointer list-none text-sm font-medium text-slate-200">Optional settings <span className="float-right text-slate-500 transition group-open:rotate-180">⌄</span></summary>
                <div className="mt-4">
              {/* Hybrid storage config for imported workflow */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                  <Info className="h-3.5 w-3.5 text-blue-400" />
                  <span>Execution Preferences</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Local Download Folder</label>
                    <input
                      type="text"
                      value={quickTargetFolder}
                      onChange={(e) => setQuickTargetFolder(e.target.value)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div className="flex items-center pt-4">
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={quickUploadToCloud}
                        onChange={(e) => setQuickUploadToCloud(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-blue-600 cursor-pointer"
                      />
                      <span>Sync to Cloud Storage</span>
                    </label>
                  </div>
                </div>
                </div>
                </div>
              </details>

              {/* Submit Buttons */}
              <div className="sticky bottom-0 z-10 flex flex-col-reverse items-stretch justify-between gap-2 border-t border-slate-800 bg-slate-900/95 pt-4 pb-1 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportJson}
                    className="text-xs text-slate-500 transition hover:text-slate-300"
                    title="Export or download recipe JSON"
                  >
                    Export example JSON
                  </button>
                </div>
                <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || !parsedMetadata}
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-semibold text-white shadow-md hover:bg-blue-500 disabled:opacity-50 transition cursor-pointer"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing Workflow...
                      </>
                    ) : (
                      <>
                        <Upload className="h-3.5 w-3.5" /> Import workflow
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          )}

          {activeTab === 'record' && (
            <div className="space-y-4">
              {/* Agent Connection Indicator */}
              <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="flex items-center gap-2.5">
                  {agentConnected === true ? (
                    <>
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                      </span>
                      <span className="text-xs font-semibold text-emerald-400">
                        🟢 Desktop Agent Connected
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">(127.0.0.1:49152)</span>
                    </>
                  ) : cloudRunnerOnline === true ? (
                    <>
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                      </span>
                      <span className="text-xs font-semibold text-emerald-400">
                        🟢 Desktop App Online
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono">(Cloud Paired)</span>
                    </>
                  ) : (
                    <>
                      <span className="h-2.5 w-2.5 rounded-full bg-slate-500"></span>
                      <span className="text-xs font-semibold text-slate-400">
                        ⚪ Desktop Agent Offline
                      </span>
                      <span className="text-[11px] text-slate-500">
                        (Launch Desktop App on this PC)
                      </span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={checkDesktopHealth}
                  disabled={checkingConnection}
                  className="flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 underline cursor-pointer disabled:opacity-50"
                >
                  {checkingConnection ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Checking...
                    </>
                  ) : (
                    'Check Connection'
                  )}
                </button>
              </div>

              {cloudRunnerOnline && !agentConnected && (
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-300 flex items-start gap-2.5">
                  <Info className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1.5 flex-1">
                    <p className="font-medium text-white">Your desktop worker is connected & active!</p>
                    <p className="text-slate-300">
                      Enter your portal URL below and click <strong>Start recording</strong> to automatically launch Chrome and capture your workflow.
                    </p>
                  </div>
                </div>
              )}

              {/* Phase 1: Pre-Recording Configuration */}
              {recordingPhase === 'idle' && (
                <form onSubmit={handleStartRecording} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Workflow name <span className="text-slate-500 text-[11px] font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={recordName}
                      onChange={(e) => setRecordName(e.target.value)}
                      placeholder="e.g. US Oil Invoice Capture (auto-generated if empty)"
                      className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Website URL <span className="text-rose-400">*</span>
                    </label>
                    <div className="relative">
                      <Globe className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                      <input
                        type="url"
                        required
                        value={recordUrl}
                        onChange={(e) => setRecordUrl(e.target.value)}
                        placeholder="https://customerportal.vendor.com"
                        className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition"
                      />
                    </div>
                  </div>

                  <div className="flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3.5">
                    <Globe className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                    <p className="text-xs leading-5 text-slate-400">ReFlow will open a browser when you’re ready to record.</p>
                  </div>

                  <details className="group rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                    <summary className="cursor-pointer list-none text-sm font-medium text-slate-200 marker:hidden">Optional settings <span className="float-right text-slate-500 transition group-open:rotate-180">⌄</span></summary>
                    <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">Schedule</label>
                      <div className="relative">
                        <Clock className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                        <select
                          value={recordSchedule}
                          onChange={(e) => setRecordSchedule(e.target.value as 'manual' | 'hourly' | 'daily' | 'weekly')}
                          className="w-full appearance-none rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-xs text-white focus:border-blue-500 focus:outline-none transition cursor-pointer"
                        >
                          <option value="daily">Daily Sync (9:00 AM)</option>
                          <option value="hourly">Hourly Polling</option>
                          <option value="weekly">Weekly Sync</option>
                          <option value="manual">Manual Only</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">Local Destination Folder</label>
                      <div className="relative">
                        <Folder className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                        <input
                          type="text"
                          value={recordTargetFolder}
                          onChange={(e) => setRecordTargetFolder(e.target.value)}
                          className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 pl-10 pr-3.5 py-2.5 text-xs font-mono text-white focus:border-blue-500 focus:outline-none transition"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                    <label className="flex items-center justify-between cursor-pointer">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20">
                          <Cloud className="h-4 w-4" />
                        </div>
                        <div>
                          <span className="text-xs font-semibold text-white">Hybrid Cloud Storage Sync</span>
                          <p className="text-[11px] text-slate-400">
                            Mirror captured workflow runs and artifacts into cloud storage
                          </p>
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={recordUploadToCloud}
                        onChange={(e) => setRecordUploadToCloud(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-slate-900 cursor-pointer"
                      />
                    </label>
                  </div>

                    </div>
                  </details>

                  <div className="sticky bottom-0 z-10 flex flex-col-reverse items-stretch gap-2 border-t border-slate-800 bg-slate-900/95 pt-4 pb-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                    <button type="button" onClick={handleClose} className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer">
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!agentConnected && !cloudRunnerOnline}
                      className="inline-flex items-center gap-2 w-full justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-blue-500 disabled:opacity-40 cursor-pointer sm:w-auto"
                    >
                      <Circle className="h-3 w-3 fill-current text-white animate-pulse" /> Start recording
                    </button>
                  </div>
                </form>
              )}

              {/* Phase 2: Active Recording */}
              {(recordingPhase === 'starting' || recordingPhase === 'recording') && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-950/10 p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-rose-400 font-semibold text-sm">
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500"></span>
                      </span>
                      <span>Recording Active in Chrome</span>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-bold">
                      ⚡ {actionCount} {actionCount === 1 ? 'Action' : 'Actions'} Captured
                    </div>
                  </div>

                  <p className="text-xs text-slate-300">
                    Chrome has been launched on port 9222. Interact with <strong className="text-white">{recordUrl}</strong> to record your workflow. Clicks, inputs, and navigations are captured automatically.
                  </p>

                  {/* Live Mini Action Stream */}
                  {recordedActions.length > 0 && (
                    <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 max-h-36 overflow-y-auto space-y-1.5 text-xs">
                      {recordedActions.slice(-4).map((a, i) => (
                        <div key={i} className="flex items-center gap-2 text-slate-300">
                          <MousePointerClick className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                          <span className="font-semibold text-rose-300 text-[11px]">{a.type}</span>
                          <span className="truncate">{a.elementName || a.name || 'Element'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="sticky bottom-0 z-10 flex flex-col-reverse items-stretch justify-between gap-2 border-t border-slate-800 bg-slate-900/95 pt-4 pb-1 sm:flex-row sm:items-center sm:gap-3">
                    <button
                      type="button"
                      onClick={handleResetRecordingState}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition cursor-pointer"
                      title="Reset recording session on agent"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Reset Session
                    </button>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleCancelRecording}
                        className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleStopRecording}
                        className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-xs font-semibold text-white shadow-md transition cursor-pointer"
                      >
                        <Check className="h-4 w-4" /> Finish Recording &amp; Review Steps
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Phase 3: Step Preview & Confirmation */}
              {(recordingPhase === 'preview' || recordingPhase === 'saving') && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Step Preview & Confirm</span>
                      </div>
                      <span className="px-2.5 py-0.5 rounded text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        {recordedActions.length} Recorded Steps
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
                      <div><span className="text-slate-400 text-[11px]">Workflow Name:</span> <strong className="text-white block">{recordName}</strong></div>
                      <div><span className="text-slate-400 text-[11px]">Start URL:</span> <span className="font-mono truncate block text-slate-200">{recordUrl}</span></div>
                    </div>
                  </div>

                  {/* Scrollable list of recorded steps */}
                  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 space-y-2 max-h-52 overflow-y-auto">
                    {recordedActions.length === 0 ? (
                      <p className="text-xs text-slate-400 italic py-2 text-center">No actions were captured during this session.</p>
                    ) : (
                      recordedActions.map((action, idx) => (
                        <div key={action.id || idx} className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-900/60 p-2 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-[10px] text-slate-500">#{idx + 1}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              action.type === 'CLICK' ? 'bg-blue-500/20 text-blue-300' :
                              action.type === 'INPUT' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700/40 text-slate-300'
                            }`}>
                              {action.type}
                            </span>
                            <span className="truncate text-slate-200 font-medium">{action.elementName || action.name || 'Element'}</span>
                          </div>
                          {action.value && (
                            <span className="text-[11px] font-mono text-slate-400 truncate max-w-[150px]">
                              val: {String(action.value)}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  <div className="sticky bottom-0 z-10 flex flex-col-reverse items-stretch gap-2 border-t border-slate-800 bg-slate-900/95 pt-4 pb-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                    <button
                      type="button"
                      onClick={handleResetRecordingState}
                      disabled={recordingPhase === 'saving'}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Re-Record
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveRecordedPortal}
                      disabled={recordingPhase === 'saving'}
                      className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-xs font-semibold text-white shadow-md transition disabled:opacity-50 cursor-pointer"
                    >
                      {recordingPhase === 'saving' ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving Workflow...
                        </>
                      ) : (
                        <>
                          <Check className="h-3.5 w-3.5" /> Save Portal Workflow
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        </>}
      </div>
    </div>
  );
}
