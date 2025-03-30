import { FC, useState } from "react";
import { Button } from "../ui/button";
import { useImportStore } from "../../stores/useImportStore";

const HandleNavigation: FC<{
    onNext: () => void;
    onBack: () => void;
}> = ({ onNext, onBack }) => {

    const [uploadSummary, setUploadSummary] = useState<{
    totalLines: number;
    patternName: string;
    redirectCountdown: number;
    showSummary: boolean;       
  } | null>(null);


const { currentStep, setCurrentStep, importSource, selectedPattern, setImportSource, readyToSelectPattern, detectionResult, isCreateNewPatternSelected, setError, isUploading} = useImportStore();
 
return (
    <div className="flex justify-between pt-4">
    <Button 
        variant="outline" 
        onClick={onBack}
        disabled={isUploading }
    >
        {currentStep === 1 ? 'Cancel' : 'Back'}
    </Button>

    {/* Next button logic */}
    <Button 
    onClick={onNext}
    disabled={
        !readyToSelectPattern ||
        isUploading || 
        (currentStep === 1 && !importSource)
    }
    className="bg-blue-600 hover:bg-blue-700"
    >
    {currentStep === 3 ? (
        uploadSummary?.showSummary ? 'Go to Home' : 'Import'
    ) : (
        'Next'
    )}
    </Button>
    </div>
    )
}

export default HandleNavigation;