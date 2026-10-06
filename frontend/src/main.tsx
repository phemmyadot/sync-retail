import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { IS_TAURI } from '@/lib/config';
import { HostGate } from '@/components/HostGate';
import { SetupGate } from '@/features/setup/SetupGate';
import { App } from './App';
// Fonts ship with the app (no Google Fonts request): works offline, and nothing
// is sent to third parties when a register starts.
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Don't hammer the API on 4xx — those won't fix themselves.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {IS_TAURI ? (
          <HostGate>
            <SetupGate>
              <App />
            </SetupGate>
          </HostGate>
        ) : (
          <SetupGate>
            <App />
          </SetupGate>
        )}
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
