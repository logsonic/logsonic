import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Routes, Route } from "react-router-dom";
import { initializeApplication } from './lib/initialize';
import { Toaster } from '@/components/ui/toaster';

// Lazy load page components for code-splitting
const Home = lazy(() => import("./pages/Home.tsx"));
const Import = lazy(() => import("./pages/Import.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Loading component for Suspense fallback
const LoadingScreen = () => (
  <div className="flex items-center justify-center h-screen">
    <div className="text-center">
      <div className="animate-spin mb-4 h-10 w-10 border-t-2 border-b-2 border-primary rounded-full mx-auto"></div>
      <p className="text-lg">Loading...</p>
    </div>
  </div>
);

const App = () => {
  // Initialize application data on startup
  useEffect(() => {
    initializeApplication()
      .catch(error => console.error('Failed to initialize application:', error));
  }, []);

  return (
    <>
      <HashRouter>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/import" element={<Import />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </HashRouter>
      <Toaster />
    </>
  );
};

export default App;
