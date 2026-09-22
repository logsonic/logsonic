import { FC, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { DetailPanel } from '@/components/Import/DetailPanel/DetailPanel';
import { DropZone } from '@/components/Import/DropZone';
import { FileList } from '@/components/Import/FileList/FileList';
import { useFileDetection } from '@/components/Import/hooks/useFileDetection';
import { useFileIntake } from '@/components/Import/hooks/useFileIntake';
import useUpload from '@/components/Import/hooks/useUpload';
import { ImportAction } from '@/components/Import/ImportAction';
import { ImportLayout } from '@/components/Import/ImportLayout';
import { useFileSelectionService } from '@/components/Import/LocalFileImport/FileSelectionService';
import { PreviewPane } from '@/components/Import/PreviewPane/PreviewPane';
import { SuccessSummary } from '@/components/Import/SuccessSummary';
import { UploadProgress } from '@/components/Import/UploadProgress/UploadProgress';
import { SavePatternDialog } from '@/components/Import/UploadSteps/SavePatternDialog';
import { importGate } from '@/components/Import/utils/importGate';
import { extractFields } from '@/components/Import/utils/patternUtils';
import { useToast } from '@/components/ui/use-toast';
import { getGrokPatterns } from '@/lib/api-client';
import { ErrorBoundary } from '@/lib/error-boundary';
import { isNativeShell } from '@/lib/native';
import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';

type Phase = 'edit' | 'complete';

/**
 * Single-surface import: drop files → see what detection found → import.
 * Per-file configuration lives one click deep in the detail panel; the
 * upload itself and the save-pattern handshake are the wizard's, unchanged.
 */
const Import: FC = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const fileService = useFileSelectionService();
  const { handleMultiFileUpload, cancelUpload } = useUpload();
  const { addBrowserFiles } = useFileIntake();
  const { changePattern, applyPatternToAll, redetectAll, reparseFile } = useFileDetection();

  const files = useImportStore((s) => s.files);
  const isUploading = useImportStore((s) => s.isUploading);
  const activeFileId = useImportStore((s) => s.activeFileId);
  const detailPanelFileId = useImportStore((s) => s.detailPanelFileId);
  const setActiveFileId = useImportStore((s) => s.setActiveFileId);
  const openFileDetail = useImportStore((s) => s.openFileDetail);
  const closeFileDetail = useImportStore((s) => s.closeFileDetail);
  const removeFile = useImportStore((s) => s.removeFile);
  const setAvailablePatterns = useImportStore((s) => s.setAvailablePatterns);
  const reset = useImportStore((s) => s.reset);

  const [phase, setPhase] = useState<Phase>('edit');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveDialogShown, setSaveDialogShown] = useState(false);

  // Saved patterns feed detection (name matching) and the Pattern tab.
  useEffect(() => {
    getGrokPatterns()
      .then((response) => {
        if (response.patterns && response.patterns.length > 0) {
          setAvailablePatterns(
            response.patterns.map((p) => ({
              name: p.name || 'Unnamed Pattern',
              pattern: p.pattern || '',
              description:
                p.description && p.description.trim()
                  ? p.description
                  : `Grok pattern for ${p.name || 'unknown'} logs`,
              custom_patterns: p.custom_patterns,
              fields: extractFields(p.pattern || ''),
              priority: p.priority || 0,
              timestamp_config: p.timestamp_config,
            }))
          );
        }
      })
      .catch((err) => {
        console.error('Failed to fetch patterns:', err);
        toast({
          title: 'Warning',
          description: 'Failed to load patterns from server. Using default patterns instead.',
          variant: 'destructive',
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a row selected whenever there are files, so the preview pane is
  // never empty while something could be shown.
  useEffect(() => {
    if (files.length === 0) {
      if (activeFileId) setActiveFileId(null);
      return;
    }
    if (!activeFileId || !files.some((f) => f.id === activeFileId)) {
      setActiveFileId(files[0].id);
    }
  }, [files, activeFileId, setActiveFileId]);

  const gate = importGate(files, isUploading);

  // Runs the actual multi-file import and moves to the completion card.
  // Split out of handleImport so it can be deferred until after the
  // SavePatternDialog is resolved (saved or skipped) for custom patterns.
  const proceedWithImport = useCallback(async () => {
    const staged = useImportStore.getState().files;
    if (staged.length === 0) {
      toast({
        title: 'Nothing to import',
        description: 'Please add at least one file.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const { cancelled } = await handleMultiFileUpload(staged, fileService);
      const updated = useImportStore.getState().files;
      const successCount = updated.filter((f) => f.uploadStatus === 'success').length;
      const failedCount = updated.filter((f) => f.uploadStatus === 'failed').length;

      if (cancelled && successCount === 0) {
        toast({ title: 'Import cancelled', description: 'No files were imported.' });
        // Back to the staged list: nothing was written, so the user can
        // adjust and retry without re-adding files.
        updated.forEach((f) =>
          useImportStore
            .getState()
            .updateFile(f.id, { uploadStatus: 'pending', uploadProgress: 0, uploadError: null })
        );
        return;
      }
      if (successCount > 0) {
        toast({
          title: failedCount === 0 ? 'Import successful' : 'Import complete',
          description:
            failedCount === 0
              ? `All ${successCount} file${successCount === 1 ? '' : 's'} imported successfully.`
              : `${successCount} imported, ${failedCount} failed.`,
          variant: failedCount === 0 ? 'default' : 'destructive',
        });
      } else {
        toast({
          title: 'Import failed',
          description: 'All files failed to import.',
          variant: 'destructive',
        });
      }
      setPhase('complete');
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Failed to import files',
        variant: 'destructive',
      });
    }
  }, [fileService, handleMultiFileUpload, toast]);

  const handleImport = useCallback(async () => {
    const staged = useImportStore.getState().files;
    const missing = staged.find((f) => !f.selectedPattern);
    if (missing) {
      toast({
        title: 'Pattern required',
        description: `Please select a pattern for "${missing.fileName}".`,
        variant: 'destructive',
      });
      return;
    }
    // If any file uses a custom pattern, prompt to name & save it BEFORE
    // importing. The dialog must block the import: open it and return
    // here; importing resumes from the dialog's onClose (Save Pattern or
    // Skip & Continue).
    if (!saveDialogShown) {
      const customFile = staged.find((f) => f.isCustomPattern && f.selectedPattern);
      if (customFile && customFile.selectedPattern) {
        const store = useImportStore.getState();
        const draftName = customFile.customPattern?.name;
        store.setCreateNewPattern(customFile.selectedPattern);
        store.setCreateNewPatternName(
          draftName && draftName !== DEFAULT_PATTERN.name
            ? draftName
            : customFile.selectedPattern.name
        );
        store.setCreateNewPatternDescription(customFile.selectedPattern.description || '');
        store.setActiveFileId(customFile.id);
        setShowSaveDialog(true);
        setSaveDialogShown(true);
        return;
      }
    }
    await proceedWithImport();
  }, [proceedWithImport, saveDialogShown, toast]);

  const leave = useCallback(() => {
    reset();
    navigate('/');
  }, [navigate, reset]);

  // The whole page accepts drops while files can be staged. Without this
  // a drop that misses a target (the preview pane is the largest surface)
  // makes the browser navigate to the file and the staged session is gone.
  // The targets' own handlers stop propagation, so nothing is added twice.
  const canStage = phase === 'edit' && !isUploading;
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = canStage ? 'copy' : 'none';
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (canStage && dropped.length > 0) addBrowserFiles(dropped);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [addBrowserFiles, canStage]);

  const activeFile = files.find((f) => f.id === activeFileId) ?? null;
  const detailFile = files.find((f) => f.id === detailPanelFileId) ?? null;
  const hasFiles = files.length > 0;

  let body: React.ReactNode;
  if (phase === 'complete') {
    body = <SuccessSummary />;
  } else if (isUploading) {
    body = <UploadProgress onCancel={cancelUpload} />;
  } else {
    body = hasFiles ? (
      <div className={`ls-imp-split ls-rise${detailFile ? ' ls-imp-split--detail' : ''}`}>
        {detailFile ? (
          <DetailPanel
            file={detailFile}
            files={files}
            onBack={closeFileDetail}
            onChangePattern={changePattern}
            onReparse={reparseFile}
          />
        ) : (
          <FileList
            files={files}
            selectedId={activeFileId}
            onSelect={setActiveFileId}
            onConfigure={openFileDetail}
            onRemove={removeFile}
            onAddFiles={addBrowserFiles}
            onApplyPatternToAll={applyPatternToAll}
            onRedetectAll={redetectAll}
          />
        )}
        <PreviewPane
          file={detailFile ?? activeFile}
          onTestAnotherPattern={() => {
            const target = detailFile ?? activeFile;
            if (target) openFileDetail(target.id);
          }}
        />
      </div>
    ) : (
      <DropZone native={isNativeShell()} onFiles={addBrowserFiles} />
    );
  }

  return (
    <ErrorBoundary fallback={<div>Error loading import page</div>}>
      <ImportLayout
        fileCount={files.length}
        onLeave={leave}
        leaveLabel={hasFiles && phase === 'edit' ? 'Cancel' : 'Back to home'}
        leaveDisabled={isUploading}
        actions={
          hasFiles && phase === 'edit' && !isUploading ? (
            <ImportAction files={files} gate={gate} onImport={handleImport} />
          ) : null
        }
      >
        {showSaveDialog && (
          <SavePatternDialog
            open={showSaveDialog}
            onClose={() => {
              setShowSaveDialog(false);
              // Resume the import the dialog was blocking. Runs whether the
              // user saved the pattern or chose Skip & Continue.
              proceedWithImport();
            }}
          />
        )}
        {body}
      </ImportLayout>
    </ErrorBoundary>
  );
};

export default Import;
