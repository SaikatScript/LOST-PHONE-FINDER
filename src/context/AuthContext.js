import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendEmailVerification,
} from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // reload() mutates the existing User instance, so the reference never
  // changes and React would skip the update. Bumping this counter re-renders
  // every consumer with the mutated (server-fresh) instance.
  const [, setUserVersion] = useState(0);

  // Firebase hands us a snapshot of the signed-in user. Clicking the
  // verification link changes the flag on the SERVER only — the in-memory
  // object keeps saying emailVerified=false until reload() is called.
  const refreshUser = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return null;
    await current.reload();
    setUserVersion((v) => v + 1);
    return auth.currentUser;
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      // Restored sessions can carry a stale emailVerified flag from the
      // persisted snapshot — reconcile with the server on cold start.
      if (u) refreshUser().catch(() => {});
    });
    return unsub;
  }, [refreshUser]);

  // Coming back from the browser (where the link was opened) is exactly when
  // emailVerified changes — refresh automatically, no app restart needed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && auth.currentUser) refreshUser().catch(() => {});
    });
    return () => sub.remove();
  }, [refreshUser]);

  const signUp = async (email, password, phone = '') => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    // Create users/{uid} doc per blueprint.
    await setDoc(
      doc(db, 'users', cred.user.uid),
      { email, phone, createdAt: serverTimestamp() },
      { merge: true }
    );
    // Phase 5A: nudge new accounts to verify their email (best effort — a
    // failed send must never block registration; Settings can resend).
    let verificationSent = true;
    try {
      await sendEmailVerification(cred.user);
    } catch (e) {
      verificationSent = false;
      console.warn('Verification email failed:', e?.code ?? e?.message);
    }
    return { user: cred.user, verificationSent };
  };

  const signIn = (email, password) =>
    signInWithEmailAndPassword(auth, email, password).then((c) => c.user);

  const logOut = () => signOut(auth);

  // Phase 5A account recovery.
  const resetPassword = (email) => sendPasswordResetEmail(auth, email);
  const resendVerification = async () => {
    const u = auth.currentUser;
    if (!u) throw new Error('Not signed in.');
    if (u.emailVerified) return false;
    await sendEmailVerification(u);
    return true;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signUp,
        signIn,
        logOut,
        resetPassword,
        resendVerification,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
