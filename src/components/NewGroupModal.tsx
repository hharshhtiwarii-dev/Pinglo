import React, { useState, useEffect } from 'react';
import { X, Users, Check } from 'lucide-react';
import { collection, addDoc, serverTimestamp, auth, db } from '../aws';
import { MAX_GROUP_MEMBERS, GROUP_MEMBER_LIMIT_MESSAGE, MAX_GROUP_NAME_LEN, postGroupEvent } from './groupAdmin';
import { navigationManager } from '../services/navigation';
import { avatarFallback } from '../utils/avatar';

interface NewGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableUsers: any[];
  onGroupCreated: (groupId: string) => void;
}

export default function NewGroupModal({
  isOpen,
  onClose,
  availableUsers = [],
  onGroupCreated,
}: NewGroupModalProps) {
  const [groupName, setGroupName] = useState('');
  const [groupEmoji, setGroupEmoji] = useState('👥');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isChannel, setIsChannel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [isOpen, onClose]);

  // Escape closes the modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentUser = auth.currentUser;
  const EMOJIS = ['👥', '🚀', '🔥', '🎉', '💼', '⚽', '🎮', '🍕', '🍻', '🎧', '⚡', '💯'];

  const toggleSelect = (uid: string) => {
    setSelectedUserIds((prev) => {
      if (prev.includes(uid)) return prev.filter((id) => id !== uid);
      // +1 is the creator, who is always a member.
      if (prev.length + 1 >= MAX_GROUP_MEMBERS) {
        setError(GROUP_MEMBER_LIMIT_MESSAGE);
        return prev;
      }
      return [...prev, uid];
    });
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim() || !currentUser) return;
    // #176 — a group needs at least one other member; a solo "group" is
    // just Saved Messages. Channels are exempt: they are public and
    // people join after creation.
    if (!isChannel && selectedUserIds.length === 0) {
      setError('Add at least one member to create a group.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const allMembers = [currentUser.uid, ...selectedUserIds];
      // Belt-and-braces: the toggle above already caps selection, but a
      // stale / programmatic selection must not create an over-limit group.
      if (allMembers.length > MAX_GROUP_MEMBERS) {
        setError(GROUP_MEMBER_LIMIT_MESSAGE);
        setLoading(false);
        return;
      }
      const docRef = await addDoc(collection(db, 'communities'), {
        name: groupName.trim(),
        emoji: groupEmoji,
        description: `Group created by ${currentUser.displayName || 'User'}`,
        creatorId: currentUser.uid,
        creatorName: currentUser.displayName || 'User',
        admins: [currentUser.uid],
        members: allMembers,
        memberCount: allMembers.length,
        timestamp: serverTimestamp(),
        isGroup: true,
        isChannel,
        readOnly: isChannel,
      });

      // F36 (100-more): "X created this group" system event — best-effort,
      // never blocks the create flow.
      await postGroupEvent(docRef.id, 'created', { uid: currentUser.uid, name: currentUser.displayName || currentUser.username || 'User' });

      onGroupCreated(docRef.id);
      onClose();
      setGroupName('');
      setSelectedUserIds([]);
      setIsChannel(false);
    } catch {
      setError('Failed to create group. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={onClose} role="dialog" aria-modal="true" aria-label="Create new group">
      <div className="w-full max-w-md bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary-green" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">Create New Group</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger-red bg-danger-red/10 rounded-lg px-3 py-2">{error}</p>
        )}

        {/* Emoji & Name */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="h-12 w-12 rounded-2xl bg-gray-100 dark:bg-input-dark flex items-center justify-center text-2xl shadow-inner">
              {groupEmoji}
            </div>
          </div>
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group Subject / Name..."
            maxLength={MAX_GROUP_NAME_LEN}
            aria-label="Group name"
            className="flex-1 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green"
          />
        </div>

        {/* Quick Emoji selection */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setGroupEmoji(e)}
              aria-label={`Group icon ${e}`}
              aria-pressed={groupEmoji === e}
              className={`p-1.5 rounded-lg text-lg transition-transform hover:scale-110 ${
                groupEmoji === e ? 'bg-primary-green/20 ring-2 ring-primary-green' : 'bg-gray-100 dark:bg-input-dark'
              }`}
            >
              {e}
            </button>
          ))}
        </div>

        {/* Member selection */}
        <div>
          <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-2">
            Select Members ({selectedUserIds.length + 1} / {MAX_GROUP_MEMBERS.toLocaleString()} incl. you)
          </label>
          <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
            {availableUsers.length === 0 ? (
              <p className="p-4 text-xs text-center text-gray-400">No contacts available to add</p>
            ) : (
              availableUsers.map((u) => {
                const isSelected = selectedUserIds.includes(u.uid || u.id);
                return (
                  <div
                    key={u.uid || u.id}
                    onClick={() => toggleSelect(u.uid || u.id)}
                    className="flex items-center justify-between p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={u.photoURL || avatarFallback(u.displayName || u.username || 'User', u.uid || u.id)}
                        alt=""
                        className="h-9 w-9 rounded-full object-cover"
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-text-primary">{u.displayName || u.username}</p>
                        <p className="text-xs text-gray-500 truncate">@{u.username}</p>
                      </div>
                    </div>
                    <div
                      className={`h-5 w-5 rounded-full flex items-center justify-center border transition-all ${
                        isSelected ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400'
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Channel toggle: announcement-only (only admins can post) */}
        <button
          type="button"
          onClick={() => setIsChannel(v => !v)}
          className={`w-full flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${isChannel ? 'border-primary-green bg-primary-green/10' : 'border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-input-dark'}`}
        >
          <span className="text-xl leading-none mt-0.5">📢</span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-gray-900 dark:text-text-primary">Public channel (announcement-only)</span>
            <span className="block text-xs text-gray-500 dark:text-text-secondary mt-0.5 leading-relaxed">Only admins can send messages. Everyone else joins as a subscriber and can read.</span>
          </span>
          <span className={`mt-0.5 flex-shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${isChannel ? 'bg-primary-green' : 'bg-gray-300 dark:bg-gray-600'}`}>
            <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${isChannel ? 'translate-x-4' : ''}`} />
          </span>
        </button>

        {/* Action Button */}
        <button
          onClick={handleCreateGroup}
          disabled={!groupName.trim() || loading}
          className="w-full py-3 rounded-xl bg-green-cta hover:bg-dark-green text-white font-bold transition-all disabled:opacity-40 shadow-lg shadow-green-900/20"
        >
          {loading ? 'Creating...' : isChannel ? 'Create Channel 📢' : 'Create Group ✓'}
        </button>
      </div>
    </div>
  );
}
