import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';

import { initializeApplication } from './lib/initialize';

import { Toaster } from '@/components/ui/toaster';
import { useThemeStore } from '@/stores/useThemeStore';

// Lazy load page components for code-splitting
const Home = lazy(() => import('./pages/Home.tsx'));
const Import = lazy(() => import('./pages/Import.tsx'));
const CustomPatterns = lazy(() => import('./pages/settings/CustomPatterns.tsx'));
const SettingsAbout = lazy(() => import('./pages/settings/About.tsx'));
const McpSetup = lazy(() => import('./pages/settings/McpSetup.tsx'));
const NotFound = lazy(() => import('./pages/NotFound.tsx'));

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
  // Hydrate theme on mount (sets data-theme + .dark)
  const setTheme = useThemeStore((s) => s.setTheme);
  const theme = useThemeStore((s) => s.theme);

  // Initialize application data on startup
  useEffect(() => {
    initializeApplication().catch((error) =>
      console.error('Failed to initialize application:', error)
    );
    // Apply current theme on first render (handles fresh load before persist rehydration callback)
    setTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <HashRouter>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/import" element={<Import />} />
            <Route path="/settings" element={<Navigate to="/settings/patterns" replace />} />
            <Route path="/settings/patterns" element={<CustomPatterns />} />
            <Route path="/settings/about" element={<SettingsAbout />} />
            <Route path="/settings/mcp" element={<McpSetup />} />
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
