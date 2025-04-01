import { useImportStore } from "@/stores/useImportStore";
import type { LogSourceProviderService } from "../types";



export const useFileSelectionService = () : LogSourceProviderService => {
  const importStore = useImportStore();    

  const handleFilePreview = async (filehandle: object, onPreviewReadyCallback: (lines: string[]) => void) => {

    const file = filehandle as File;
    importStore.setSelectedFileHandle(file);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;

      // Set approx lines
      const lines = text.split('\n');
      importStore.setApproxLines(lines.length);
      const preViewLines = lines.slice(0, 100);
      // TBD check if the file is binary or has no valid delimiter
      onPreviewReadyCallback(preViewLines);
      reader.abort();
    };
   
    reader.readAsText(file);
  };

  const handleFileImport = (filehandle: object, chunkSize: number, callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>) => {  
    // process data
    const file = filehandle as File;
    let currentIndex = 0;
    return new Promise<void>((resolve, reject) => {
      console.log("Importing file:", file.name, "with handle:", filehandle);
      if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const text = e.target?.result as string;
          const lines = text.split('\n');
          let totalLines = lines.length;

          const processChunk = async () => {
            const chunk = lines.slice(currentIndex, currentIndex + chunkSize);
            await callback(chunk, totalLines, () => {
              currentIndex += chunkSize;
              if (currentIndex < totalLines) {
                processChunk();
              } else {
                resolve();
              }
            });
          };  
          processChunk();
        };
        reader.onerror = (e) => {
          reject(new Error("Error reading file"));
        };
        reader.readAsText(file);
      } else {
        reject(new Error("No filename or filehandle provided"));
      }
    });
  };

  return {
    name: "File",
    handleFilePreview,
    handleFileImport
  };
};
