import { FC } from "react";
import { useImportStore } from "../../../stores/useImportStore";
import { selectedFileIdsForImport } from "./ImportConfirmStep";
import { Button } from "../../ui/button";

const HandleNavigation: FC<{
    onNext: () => void;
    onBack: () => void;
}> = ({ onNext, onBack }) => {
    const { currentStep, importSource, readyToSelectPattern, isUploading, files } = useImportStore();

    const isMultiFile = importSource === 'file' && files.length > 0;

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

    return (
        <div className="flex justify-between pt-4">
            <Button
                variant="outline"
                onClick={onBack}
                disabled={isUploading}
            >
                {currentStep === 1 ? 'Cancel' : 'Back'}
            </Button>

            <Button
                onClick={onNext}
                disabled={isNextDisabled()}
                className="bg-blue-600 hover:bg-blue-700"
            >
                {getNextLabel()}
            </Button>
        </div>
    );
};

export default HandleNavigation;
