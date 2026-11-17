import { useRef, useState } from 'react';
import { ArrowLeft, Globe } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  getProxyConfig, setProxyConfig, validateProxyConfig,
  type ProxyConfig, type ProxyType,
} from '../../services/appSettings';

const TYPE_OPTIONS: Array<{ id: ProxyType; label: string; hint: string }> = [
  { id: 'off', label: 'Off', hint: 'No proxy. This is the default.' },
  { id: 'http', label: 'HTTP', hint: 'Plain HTTP proxy.' },
  { id: 'socks5', label: 'SOCKS5', hint: 'SOCKS5 proxy.' },
];

export default function ProxySettingsScreen({ onBack }: { onBack?: () => void } = {}) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<ProxyConfig>(() => getProxyConfig());
  const [type, setType] = useState<ProxyType>(saved.type);
  const [host, setHost] = useState(saved.host);
  const [port, setPort] = useState(saved.port ? String(saved.port) : '');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goBack = () => {
    if (onBack) onBack();
    else navigate('/settings');
  };

  const showToastMsg = (msg: string) => {
    // House pattern (SettingsScreen, 100M-D5): clear the previous toast's
    // timer first, or it clears the newer toast early.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  };

  const handleSave = () => {
    const cfg: ProxyConfig = {
      type,
      host: host.trim(),
      port: port.trim() === '' ? 0 : Number(port),
    };
    const problem = validateProxyConfig(cfg);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setProxyConfig(cfg);
    setSaved(getProxyConfig());
    showToastMsg(type === 'off' ? 'Proxy turned off' : 'Proxy settings saved');
  };

  const dirty =
    type !== saved.type || host.trim() !== saved.host || (port.trim() === '' ? 0 : Number(port)) !== saved.port;

  return (
    <div className="min-h-screen bg-[#f0f2f5] dark:bg-background-dark">
      <header className="sticky top-0 z-10 bg-green-cta text-white shadow">
        <div className="flex items-center gap-2 px-2 py-3">
          <button
            onClick={goBack}
            aria-label="Back to settings"
            className="p-2 rounded-full hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-medium">Proxy</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4">
        <div
          className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4"
          role="note"
        >
          <p className="text-sm text-gray-900 dark:text-text-primary font-medium">
            Proxy routing is not active yet.
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Your proxy address is saved on this device, but your messages and
            calls still go directly, not through the proxy. Routing needs
            backend work first. Calls will not connect while a proxy is on,
            once routing is active.
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Your IP address is shared with the proxy provider.
          </p>
        </div>

        <fieldset className="mt-6">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
            Proxy type
          </legend>
          <div className="bg-white dark:bg-panel-dark rounded-lg shadow-sm divide-y divide-gray-100 dark:divide-white/5">
            {TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.id}
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5"
              >
                <input
                  type="radio"
                  name="proxy-type"
                  value={opt.id}
                  checked={type === opt.id}
                  onChange={() => setType(opt.id)}
                  aria-label={`${opt.label} proxy`}
                  className="h-4 w-4 accent-[#075E54]"
                />
                <Globe className="h-5 w-5 text-primary-green flex-shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] text-gray-900 dark:text-text-primary">{opt.label}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {type !== 'off' && (
          <div className="bg-white dark:bg-panel-dark rounded-lg shadow-sm mt-4 p-4">
            <label htmlFor="proxy-host" className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Proxy host
            </label>
            <input
              id="proxy-host"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="proxy.example.com"
              aria-describedby="proxy-host-hint"
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-white/10 bg-white dark:bg-background-dark px-3 py-2 text-[15px] text-gray-900 dark:text-text-primary focus-visible:outline-2 focus-visible:outline-primary-green"
            />
            <p id="proxy-host-hint" className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              A host name or IP address. No username or password is stored.
            </p>

            <label htmlFor="proxy-port" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mt-4">
              Proxy port
            </label>
            <input
              id="proxy-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="8080"
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-white/10 bg-white dark:bg-background-dark px-3 py-2 text-[15px] text-gray-900 dark:text-text-primary focus-visible:outline-2 focus-visible:outline-primary-green"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger-red mt-3">
            {error}
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={!dirty}
          className="mt-4 px-5 py-2 rounded-full bg-green-cta text-white text-sm hover:opacity-90 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-primary-green"
        >
          Save
        </button>

        {saved.type !== 'off' && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
            Saved: {saved.type.toUpperCase()} {saved.host}:{saved.port}. Routing
            is not active yet, so this changes nothing until the backend work
            lands.
          </p>
        )}
      </main>

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-full shadow-lg z-50"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
