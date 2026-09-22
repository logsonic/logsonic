import { describe, expect, it } from 'vitest';

import { importGate } from '../importGate';

import type { ImportFile } from '../../types';

import { DEFAULT_SESSION_OPTIONS } from '@/stores/useImportStore';

function file(over: Partial<ImportFile> = {}): ImportFile {
  return {
    id: over.id ?? 'f1',
    fileName: over.fileName ?? 'app.log',
    fileSize: 10,
    file: null,
    nativePath: '/abs/app.log',
    previewLines: ['a'],
    approxLines: 1,
    detectedPattern: null,
    selectedPattern: { name: 'Generic', pattern: '%{GREEDYDATA:message}', description: '' },
    isCustomPattern: false,
    customPattern: null,
    customPatternTokens: {},
    detectionStatus: 'detected',
    detectionError: null,
    parsedLogs: [{ message: 'a' }],
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    totalLinesProcessed: 0,
    sessionOptions: { ...DEFAULT_SESSION_OPTIONS },
    timestampInference: null,
    timestampOverrides: {},
    timestampConfirmed: true,
    sourceMTime: null,
    ...over,
  } as ImportFile;
}

describe('importGate', () => {
  it('opens for a detected, confirmed file', () => {
    expect(importGate([file()], false)).toEqual({ disabled: false, reason: null });
  });

  it('closes while any file is still detecting', () => {
    const g = importGate([file(), file({ id: 'f2', detectionStatus: 'detecting' })], false);
    expect(g.disabled).toBe(true);
    expect(g.reason).toMatch(/1 file pending/);
  });

  it('names the file whose multiline regex is blank', () => {
    const bad = file({
      id: 'f2',
      fileName: 'trace.log',
      sessionOptions: {
        ...DEFAULT_SESSION_OPTIONS,
        multiline: { enabled: true, mode: 'header', headerPattern: '' },
      },
    });
    const g = importGate([file(), bad], false);
    expect(g.disabled).toBe(true);
    expect(g.reason).toBe('Fix the multiline regex on trace.log before importing');
  });

  it('a valid folding on one file does not gate the others', () => {
    const folded = file({
      id: 'f2',
      sessionOptions: {
        ...DEFAULT_SESSION_OPTIONS,
        multiline: { enabled: true, mode: 'header', headerPattern: '^\\d{4}' },
      },
    });
    expect(importGate([file(), folded], false).disabled).toBe(false);
  });

  it('closes on a missing pattern, then an unconfirmed timestamp', () => {
    expect(importGate([file({ selectedPattern: null })], false).reason).toMatch(/need a pattern/);
    const amb = file({
      timestampConfirmed: false,
      timestampInference: { status: 'ambiguous' } as ImportFile['timestampInference'],
    });
    expect(importGate([amb], false).reason).toMatch(/ambiguous/);
  });
});
