import { ArrowRight } from "lucide-react";
import { FC } from "react";
import { useImportStore } from "../../../stores/useImportStore";
import { selectedFileIdsForImport } from "./ImportConfirmStep";

const HandleNavigation: FC<{
    onNext: () => void;
    onBack: () => void;
}> = ({ onNext, onBack }) => {
    const { currentStep, importSource, readyToSelectPattern, isUploading, files, timestampInference, timestampConfirmed } = useImportStore();

    const isMultiFile = importSource === 'file' && files.length > 0;

    // Block step-2 → step-3 when any inference says ambiguous/missing
    // and that file hasn't been confirmed. In single-file mode we
    // check the global slice; in multi-file mode every file must
    // independently pass.
    const fileNeedsConfirmation = (f: typeof files[number]) =>
        f.timestampInference
        && (f.timestampInference.status === 'ambiguous' || f.timestampInference.status === 'missing')
        && !f.timestampConfirmed;
    const timestampGated = isMultiFile
        ? files.some(fileNeedsConfirmation)
        : (timestampInference
            && (timestampInference.status === 'ambiguous' || timestampInference.status === 'missing')
            && !timestampConfirmed);

    // Determine if Next should be enabled
    const isNextDisabled = () => {
        if (isUploading) return true;

        switch (currentStep) {
            case 1:
                if (!importSource) return true;
                if (importSource === 'file' && files.length === 0) return true;
                if (!isMultiFile && !readyToSelectPattern) return true;
                return false;
            case 2:
                if (isMultiFile) {
                    // All files must have a selected pattern
                    return files.some(f => !f.selectedPattern) ||
                           files.some(f => f.detectionStatus === 'detecting' || f.detectionStatus === 'pending');
                }
                if (timestampGated) return true;
                return !readyToSelectPattern;
            case 3:
                // Disable if no files are checked in multi-file mode
                if (isMultiFile && selectedFileIdsForImport !== null && selectedFileIdsForImport.size === 0) return true;
                return false;
            case 4:
                return false;
            default:
                return true;
        }
    };

    // Button label
    const getNextLabel = () => {
        if (currentStep === 3) {
            if (isMultiFile) {
                const count = selectedFileIdsForImport ? selectedFileIdsForImport.size : files.length;
                return count > 0 ? `Import ${count} File${count !== 1 ? 's' : ''}` : 'Import';
            }
            return 'Import';
        }
        if (currentStep === 4) return 'Home';
        return 'Next';
    };

    const nextDisabled = isNextDisabled();
    const isFinalAction = currentStep === 3 || currentStep === 4;

    return (
        <div className="flex justify-between items-center">
            <button
                type="button"
                onClick={onBack}
                disabled={isUploading}
                className="inline-flex items-center transition-colors"
                style={{
                    height: 32,
                    padding: '0 12px',
                    borderRadius: 6,
                    border: '1px solid var(--ls-border-strong)',
                    background: 'var(--ls-panel)',
                    color: 'var(--ls-text-2)',
                    fontSize: 12.5,
                    fontWeight: 500,
                    cursor: isUploading ? 'not-allowed' : 'pointer',
                    opacity: isUploading ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                    if (!isUploading) {
                        e.currentTarget.style.background = 'var(--ls-bg-2)';
                        e.currentTarget.style.color = 'var(--ls-text)';
                    }
                }}
                onMouseLeave={(e) => {
                    if (!isUploading) {
                        e.currentTarget.style.background = 'var(--ls-panel)';
                        e.currentTarget.style.color = 'var(--ls-text-2)';
                    }
                }}
            >
                {currentStep === 1 ? 'Cancel' : 'Back'}
            </button>

            <button
                type="button"
                onClick={onNext}
                disabled={nextDisabled}
                className="inline-flex items-center text-white transition-colors"
                style={{
                    gap: 6,
                    height: 32,
                    padding: '0 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'var(--ls-accent)',
                    color: '#fff',
                    fontSize: 12.5,
                    fontWeight: 600,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
                    cursor: nextDisabled ? 'not-allowed' : 'pointer',
                    opacity: nextDisabled ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                    if (!nextDisabled) e.currentTarget.style.background = 'var(--ls-accent-hover)';
                }}
                onMouseLeave={(e) => {
                    if (!nextDisabled) e.currentTarget.style.background = 'var(--ls-accent)';
                }}
            >
                <span>{getNextLabel()}</span>
                {!isFinalAction && <ArrowRight size={13} />}
            </button>
        </div>
    );
};

export default HandleNavigation;
