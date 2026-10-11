import { createContext, useContext, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
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
    return cred.user;
  };

  const signIn = (email, password) =>
    signInWithEmailAndPassword(auth, email, password).then((c) => c.user);

  const logOut = () => signOut(auth);

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, logOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
