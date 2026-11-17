/**
 * ChatBackupPanel — ROADMAP-2 item 3 (Worker R1C).
 *
 * Backup & restore UI for Settings → Chats. All logic lives in
 * `src/services/chatBackup.ts`; this file is only inputs + status copy.
 *
 * Honest copy is deliberate: the passphrase is the ONLY recovery path
 * (no reset, no escrow), the E2EE identity private key cannot be backed
 * up (non-extractable — see chatBackup.ts), media bytes are not included
 * (only their S3 URLs), and when S3 is not connected the backup lives on
 * this device only.
 */
import React, { useRef, useState } from 'react';
import { HardDriveUpload, Download, Trash2, ShieldAlert, Eye, EyeOff, FileUp } from 'lucide-react';
import {
  BackupError,
  createBackup,
  deleteBackup,
  downloadBackupFile,
  getLastBackupMeta,
  hasBackup,
  restoreBackup,
  restoreBackupFromFile,
  validatePassphrase,
  MIN_PASSPHRASE_LENGTH,
  type BackupMeta,
} from '../services/chatBackup';
import { getAwsEnvConfig } from '../aws/config';

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

export default function ChatBackupPanel() {
  const s3Configured = !!getAwsEnvConfig().s3Bucket;
  const [meta, setMeta] = useState<BackupMeta | null>(() => getLastBackupMeta());
  const [backupPass, setBackupPass] = useState('');
  const [backupPass2, setBackupPass2] = useState('');
  const [restorePass, setRestorePass] = useState('');
  // S15 (100-more): passphrase fields get real labels + show/hide toggles
  // (a mistyped blind passphrase is discovered only at restore time).
  const [showBackupPass, setShowBackupPass] = useState(false);
  const [showBackupPass2, setShowBackupPass2] = useState(false);
  const [showRestorePass, setShowRestorePass] = useState(false);
  // S1 (100-more): restore from a downloaded .dtbackup file (new phone).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'backup' | 'restore' | 'restoreFile' | 'download' | 'delete' | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const fail = (err: unknown) => {
    if (err instanceof BackupError) setError(err.message);
    else setError(err instanceof Error ? err.message : 'Something went wrong.');
  };

  const handleBackup = async () => {
    setError('');
    setStatus('');
    if (backupPass !== backupPass2) {
      setError('Passphrases do not match.');
      return;
    }
    const v = validatePassphrase(backupPass);
    if (v) {
      setError(v);
      return;
    }
    setBusy('backup');
    try {
      const res = await createBackup(backupPass);
      setMeta(getLastBackupMeta());
      setStatus(res.summary);
      setBackupPass('');
      setBackupPass2('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    setError('');
    setStatus('');
    if (!hasBackup()) {
      setError('No backup found — make a backup first, or restore from a downloaded backup file below.');
      return;
    }
    const v = validatePassphrase(restorePass);
    if (v) {
      setError(v);
      return;
    }
    setBusy('restore');
    try {
      const res = await restoreBackup(restorePass);
      setStatus(res.summary);
      setRestorePass('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  // S1: restore from a .dtbackup file the user picked (new phone / lost
  // metadata). Deliberately NOT gated on hasBackup() — on a new phone
  // there is no local metadata, which is exactly when this is needed.
  // The passphrase comes from the same Restore field above.
  const handleRestoreFromFile = async (file: File) => {
    setError('');
    setStatus('');
    const v = validatePassphrase(restorePass);
    if (v) {
      setError(v);
      return;
    }
    setBusy('restoreFile');
    try {
      const res = await restoreBackupFromFile(file, restorePass);
      setStatus(`${res.summary} (from file ${file.name})`);
      setRestorePass('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownload = async () => {
    setError('');
    setStatus('');
    setBusy('download');
    try {
      const res = await downloadBackupFile();
      setStatus(`Downloaded ${res.fileName} (${formatBytes(res.sizeBytes)}). Keep it somewhere safe — it only opens with your passphrase.`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    setError('');
    setStatus('');
    setBusy('delete');
    try {
      await deleteBackup();
      setMeta(null);
      setShowDeleteConfirm(false);
      setStatus('Backup deleted. This cannot be undone.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide mb-2">Backup &amp; restore</h3>
      <div className="bg-white dark:bg-panel-dark rounded-xl border border-gray-100 dark:border-white/5 overflow-hidden">
        <div className="px-4 py-3">
          <p className="text-sm font-medium text-gray-900 dark:text-text-primary flex items-center gap-2">
            <HardDriveUpload className="h-4 w-4" /> Encrypted chat backup
          </p>
          <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">
            Backs up your chats — decrypted on this device, then re-encrypted with a passphrase only you know.
            {s3Configured
              ? ' Stored in S3.'
              : ' S3 is not connected, so the backup is stored on this device only — it will NOT survive losing this phone.'}
          </p>
          {meta ? (
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-2">
              Last backup: {formatDate(meta.createdAt)} · {meta.messageCount} message(s) in {meta.chatCount} chat(s) · {formatBytes(meta.sizeBytes)} · {meta.location === 's3' ? 'S3' : 'this device only'}
              {meta.undecryptableSkipped > 0 ? ` · ${meta.undecryptableSkipped} message(s) could not be decrypted and were left out` : ''}
            </p>
          ) : (
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-2">No backup yet.</p>
          )}
        </div>

        <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3">
          <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Back up now</p>
          <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">
            Choose a passphrase (at least {MIN_PASSPHRASE_LENGTH} characters — longer is better). Write it down: losing it loses the backup. There is no reset.
          </p>
          <div className="space-y-2 mt-2">
            <label htmlFor="backup-passphrase" className="block text-xs font-medium text-gray-700 dark:text-text-primary">Backup passphrase</label>
            <div className="relative">
              <input
                id="backup-passphrase"
                type={showBackupPass ? 'text' : 'password'}
                value={backupPass}
                onChange={(e) => setBackupPass(e.target.value)}
                placeholder="Backup passphrase"
                autoComplete="new-password"
                className="w-full px-3 py-2 pr-10 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-input-dark text-sm text-gray-900 dark:text-text-primary placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={() => setShowBackupPass((v) => !v)}
                aria-label={showBackupPass ? 'Hide passphrase' : 'Show passphrase'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-panel-dark"
              >
                {showBackupPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <label htmlFor="backup-passphrase-repeat" className="block text-xs font-medium text-gray-700 dark:text-text-primary">Repeat passphrase</label>
            <div className="relative">
              <input
                id="backup-passphrase-repeat"
                type={showBackupPass2 ? 'text' : 'password'}
                value={backupPass2}
                onChange={(e) => setBackupPass2(e.target.value)}
                placeholder="Repeat passphrase"
                autoComplete="new-password"
                className="w-full px-3 py-2 pr-10 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-input-dark text-sm text-gray-900 dark:text-text-primary placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={() => setShowBackupPass2((v) => !v)}
                aria-label={showBackupPass2 ? 'Hide passphrase' : 'Show passphrase'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-panel-dark"
              >
                {showBackupPass2 ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <button
              onClick={handleBackup}
              disabled={busy !== null}
              className="px-4 py-2 rounded-full bg-green-cta text-white text-sm font-medium disabled:opacity-50"
            >
              {busy === 'backup' ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        </div>

        <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3">
          <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Restore</p>
          <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">
            Restores the last backup onto this device. Wrong passphrase fails without changing anything.
          </p>
          <div className="space-y-2 mt-2">
            <label htmlFor="restore-passphrase" className="block text-xs font-medium text-gray-700 dark:text-text-primary">Backup passphrase</label>
            <div className="relative">
              <input
                id="restore-passphrase"
                type={showRestorePass ? 'text' : 'password'}
                value={restorePass}
                onChange={(e) => setRestorePass(e.target.value)}
                placeholder="Backup passphrase"
                autoComplete="current-password"
                className="w-full px-3 py-2 pr-10 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-input-dark text-sm text-gray-900 dark:text-text-primary placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={() => setShowRestorePass((v) => !v)}
                aria-label={showRestorePass ? 'Hide passphrase' : 'Show passphrase'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-panel-dark"
              >
                {showRestorePass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleRestore}
                disabled={busy !== null || !hasBackup()}
                className="px-4 py-2 rounded-full bg-green-cta text-white text-sm font-medium disabled:opacity-50"
              >
                {busy === 'restore' ? 'Restoring…' : 'Restore'}
              </button>
              <button
                onClick={handleDownload}
                disabled={busy !== null || !hasBackup()}
                className="px-4 py-2 rounded-full border border-gray-200 dark:border-white/10 text-sm font-medium text-gray-700 dark:text-text-primary disabled:opacity-50 flex items-center gap-1.5"
              >
                <Download className="h-4 w-4" /> {busy === 'download' ? 'Downloading…' : 'Download backup file'}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={busy !== null}
                className="px-4 py-2 rounded-full border border-gray-200 dark:border-white/10 text-sm font-medium text-gray-700 dark:text-text-primary disabled:opacity-50 flex items-center gap-1.5"
                title="Restore from a downloaded .dtbackup file — for a new phone, where no local backup exists yet"
              >
                <FileUp className="h-4 w-4" /> {busy === 'restoreFile' ? 'Restoring…' : 'Restore from file'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".dtbackup"
                className="hidden"
                aria-label="Choose a backup file to restore"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleRestoreFromFile(f);
                }}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-text-secondary">
              New phone? Type the backup passphrase above, then “Restore from file” and pick the .dtbackup file you saved.
            </p>
          </div>
        </div>

        <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3">
          <p className="text-xs text-gray-500 dark:text-text-secondary flex items-start gap-1.5">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              What this backup does NOT cover: the E2EE identity private key cannot be exported from this device, so after a restore on a new phone your old chats stay readable from the backup copy but new chats re-exchange keys. Media files themselves are not copied (only their links), locked chats are excluded, and messages this device cannot decrypt are left out.
            </span>
          </p>
          {hasBackup() && (
            <div className="mt-3">
              {showDeleteConfirm ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-red-600 dark:text-red-400">Delete the backup for good?</span>
                  <button
                    onClick={handleDelete}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-medium disabled:opacity-50"
                  >
                    {busy === 'delete' ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 rounded-full border border-gray-200 dark:border-white/10 text-xs font-medium text-gray-700 dark:text-text-primary"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-3 py-1.5 rounded-full border border-red-200 dark:border-red-900 text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-1.5"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete backup
                </button>
              )}
            </div>
          )}
        </div>

        {(status || error) && (
          <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3">
            {status && <p className="text-sm text-green-700 dark:text-green-400">{status}</p>}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
