import axios from 'axios';

/**
 * API base resolution order:
 *   1. ?api=<url>          (handy for pointing the Vercel frontend at another backend)
 *   2. localStorage.API_BASE
 *   3. VITE_API_BASE build-time env
 *   4. same origin
 */
function resolveBase() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('api');
  if (fromQuery) {
    window.localStorage.setItem('API_BASE', fromQuery);
    return fromQuery.replace(/\/$/, '');
  }
  const stored = window.localStorage.getItem('API_BASE');
  if (stored) return stored.replace(/\/$/, '');
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE.replace(/\/$/, '');
  return '';
}

export const API_BASE = resolveBase();

export const http = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 20_000,
});

export const api = {
  async createClient(label) {
    const { data } = await http.post('/clients', { label });
    return data.client;
  },
  heartbeat(clientId) {
    return http.post(`/clients/${clientId}/heartbeat`).catch(() => {});
  },
  disconnect(clientId) {
    return http.delete(`/clients/${clientId}`).catch(() => {});
  },
  async upload({ clientId, priority, file, onUploadProgress }) {
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('priority', priority);
    form.append('file', file, file.name);
    const { data } = await http.post('/uploads', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
    });
    return data.task;
  },
  async cancel(taskId, clientId) {
    const { data } = await http.post(`/tasks/${taskId}/cancel`, { clientId });
    return data.task;
  },
  async state() {
    const { data } = await http.get('/state');
    return data;
  },
  tick() {
    return http.post('/tick').then((r) => r.data);
  },
  resultFileUrl(taskId) {
    return `${API_BASE}/api/tasks/${taskId}/result/file`;
  },
  streamUrl(clientId) {
    const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
    return `${API_BASE}/api/stream${qs}`;
  },
};

export default api;
