import { FC, useEffect, useState } from 'react';
import { Cloud, File, CheckCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useImportStore } from '@/stores/useImportStore';

// Success Summary component for showing import completion
export const SuccessSummary: FC = () => {
    const { selectedFileName, importSource, sessionOptionsFileName, selectedPattern, totalLines } = useImportStore();
    const navigate = useNavigate();
     const [redirectTimer, setRedirectTimer] = useState<NodeJS.Timeout | null>(null);
    // Set the icon and filename label based on the import source
    const sourceIcon = importSource === 'cloudwatch' 
      ? <Cloud className="h-6 w-6 text-blue-500 mr-2" />
      : <File className="h-6 w-6 text-blue-500 mr-2" />;
    
    const fileLabel = importSource === 'cloudwatch' ? 'CloudWatch Log:' : 'File Name:';
    const fileName = importSource === 'cloudwatch' ? sessionOptionsFileName : selectedFileName;
  
     useEffect(() => {
      // Start a redirect timer
      if (!redirectTimer) {
      const timer = setTimeout(() => {
        
        navigate('/');
      }, 5000);
      setRedirectTimer(timer);
      }
    
    }, []);
    return (
      <div className="space-y-6 py-4">
        <div className="flex flex-col items-center text-center">
          <div className="flex items-center mb-3">
            <CheckCircle className="h-8 w-8 text-green-500 mr-2" />
            <h2 className="text-2xl font-bold text-gray-800">Import Successful!</h2>
          </div>
          <p className="text-gray-600 mt-2">
            Your logs have been successfully imported and processed. Redirecting to home page in 5 seconds...
          </p>
          <div className="rounded-lg p-6">
          <div className="space-y-2">
            <div className="flex justify-center items-center">
              {sourceIcon}
              <span className="text-gray-600 mr-2">{fileLabel}</span>
              <span className="font-medium">{fileName}</span>
            </div>
            <div className="flex justify-center">
              <span className="text-gray-600 mr-2">Pattern Used: </span>
              <span className="font-medium">{selectedPattern?.name}</span>
            </div>
            <div className="flex justify-center">
              <span className="text-gray-600 mr-2">Total Lines Processed:</span>
              <span className="font-medium">{totalLines.toLocaleString()}</span>
            </div>
          </div>
        </div>
        </div>
        
  
        
        <div className="text-center text-gray-500 mt-4">
         
        </div>
      </div>
    );
  };

  export default SuccessSummary;