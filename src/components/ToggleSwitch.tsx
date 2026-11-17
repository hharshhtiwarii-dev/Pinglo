/**
 * ToggleSwitch — WhatsApp-style on/off switch (Phase 5, Agent C).
 *
 * Replaces the CheckCircle2 / Circle icon pairs that Settings used as
 * fake toggles (Privacy: dark mode + read receipts; Notifications:
 * show notifications). Same green pill + white knob pattern that
 * AppLockScreen already inlines, extracted so every settings toggle
 * looks and behaves the same way.
 *
 * Contract:
 * - `checked`  current state.
 * - `onChange` called with the NEW state when tapped.
 * - `label`    accessible name (also the aria-label).
 * - `disabled` optional; dims the switch.
 *
 * Destination in repo: src/components/ToggleSwitch.tsx
 */
type ToggleSwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
};

export default function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex flex-shrink-0 w-12 h-7 rounded-full p-1 items-center transition-colors disabled:opacity-40 ${
        checked ? 'bg-primary-green justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'
      }`}
    >
      <span className="h-5 w-5 rounded-full bg-white shadow" />
    </button>
  );
}
