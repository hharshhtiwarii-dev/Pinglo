import { Link, useNavigate } from 'react-router-dom';
import { MessageCircle, ShieldCheck, Phone, Users } from 'lucide-react';
import { markWelcomeSeen } from './welcomeState';

/**
 * Report 3 #48 — first-launch welcome / onboarding. Before this, `/`
 * redirected straight to `/login`: no welcome, no product intro, no
 * language picker, and signup was a small link under the login card.
 * This is a minimal welcome screen (WhatsApp-style: what the app is,
 * then phone-free email signup or sign-in). It shows once: both buttons
 * mark it seen, and `/` goes to `/login` afterwards. Returning users
 * who already have an account see it at most once after updating.
 */
export default function WelcomeScreen() {
  const navigate = useNavigate();
  const go = (path: string) => {
    markWelcomeSeen();
    navigate(path);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-light dark:bg-bg-dark px-4 py-8 pt-safe pb-safe">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-20 w-20 rounded-full bg-[#25D366] flex items-center justify-center shadow-2xl shadow-green-900/40 mb-4">
            <MessageCircle className="h-10 w-10 text-white" fill="white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-text-primary tracking-tight">Pinglo</h1>
          <p className="text-sm text-gray-500 dark:text-text-secondary mt-1 text-center">
            Simple. Secure. Reliable messaging.
          </p>
        </div>

        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-xl border border-gray-200 dark:border-white/5 space-y-5">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary-green/10 text-primary-green">
                <MessageCircle className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">Chat with friends</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Messages, photos, voice notes and groups — all in one place.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary-green/10 text-primary-green">
                <Phone className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">Voice &amp; video calls</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Call anyone, one-to-one, with a WhatsApp-style call screen.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary-green/10 text-primary-green">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">End-to-end encrypted</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Your chats are encrypted on your device — only you and the other person can read them.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary-green/10 text-primary-green">
                <Users className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">Groups, status &amp; more</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Create groups, share status updates and keep messages in a private Vault.</p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => go('/signup')}
            className="w-full py-3 bg-green-cta text-white rounded-xl font-bold text-[15px] shadow-lg shadow-green-900/25 hover:bg-dark-green active:scale-[0.98] transition-all"
          >
            Get started
          </button>
          <p className="text-center text-sm text-gray-500 dark:text-text-secondary">
            Already have an account?{' '}
            <Link
              to="/login"
              onClick={markWelcomeSeen}
              className="font-semibold text-primary-green hover:text-dark-green"
            >
              Log in
            </Link>
          </p>
        </div>

        <p className="text-center text-xs text-gray-400 dark:text-text-secondary mt-6">
          Private messaging for you and your friends.
        </p>
      </div>
    </div>
  );
}
