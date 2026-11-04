/**
 * Shared loop-signal derivation for workflows.
 *
 * Recorded workflows carry loop intent in several different places depending
 * on who produced them:
 *   - Recorder output: `workflow_definition.metadata.isLoop / .loopStepIndex /
 *     .mode` (the recorder writes `mode: 'LOOP' | 'STANDARD'`, uppercase).
 *   - Visual editor compile: top-level `isLoop / loopStepIndex / mode: 'loop'`.
 *   - Per-step flags: `role: 'LOOP'`, `isLoop`, `isLoopCandidate`,
 *     `loopMode: 'sequential_iteration'`.
 *   - Extraction steps: `EXTRACT_TABLE` / `EXTRACT_TEXT` / `LOOP_START` are
 *     always recorded *on the loop target* (a table row, list item or card),
 *     so their presence is a loop signal even when the recorder skipped its
 *     heavy loop analysis.
 *
 * Every consumer (workflow save, run dispatch, pre-flight dialog) must answer
 * "is this a loop, and which step anchors it?" the same way, so they all go
 * through this module. Keeping the derivation in one place prevents the
 * "recorded as loop, ran as single" drift that silently breaks scrapes.
 */

export type LoopMode = 'loop' | 'single';

export interface LoopConfig {
  enabled: boolean;
  anchorStepIndex: number;
  startStepIndex: number;
  endStepIndex: number;
  maxItems?: number | null;
}

export interface LoopSignals {
  isLoop: boolean;
  mode: LoopMode;
  loopStepIndex: number | null;
  loop?: LoopConfig | null;
}

/** Step `type`/`action` values that are always recorded on the loop target. */
export const LOOP_STEP_TYPES = ['EXTRACT_TABLE', 'EXTRACT_TEXT', 'LOOP_START', 'EXTRACT'] as const;

/** Reads a step's action type as an uppercase string (supports `type` and `action` keys). */
export function readStepType(step: unknown): string {
  if (!step || typeof step !== 'object') return '';
  const record = step as Record<string, unknown>;
  const raw = record.type ?? record.action;
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/** True when the step carries an explicit loop flag. */
export function isLoopFlaggedStep(step: unknown): boolean {
  if (!step || typeof step !== 'object') return false;
  const record = step as Record<string, unknown>;
  return (
    record.role === 'LOOP' ||
    record.isLoop === true ||
    record.isLoopCandidate === true ||
    record.loopMode === 'sequential_iteration'
  );
}

/** True when the step is an extraction recorded on the loop target. */
export function isExtractionStep(step: unknown): boolean {
  const type = readStepType(step);
  return (LOOP_STEP_TYPES as readonly string[]).includes(type);
}

function normalizeMode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function asIndex(value: unknown, stepCount: number): number | null {
  let num: number | null = null;
  if (typeof value === 'number' && Number.isInteger(value)) {
    num = value;
  } else if (typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value))) {
    num = Number(value);
  }
  if (num === null || num < 0) return null;
  if (stepCount > 0 && num >= stepCount) return null;
  return num;
}

/**
 * Validates a LoopConfig against workflow step bounds and business constraints.
 */
export function validateLoopConfig(loopConfig: unknown, stepCount: number): { valid: boolean; error: string | null } {
  if (!loopConfig || typeof loopConfig !== 'object') {
    return { valid: false, error: 'Loop configuration must be an object' };
  }
  const config = loopConfig as Record<string, unknown>;
  if (config.enabled === false) {
    return { valid: true, error: null };
  }
  if (config.nestedLoops && Array.isArray(config.nestedLoops) && config.nestedLoops.length > 0) {
    return { valid: false, error: 'Nested loops and multiple loop ranges are unsupported in v1.0' };
  }
  if (typeof stepCount !== 'number' || stepCount <= 0) {
    return { valid: false, error: 'Workflow must have at least one step for loop configuration' };
  }
  const start = config.startStepIndex;
  const end = config.endStepIndex;
  const anchor = config.anchorStepIndex;

  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start >= stepCount) {
    return { valid: false, error: `Invalid startStepIndex ${start}: out of bounds (must be a valid step between 0 and ${stepCount - 1})` };
  }
  if (typeof end !== 'number' || !Number.isInteger(end) || end < 0 || end >= stepCount) {
    return { valid: false, error: `Invalid endStepIndex ${end}: out of bounds (must be a valid step between 0 and ${stepCount - 1})` };
  }
  if (start > end) {
    return { valid: false, error: `startStepIndex (${start}) cannot be greater than endStepIndex (${end})` };
  }
  if (typeof anchor !== 'number' || !Number.isInteger(anchor) || anchor < 0 || anchor >= stepCount) {
    return { valid: false, error: `Invalid anchorStepIndex ${anchor}: out of bounds (must be a valid step between 0 and ${stepCount - 1})` };
  }
  if (anchor < start || anchor > end) {
    return { valid: false, error: `anchorStepIndex (${anchor}) must lie within the selected loop range [${start}..${end}] in v1.0` };
  }
  return { valid: true, error: null };
}

/**
 * Derives `{ isLoop, mode, loopStepIndex, loop }` from a workflow definition and its
 * steps. Never throws; unknown/malformed input degrades to `'single'`.
 */
export function deriveLoopSignals(definition: unknown, stepsInput?: unknown): LoopSignals {
  const def = (definition && typeof definition === 'object' ? definition : {}) as Record<string, unknown>;
  const metadata = (def.metadata && typeof def.metadata === 'object' ? def.metadata : {}) as Record<string, unknown>;
  const settings = (def.settings && typeof def.settings === 'object' ? def.settings : {}) as Record<string, unknown>;

  const steps: unknown[] = Array.isArray(stepsInput)
    ? stepsInput
    : Array.isArray(def.steps)
      ? (def.steps as unknown[])
      : Array.isArray(def.actions)
        ? (def.actions as unknown[])
        : [];

  const stepCount = steps.length;

  // Check explicit unified loop object
  const explicitLoop = (def.loop && typeof def.loop === 'object')
    ? def.loop as Record<string, unknown>
    : (metadata.loop && typeof metadata.loop === 'object' ? metadata.loop as Record<string, unknown> : null);

  if (explicitLoop) {
    if (explicitLoop.enabled === false) {
      return {
        isLoop: false,
        mode: 'single',
        loopStepIndex: null,
        loop: {
          enabled: false,
          anchorStepIndex: 0,
          startStepIndex: 0,
          endStepIndex: 0,
          maxItems: null
        }
      };
    }

    const anchorIdx = asIndex(explicitLoop.anchorStepIndex ?? explicitLoop.loopStepIndex, stepCount) ?? 0;
    const startIdx = asIndex(explicitLoop.startStepIndex, stepCount) ?? anchorIdx;
    const endIdx = asIndex(explicitLoop.endStepIndex, stepCount) ?? (stepCount > 0 ? stepCount - 1 : startIdx);
    const maxItems = typeof explicitLoop.maxItems === 'number' && Number.isInteger(explicitLoop.maxItems) && explicitLoop.maxItems > 0
      ? explicitLoop.maxItems
      : (typeof explicitLoop.loopLimit === 'number' && Number.isInteger(explicitLoop.loopLimit) && explicitLoop.loopLimit > 0 ? explicitLoop.loopLimit : null);

    const loopConfig: LoopConfig = {
      enabled: true,
      anchorStepIndex: anchorIdx,
      startStepIndex: startIdx,
      endStepIndex: Math.max(startIdx, endIdx),
      maxItems
    };

    return {
      isLoop: true,
      mode: 'loop',
      loopStepIndex: anchorIdx,
      loop: loopConfig
    };
  }

  const flaggedIndex = steps.findIndex(isLoopFlaggedStep);
  const extractionIndex = steps.findIndex(isExtractionStep);

  let candidateRowIndex: number | null = null;
  if (flaggedIndex >= 0) {
    candidateRowIndex = flaggedIndex;
  } else if (extractionIndex >= 0) {
    candidateRowIndex = extractionIndex;
  } else {
    // Check if any step represents a table row or grid cell (ignoring setup / auth)
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] as any;
      if (!s) continue;
      const name = String(s.name || s.elementName || s.target?.elementName || '').toLowerCase();
      const type = String(s.type || s.action || '').toUpperCase();
      if (type === 'NAVIGATE' || /(username|password|email|sign[-_\s]*in|login|authenticat)/i.test(name)) continue;
      const tag = String(s.target?.fingerprint?.tagName || s.fingerprint?.tagName || '').toUpperCase();
      const role = String(s.target?.fingerprint?.role || s.fingerprint?.role || '').toLowerCase();
      const candidates = Array.isArray(s.target?.candidates) ? s.target.candidates : [];
      const selStr = candidates.map((c: any) => c.value || '').join(' ');
      if (
        tag === 'TR' || tag === 'TD' || role === 'row' || role === 'gridcell' ||
        /\b(table\[\d+\]|table:nth-of-type|tbody\s*>\s*tr|tr:nth-(?:child|of-type)|\[role=["']row["']\]|\[role=["']gridcell["']\]|\.x-grid-row|\.x-grid-item|\.data-row|\.grid-row)\b/i.test(selStr) ||
        /\b(table\s*row|grid\s*row|invoice\s*row|row\s*item)\b/i.test(name)
      ) {
        candidateRowIndex = i;
        break;
      }
    }
  }

  const isLoop = Boolean(
    def.isLoop === true ||
    metadata.isLoop === true ||
    normalizeMode(def.mode) === 'loop' ||
    normalizeMode(metadata.mode) === 'loop' ||
    flaggedIndex >= 0 ||
    extractionIndex >= 0
  );

  const loopStepIndex =
    asIndex(def.loopStepIndex, stepCount) ??
    asIndex(metadata.loopStepIndex, stepCount) ??
    asIndex(settings.loopStepIndex, stepCount) ??
    candidateRowIndex;

  let derivedLoop: LoopConfig | null = null;
  if (isLoop && stepCount > 0) {
    const anchor = loopStepIndex ?? 0;
    const maxItems = asIndex(def.loopLimit, 999999) ?? asIndex(metadata.loopLimit, 999999) ?? null;
    derivedLoop = {
      enabled: true,
      anchorStepIndex: anchor,
      startStepIndex: anchor,
      endStepIndex: stepCount - 1,
      maxItems
    };
  }

  return {
    isLoop,
    mode: isLoop ? 'loop' : 'single',
    loopStepIndex: isLoop ? loopStepIndex : null,
    loop: derivedLoop
  };
}

/**
 * Normalizes loop intent onto the top level of a workflow definition before it
 * is stored: promotes recorder metadata (`metadata.isLoop/mode/loopStepIndex`)
 * and lowercases legacy uppercase modes (`'LOOP'` -> `'loop'`). The original
 * metadata object is preserved; non-loop definitions are left untouched except
 * for lowercasing a mode string.
 */
export function normalizeLoopFlags(definition: unknown): Record<string, unknown> {
  const def: Record<string, unknown> =
    definition && typeof definition === 'object' ? { ...(definition as Record<string, unknown>) } : {};

  if (typeof def.mode === 'string') def.mode = normalizeMode(def.mode);

  let metadata: Record<string, unknown> | null =
    def.metadata && typeof def.metadata === 'object' ? { ...(def.metadata as Record<string, unknown>) } : null;
  if (metadata && typeof metadata.mode === 'string') metadata.mode = normalizeMode(metadata.mode);

  const signals = deriveLoopSignals(metadata ? { ...def, metadata } : def);

  if (signals.isLoop) {
    def.isLoop = true;
    def.mode = 'loop';
    if (signals.loopStepIndex !== null) def.loopStepIndex = signals.loopStepIndex;
    if (signals.loop) def.loop = signals.loop;
  } else if (signals.loop && !signals.loop.enabled) {
    def.isLoop = false;
    def.mode = 'single';
    def.loop = signals.loop;
  }

  if (metadata) def.metadata = metadata;
  return def;
}
