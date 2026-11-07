import { useEffect, useState } from 'react';
import { api } from './api';

export interface LegalConfig {
  configured: boolean;
  documentVersion: string;
  consentVersion: string;
  operator: { name: string; address: string; email: string };
  feedbackRetentionDays: number;
  cookies: { adminDays: number; showHours: number };
  diagnosticsMinutes: number;
}
export interface FeedbackConsent { accepted: true; version: string }

export function useLegalConfig() {
  const [config, setConfig] = useState<LegalConfig | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (import.meta.env.VITE_STATIC_DEMO === 'true') return;
    const controller = new AbortController();
    api<LegalConfig>('/api/legal', { signal: controller.signal })
      .then(setConfig).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return { config, error };
}
