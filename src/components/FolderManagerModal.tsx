/**
 * Feature 5 — FolderManagerModal.
 * DESTINATION: src/components/FolderManagerModal.tsx (new file, copy as-is).
 *
 * Create / rename / delete custom chat folders, and tap a folder to open it.
 * Presentational: all persistence lives in ChatListScreen (saveFolders /
 * deleteFolder in PATCH.md). Styled after NewGroupModal (fixed overlay,
 * panel-light/panel-dark, primary-green CTA).
 */
import { useState, useEffect } from 'react';
import { X, Folder, Plus, Pencil, Trash2, Check } from 'lucide-react';
import { navigationManager } from '../services/navigation';
import type { ChatFolder } from '../services/archiveFolders';
import { FOLDER_COLORS, sanitizeFolderName } from '../services/archiveFolders';

interface FolderManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  folders: ChatFolder[];
  /** chat count per folder id (non-archived chats only) */
  counts: Record<string, number>;
  onCreate: (name: string, color: string) => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
  /** Open the folder's filtered view in the chat list. */
  onOpenFolder: (folderId: string) => void;
}

export default function FolderManagerModal({
  isOpen,
  onClose,
  folders,
  counts,
  onCreate,
  onRename,
  onDelete,
  onOpenFolder,
}: FolderManagerModalProps) {
  const [newName, setNewName] = useState('');
  const [color, setColor] = useState(FOLDER_COLORS[0]);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ChatFolder | null>(null);

  // Android back button closes the modal, like NewGroupModal.
  useEffect(() => {
    if (!isOpen) return;
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [isOpen, onClose]);

  // Escape closes the modal (delete confirm first).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pendingDelete) setPendingDelete(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, pendingDelete, onClose]);

  if (!isOpen) return null;

  const handleCreate = () => {
    const result = sanitizeFolderName(newName, folders);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onCreate(result.name, color);
    setNewName('');
    setError('');
  };

  const handleRename = (folder: ChatFolder) => {
    const result = sanitizeFolderName(editingName, folders, folder.id);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onRename(folder.id, result.name);
    setEditingId(null);
    setError('');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={onClose} role="dialog" aria-modal="true" aria-label="Chat folders">
      <div className="w-full max-w-md bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <Folder className="h-5 w-5 text-primary-green" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">Chat folders</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>

        {/* Create */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            placeholder="New folder name…"
            maxLength={30}
            className="flex-1 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green"
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim()}
            className="h-10 w-10 flex items-center justify-center rounded-xl bg-green-cta hover:bg-dark-green text-white transition-all disabled:opacity-40"
            aria-label="Create folder"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
        <div className="flex gap-2">
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${color === c ? 'ring-2 ring-offset-2 ring-gray-400 dark:ring-white/60' : ''}`}
              style={{ backgroundColor: c }}
              aria-label={`Folder colour ${c}`}
            />
          ))}
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}

        {/* List */}
        {folders.length === 0 ? (
          <p className="text-sm text-center text-gray-400 dark:text-text-secondary py-4">
            No folders yet. Create one, then long-press a chat → “Move to folder”.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
            {folders.map((folder) => (
              <div key={folder.id} className="flex items-center gap-3 p-2.5">
                <span className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: folder.color || FOLDER_COLORS[0] }} />
                {editingId === folder.id ? (
                  <>
                    <input
                      autoFocus
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRename(folder); if (e.key === 'Escape') setEditingId(null); }}
                      maxLength={30}
                      className="flex-1 bg-gray-100 dark:bg-input-dark rounded-lg px-3 py-1.5 text-sm outline-none text-gray-900 dark:text-text-primary"
                    />
                    <button onClick={() => handleRename(folder)} className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-primary-green" aria-label="Save name">
                      <Check className="h-4 w-4" />
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-gray-400" aria-label="Cancel rename">
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { onOpenFolder(folder.id); onClose(); }} className="flex-1 text-left min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">{folder.name}</p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary">
                        {counts[folder.id] || 0} chat{(counts[folder.id] || 0) === 1 ? '' : 's'}
                      </p>
                    </button>
                    <button
                      onClick={() => { setEditingId(folder.id); setEditingName(folder.name); setError(''); }}
                      className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-gray-400"
                      aria-label={`Rename ${folder.name}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setPendingDelete(folder)}
                      className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-red-500"
                      aria-label={`Delete ${folder.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-400 dark:text-text-secondary">
          Deleting a folder never deletes its chats.
        </p>
      </div>

      {/* Delete confirm (replaces window.confirm) */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingDelete(null)} role="dialog" aria-modal="true" aria-label="Delete folder">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">Delete folder “{pendingDelete.name}”?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Its chats stay in your list, just without the folder.</p>
            <div className="flex gap-3">
              <button onClick={() => setPendingDelete(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button
                onClick={() => { onDelete(pendingDelete.id); setPendingDelete(null); }}
                className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
