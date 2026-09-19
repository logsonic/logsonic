import { useCallback, useEffect } from 'react';

import { useToast } from '@/hooks/use-toast';
import { useImportStore } from '@/stores/useImportStore';

export const ACCEPTED_TYPES = ['.log', '.txt', '.json'];
export const ACCEPTED_MIME = ['text/plain', 'application/json'];
export const ACCEPT_ATTR = '.log,.txt,.json,text/plain,application/json';
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB; import itself remains chunked

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot).toLowerCase() : '';
}

export function isAcceptedFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  return ACCEPTED_TYPES.includes(ext) || ACCEPTED_MIME.includes(file.type);
}

// Validate a batch of browser Files against the already-added list.
// Returns the files to add and one message per rejected file. Duplicate
// names are dropped silently (the handoff's "just doesn't appear twice").
export function partitionFiles(
  selected: File[],
  existingNames: Set<string>
): { valid: File[]; errors: string[] } {
  const errors: string[] = [];
  const valid: File[] = [];
  const seen = new Set(existingNames);
  for (const file of selected) {
    if (!isAcceptedFile(file)) {
      errors.push(`"${file.name}" is not a supported file type (.log, .txt, .json)`);
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.push(`"${file.name}" exceeds the 5 GiB size limit`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`"${file.name}" is empty`);
      continue;
    }
    if (seen.has(file.name)) continue;
    seen.add(file.name);
    valid.push(file);
  }
  return { valid, errors };
}

/**
 * The one place files enter the import surface: browser Files (picker or
 * drop) and native absolute paths handed over by the macOS shell (spec
 * now-08: `window.__logsonicPendingNativeFiles` at mount and the
 * `logsonic-native-files` CustomEvent afterwards -- paths, never bytes).
 * Rejections surface as a toast; detection starts on its own once the
 * store has the file (see useFileDetection).
 */
export function useFileIntake() {
  const { toast } = useToast();
  const addFiles = useImportStore((s) => s.addFiles);
  const addNativePathFiles = useImportStore((s) => s.addNativePathFiles);
  const setImportSource = useImportStore((s) => s.setImportSource);

  const report = useCallback(
    (errors: string[]) => {
      if (errors.length === 0) return;
      toast({
        title: errors.length === 1 ? 'File skipped' : `${errors.length} files skipped`,
        description: errors.join('\n'),
        variant: 'destructive',
      });
    },
    [toast]
  );

  const addBrowserFiles = useCallback(
    (selected: File[]) => {
      const existing = new Set(useImportStore.getState().files.map((f) => f.fileName));
      const { valid, errors } = partitionFiles(selected, existing);
      report(errors);
      if (valid.length === 0) return;
      setImportSource('file');
      addFiles(valid);
    },
    [addFiles, report, setImportSource]
  );

  const addNativePaths = useCallback(
    (paths: string[], mtimes?: (string | null)[]) => {
      const existing = new Set(
        useImportStore
          .getState()
          .files.map((f) => f.nativePath)
          .filter((p): p is string => !!p)
      );
      const validPaths: string[] = [];
      const validMtimes: (string | null)[] = [];
      paths.forEach((path, i) => {
        if (existing.has(path)) return; // dedupe by full path, not basename
        existing.add(path);
        validPaths.push(path);
        validMtimes.push(mtimes?.[i] ?? null);
      });
      if (validPaths.length === 0) return;
      setImportSource('file');
      addNativePathFiles(validPaths, validMtimes);
    },
    [addNativePathFiles, setImportSource]
  );

  useEffect(() => {
    const w = window as Window & {
      __logsonicPendingNativeFiles?: { paths: string[]; mtimes?: (string | null)[] };
    };
    const consume = (detail?: { paths?: string[]; mtimes?: (string | null)[] }) => {
      if (!detail?.paths?.length) return;
      w.__logsonicPendingNativeFiles = undefined;
      addNativePaths(detail.paths, detail.mtimes);
    };
    if (w.__logsonicPendingNativeFiles) {
      consume(w.__logsonicPendingNativeFiles);
    }
    const onNative = (event: Event) => {
      consume((event as CustomEvent<{ paths?: string[]; mtimes?: (string | null)[] }>).detail);
    };
    window.addEventListener('logsonic-native-files', onNative);
    return () => window.removeEventListener('logsonic-native-files', onNative);
  }, [addNativePaths]);

  return { addBrowserFiles, addNativePaths };
}

export default useFileIntake;
