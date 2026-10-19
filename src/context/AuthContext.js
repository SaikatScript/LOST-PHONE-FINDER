import { createContext, useContext, useEffect, useState } from 'react';
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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

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
    try {
      await sendEmailVerification(cred.user);
    } catch {
      // ignore — resend available in Settings
    }
    return cred.user;
  };

  const signIn = (email, password) =>
    signInWithEmailAndPassword(auth, email, password).then((c) => c.user);

  const logOut = () => signOut(auth);

  // Phase 5A account recovery.
  const resetPassword = (email) => sendPasswordResetEmail(auth, email);
  const resendVerification = async () => {
    const u = auth.currentUser;
    if (u && !u.emailVerified) await sendEmailVerification(u);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, signUp, signIn, logOut, resetPassword, resendVerification }}
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
