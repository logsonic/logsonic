import type { LogSourceProviderService } from "../types";
export const FileSelectionService : LogSourceProviderService = {
    name: "File",
  
    handleFilePreview: async (file, onPreviewReadyCallback) => {
  
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target?.result as string;
        const lines = text.split('\n').slice(0, 100);
       // TBD check if the file is binary or has no valid delimiter
        onPreviewReadyCallback(lines);
        reader.abort();
      };
      reader.readAsText(file);
    },
    handleFileImport: (filename, filehandle, chunkSize, callback) => {  
      // process data
  
      let currentIndex = 0;
      return new Promise((resolve, reject) => {
        console.log("Importing file:", filename, "with handle:", filehandle);
        if (filename && filehandle) {
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
          reader.readAsText(filehandle);
        } else {
          reject(new Error("No filename or filehandle provided"));
        }
      });
    },
  };
  