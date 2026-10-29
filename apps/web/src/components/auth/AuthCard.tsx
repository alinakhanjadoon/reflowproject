'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import {
  Lock,
  Mail,
  Building,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  KeyRound,
  X,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';

export type PlanTier = 'starter' | 'pro' | 'enterprise';

export const PLAN_DETAILS: Record<PlanTier, { name: string; price: string; steps: string }> = {
  starter: {
    name: 'Starter',
    price: '$29 / mo',
    steps: '25,000 steps/mo',
  },
  pro: {
    name: 'Pro',
    price: '$99 / mo',
    steps: '150,000 steps/mo',
  },
  enterprise: {
    name: 'Enterprise',
    price: '$249 / mo',
    steps: '500,000+ steps/mo',
  },
};

export interface AuthCardProps {
  defaultTab?: 'signin' | 'signup';
  selectedPlan?: PlanTier;
  redirectedFrom?: string;
  isModal?: boolean;
  onClose?: () => void;
}

export function AuthCard({
  defaultTab = 'signin',
  selectedPlan = 'starter',
  redirectedFrom = '/dashboard',
  isModal = false,
  onClose,
}: AuthCardProps) {
  const [activeTab, setActiveTab] = useState<'signin' | 'signup'>(defaultTab);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);

  // Sign In state
  const [signInEmail, setSignInEmail] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  const [showSignInPassword, setShowSignInPassword] = useState(false);
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Sign Up state
  const [signUpCompany, setSignUpCompany] = useState('');
  const [signUpEmail, setSignUpEmail] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState('');
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);
  const [signUpLoading, setSignUpLoading] = useState(false);
  const [signUpError, setSignUpError] = useState<string | null>(null);

  // Forgot password modal state
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  useEffect(() => {
    async function checkUser() {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.email) {
          setCurrentUserEmail(user.email);
        }
      } catch {}
    }
    checkUser();
  }, []);
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('Network request failed') ||
    msg.includes('Load failed')
  );
}

function checkSupabaseConfig(): void {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (
    !supabaseUrl ||
    supabaseUrl.includes('placeholder.supabase.co') ||
    supabaseUrl.includes('your-project.supabase.co')
  ) {
    throw new Error(
      'Supabase is not configured. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY with valid project credentials in your deployment environment variables (Vercel) or apps/web/.env.local.'
    );
  }
}

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignInError(null);

    const cleanEmail = signInEmail.trim().toLowerCase();
    const cleanPassword = signInPassword;

    if (!cleanEmail) {
      setSignInError('Please enter your work email.');
      return;
    }
    if (!cleanPassword) {
      setSignInError('Please enter your password.');
      return;
    }

    setSignInLoading(true);

    try {
      checkSupabaseConfig();

      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password: cleanPassword,
      });

      if (error) {
        if (error.message.toLowerCase().includes('invalid login credentials')) {
          throw new Error('Invalid email or password. Please verify your credentials or click "Forgot password?" below.');
        }
        throw error;
      }

      if (data.user) {
        const { data: memberData } = await supabase
          .from('wf_organization_members')
          .select('org_id')
          .eq('user_id', data.user.id)
          .limit(1);

        if (!memberData || memberData.length === 0) {
          window.location.href = '/onboarding';
        } else {
          window.location.href = redirectedFrom;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (isNetworkError(err)) {
          setSignInError('Unable to connect to Supabase. Please ensure your Supabase instance is active and reachable, and that NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.');
        } else {
          setSignInError(err.message);
        }
      } else {
        setSignInError('An unexpected error occurred. Please check your credentials.');
      }
      setSignInLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignUpError(null);

    const cleanCompany = signUpCompany.trim();
    const cleanEmail = signUpEmail.trim().toLowerCase();

    if (!cleanCompany) {
      setSignUpError('Please enter your company or team name.');
      return;
    }
    if (!cleanEmail) {
      setSignUpError('Please enter a valid work email.');
      return;
    }
    if (signUpPassword.length < 6) {
      setSignUpError('Password must be at least 6 characters.');
      return;
    }
    if (signUpPassword !== signUpConfirmPassword) {
      setSignUpError('Passwords do not match. Please verify both password fields.');
      return;
    }

    setSignUpLoading(true);

    try {
      checkSupabaseConfig();

      const supabase = createClient();
      const { data: authData, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password: signUpPassword,
        options: {
          data: { company_name: cleanCompany },
        },
      });

      if (error) throw error;

      if (authData.user && Array.isArray(authData.user.identities) && authData.user.identities.length === 0) {
        setSignUpError('An account with this email address already exists. Please switch to the Sign In tab.');
        setSignUpLoading(false);
        return;
      }

      if (authData.user) {
        if (authData.session) {
          const orgSlug = cleanCompany.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
          const orgId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `org_${Date.now()}`;

          const { error: orgError } = await supabase.from('wf_organizations').insert({
            id: orgId,
            name: cleanCompany,
            slug: `${orgSlug}-${Math.random().toString(36).substring(2, 7)}`,
            plan_tier: selectedPlan || 'starter',
          });

          if (!orgError) {
            await supabase.from('wf_organization_members').insert({
              org_id: orgId,
              user_id: authData.user.id,
              role: 'owner',
            });
            window.location.href = '/dashboard';
            return;
          }
        }
        window.location.href = '/onboarding';
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (isNetworkError(err)) {
          setSignUpError('Unable to connect to Supabase. Please ensure your Supabase instance is active and reachable, and that NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.');
        } else {
          setSignUpError(err.message);
        }
      } else {
        setSignUpError('Signup failed. Please try again.');
      }
      setSignUpLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = (forgotEmail || signInEmail).trim().toLowerCase();
    if (!cleanEmail) {
      setForgotMessage({ type: 'error', text: 'Please enter your email address.' });
      return;
    }

    setForgotLoading(true);
    setForgotMessage(null);

    try {
      const supabase = createClient();
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: `${typeof window !== 'undefined' ? window.location.origin : ''}/login`,
      });

      if (resetErr) throw resetErr;

      setForgotMessage({
        type: 'success',
        text: `Password recovery link sent to ${cleanEmail}. Please check your inbox.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not send recovery link.';
      setForgotMessage({ type: 'error', text: msg });
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div className={`relative rounded-2xl border border-white/[0.11] bg-[#090909]/95 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.48)] backdrop-blur-xl sm:rounded-3xl sm:p-8 ${isModal ? 'w-full max-w-md' : ''}`}>
      {isModal && onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg border border-transparent p-1.5 text-zinc-500 transition duration-200 hover:border-white/10 hover:bg-white/[0.05] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-200 cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      {/* Existing Session Notification Banner */}
      {currentUserEmail && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-emerald-200/15 bg-emerald-200/[0.05] p-3 text-xs text-emerald-100">
          <div className="flex items-center gap-2 truncate">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse flex-shrink-0" />
            <span className="truncate">Signed in as <strong>{currentUserEmail}</strong></span>
          </div>
          <Link
            href="/dashboard"
            className="flex items-center gap-1 font-bold rounded-md border border-emerald-200/10 bg-emerald-200/[0.08] px-2.5 py-1 text-[11px] text-emerald-100 transition hover:bg-emerald-200/[0.14] hover:text-white shrink-0"
          >
            <span>Dashboard</span>
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )}

      {!isModal && (
        <div key={activeTab} className="auth-panel-enter mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {activeTab === 'signin' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-6 text-zinc-400 sm:text-sm">
            {activeTab === 'signin'
              ? 'Sign in to access your automated browser routines and workspace.'
              : 'Set up your workspace and turn repetitive browser tasks into reusable workflows.'}
          </p>
        </div>
      )}

      {/* Prominent Tab Switcher Header */}
      <div className="relative mb-6 flex gap-1.5 rounded-xl border border-white/[0.09] bg-[#050505] p-1.5" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'signin'}
          onClick={() => {
            setActiveTab('signin');
            setSignInError(null);
          }}
          className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-xs sm:text-sm transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 ${
            activeTab === 'signin'
              ? 'border border-emerald-200/20 bg-emerald-200 text-[#07120d] shadow-[0_4px_18px_rgba(110,231,183,0.10)]'
              : 'border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
          }`}
        >
          <Lock className="w-3.5 h-3.5" />
          <span>Sign In</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'signup'}
          onClick={() => {
            setActiveTab('signup');
            setSignUpError(null);
          }}
          className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-xs sm:text-sm transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 ${
            activeTab === 'signup'
              ? 'border border-emerald-200/20 bg-emerald-200 text-[#07120d] shadow-[0_4px_18px_rgba(110,231,183,0.10)]'
              : 'border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
          }`}
        >
          <Building className="w-3.5 h-3.5" />
          <span>Create Account</span>
        </button>
      </div>

      {/* Selected Subscription Plan Banner */}
      {activeTab === 'signup' && selectedPlan && (
        <div className="mb-5 flex items-center justify-between rounded-xl border border-white/[0.09] bg-white/[0.025] p-3 text-xs">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <div>
              <span className="font-bold text-white tracking-tight">
                {PLAN_DETAILS[selectedPlan]?.name || selectedPlan} Plan Selected
              </span>
              <span className="text-zinc-400 text-[11px] block sm:inline sm:ml-2">
                {PLAN_DETAILS[selectedPlan]?.steps}
              </span>
            </div>
          </div>
          <span className="font-mono text-white font-bold text-xs shrink-0 pl-2">
            {PLAN_DETAILS[selectedPlan]?.price}
          </span>
        </div>
      )}

      {/* TAB 1: SIGN IN */}
      {activeTab === 'signin' && (
        <div className="auth-panel-enter">
          {signInError && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs sm:text-sm flex items-start gap-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span>{signInError}</span>
                {signInError.includes('Forgot password') && (
                  <button
                    type="button"
                    onClick={() => {
                      setForgotEmail(signInEmail);
                      setShowForgotModal(true);
                    }}
                    className="mt-1.5 block text-xs font-semibold text-emerald-200 underline decoration-emerald-200/40 underline-offset-4 transition hover:text-emerald-100 cursor-pointer"
                  >
                    Reset your password now →
                  </button>
                )}
              </div>
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSignIn}>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">Work Email</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={signInEmail}
                  onChange={(e) => setSignInEmail(e.target.value)}
                  placeholder="ap-team@acmecorp.com"
                  className="w-full pl-10 pr-4 py-2.5 bg-[#050505] border border-white/[0.10] rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-200/60 focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200 text-sm"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-semibold text-zinc-300">Password</label>
                <button
                  type="button"
                  onClick={() => {
                    setForgotEmail(signInEmail);
                    setShowForgotModal(true);
                  }}
                  className="text-xs font-medium text-emerald-200 transition hover:text-emerald-100 cursor-pointer"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showSignInPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={signInPassword}
                  onChange={(e) => setSignInPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full pl-10 pr-10 py-2.5 bg-[#050505] border border-white/[0.10] rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-200/60 focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowSignInPassword(!showSignInPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
                  tabIndex={-1}
                  aria-label={showSignInPassword ? 'Hide password' : 'Show password'}
                >
                  {showSignInPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={signInLoading}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-100/20 bg-emerald-200 px-4 py-3 text-xs font-bold uppercase tracking-wider text-[#07120d] shadow-[0_8px_24px_rgba(110,231,183,0.10)] transition duration-200 hover:-translate-y-0.5 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              {signInLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      )}

      {/* TAB 2: CREATE ACCOUNT */}
      {activeTab === 'signup' && (
        <div className="auth-panel-enter">
          {signUpError && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs sm:text-sm flex items-start gap-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span>{signUpError}</span>
                {signUpError.includes('already exists') && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('signin')}
                    className="block mt-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300 underline cursor-pointer"
                  >
                    Switch to Sign In tab →
                  </button>
                )}
              </div>
            </div>
          )}

          <form className="space-y-3.5" onSubmit={handleSignUp}>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">Company or Workspace Name</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                  <Building className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  value={signUpCompany}
                  onChange={(e) => setSignUpCompany(e.target.value)}
                  placeholder="Acme Logistics"
                  className="w-full pl-10 pr-4 py-2 bg-[#050505] border border-white/[0.10] rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-200/60 focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">Work Email</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={signUpEmail}
                  onChange={(e) => setSignUpEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full pl-10 pr-4 py-2 bg-[#050505] border border-white/[0.10] rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-200/60 focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showSignUpPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={signUpPassword}
                  onChange={(e) => setSignUpPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full pl-10 pr-10 py-2 bg-[#050505] border border-white/[0.10] rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-200/60 focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowSignUpPassword(!showSignUpPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
                  tabIndex={-1}
                  aria-label={showSignUpPassword ? 'Hide password' : 'Show password'}
                >
                  {showSignUpPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">Confirm Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showSignUpPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={signUpConfirmPassword}
                  onChange={(e) => setSignUpConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className={`w-full pl-10 pr-10 py-2 bg-[#050505] border rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200 text-sm ${
                    signUpConfirmPassword && signUpConfirmPassword !== signUpPassword
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-white/10 focus:border-emerald-200/60'
                  }`}
                />
                {signUpConfirmPassword && signUpConfirmPassword === signUpPassword && (
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                )}
              </div>
              {signUpConfirmPassword && signUpConfirmPassword !== signUpPassword && (
                <p className="mt-1 text-xs text-red-400">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={signUpLoading}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-100/20 bg-emerald-200 px-4 py-3 text-xs font-bold uppercase tracking-wider text-[#07120d] shadow-[0_8px_24px_rgba(110,231,183,0.10)] transition duration-200 hover:-translate-y-0.5 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              {signUpLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Creating Workspace...</span>
                </>
              ) : (
                <>
                  <span>Create Account & Workspace</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      )}

      <div className="mt-6 border-t border-white/[0.08] pt-5 text-center">
        <p className="text-[11px] font-mono text-zinc-500">
          Enterprise Security · Local Replay Execution · Zero Extensions
        </p>
      </div>

      {/* Forgot Password Modal */}
      {showForgotModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative w-full max-w-md rounded-2xl border border-white/[0.12] bg-[#090909] p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => {
                setShowForgotModal(false);
                setForgotMessage(null);
              }}
              className="absolute top-4 right-4 text-zinc-400 hover:text-white transition cursor-pointer"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-xl border border-emerald-200/15 bg-emerald-200/[0.06] p-2.5 text-emerald-200">
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Reset Password</h3>
                <p className="text-xs text-zinc-400">Enter your email to receive a recovery link</p>
              </div>
            </div>

            {forgotMessage && (
              <div
                className={`mb-4 p-3 rounded-xl text-xs flex items-start gap-2.5 ${
                  forgotMessage.type === 'success'
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/10 border border-red-500/30 text-red-400'
                }`}
              >
                {forgotMessage.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                )}
                <span>{forgotMessage.text}</span>
              </div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Account Email</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    required
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full pl-9 pr-4 py-2 bg-[#050505] border border-white/[0.10] rounded-lg text-white text-xs placeholder-zinc-600 focus:outline-none focus:border-emerald-200/60 focus:ring-2 focus:ring-emerald-200/[0.08] transition duration-200"
                  />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotModal(false);
                    setForgotMessage(null);
                  }}
                  className="px-3.5 py-1.5 rounded-full text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-100/20 bg-emerald-200 px-4 py-2 text-xs font-bold text-[#07120d] transition duration-200 hover:bg-emerald-100 disabled:opacity-50 cursor-pointer"
                >
                  {forgotLoading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <span>Send Recovery Link</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <style jsx>{`
        @keyframes auth-panel-enter {
          from { opacity: 0; transform: translate3d(0, 10px, 0); filter: blur(2px); }
          to { opacity: 1; transform: translate3d(0, 0, 0); filter: blur(0); }
        }
        .auth-panel-enter { animation: auth-panel-enter 320ms cubic-bezier(0.16, 1, 0.3, 1) both; }
        @media (prefers-reduced-motion: reduce) {
          .auth-panel-enter { animation: none; }
        }
      `}</style>
    </div>
  );
}
