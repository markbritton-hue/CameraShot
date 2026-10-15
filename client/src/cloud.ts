import { useCallback, useEffect, useRef, useState } from 'react'
import { createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import type { Auth, User } from 'firebase/auth'
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc } from 'firebase/firestore'
import { normalizeShow } from '../../shared/types'
import type { Show } from '../../shared/types'
import { auth, db, firebaseConfigured } from './firebase'

export interface CloudShow {
  id: string
  name: string
  updatedAt: number
  data: Show
}

const CLOUD_ID_KEY = 'camerashot.cloudId'
const AUTOSAVE_MS = 1500

function readCloudId(): string | null {
  try { return localStorage.getItem(CLOUD_ID_KEY) } catch { return null }
}
function writeCloudId(id: string | null) {
  try { id ? localStorage.setItem(CLOUD_ID_KEY, id) : localStorage.removeItem(CLOUD_ID_KEY) } catch { /* storage blocked */ }
}

function describe(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err.code === 'permission-denied') return 'Permission denied. Publish the rules in firestore.rules (Firebase console > Firestore > Rules).'
  switch (err.code) {
    case 'auth/operation-not-allowed': return 'Email/password sign-in is not enabled. Turn it on in Firebase console > Authentication > Sign-in method.'
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Wrong email or password.'
    case 'auth/email-already-in-use': return 'An account with that email already exists. Use Sign in instead.'
    case 'auth/weak-password': return 'Password must be at least 6 characters.'
    case 'auth/invalid-email': return 'That email address is not valid.'
    case 'auth/missing-password': return 'Enter a password.'
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes and try again.'
    case 'auth/network-request-failed': return 'No connection to Firebase. Check your internet.'
    case 'auth/admin-restricted-operation': return 'New accounts are switched off in Firebase (Authentication > Settings > User actions).'
  }
  return err.message ?? String(e)
}

/**
 * Cloud shows in Firestore at users/{uid}/shows/{id}. The working show stays local-first;
 * once a show is linked to a cloud copy (saved or opened), further edits autosave to it.
 */
export function useCloud(show: Show, openShow: (s: Show) => void) {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(!firebaseConfigured)
  const [shows, setShows] = useState<CloudShow[]>([])
  const [cloudId, setCloudIdState] = useState<string | null>(readCloudId)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const showRef = useRef(show)
  showRef.current = show

  const setCloudId = useCallback((id: string | null) => { setCloudIdState(id); writeCloudId(id) }, [])

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, (u) => { setUser(u); setAuthReady(true) })
  }, [])

  // live list of this user's shows
  useEffect(() => {
    if (!db || !user) { setShows([]); return }
    const q = query(collection(db, 'users', user.uid, 'shows'), orderBy('updatedAt', 'desc'))
    return onSnapshot(
      q,
      (snap) => setShows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CloudShow, 'id'>) }))),
      (e) => setError(describe(e)),
    )
  }, [user])

  // Firestore rejects undefined fields, so round-trip through JSON to drop them
  const payload = (s: Show) => ({ name: s.name, updatedAt: Date.now(), data: JSON.parse(JSON.stringify(s)) as Show })

  const write = useCallback(async (id: string, s: Show) => {
    if (!db || !user) return
    setStatus('saving')
    try {
      await setDoc(doc(db, 'users', user.uid, 'shows', id), payload(s))
      setStatus('saved')
      setError('')
    } catch (e) {
      setStatus('idle')
      setError(describe(e))
    }
  }, [user])

  // autosave edits to the linked cloud show
  useEffect(() => {
    if (!cloudId || !user) return
    const t = window.setTimeout(() => void write(cloudId, showRef.current), AUTOSAVE_MS)
    return () => window.clearTimeout(t)
  }, [show.updatedAt, cloudId, user, write])

  const [notice, setNotice] = useState('')

  /** run an auth call, surfacing any failure in the panel; returns true on success */
  const authAction = async (fn: () => Promise<unknown>, okMessage = '') => {
    setError('')
    setNotice('')
    try { await fn(); setNotice(okMessage); return true } catch (e) { setError(describe(e)); return false }
  }
  const withAuth = (fn: (a: Auth) => Promise<unknown>, okMessage = '') => {
    const a = auth
    return a ? authAction(() => fn(a), okMessage) : Promise.resolve(false)
  }
  const signIn = (email: string, password: string) => withAuth((a) => signInWithEmailAndPassword(a, email.trim(), password))
  const signUp = (email: string, password: string) => withAuth((a) => createUserWithEmailAndPassword(a, email.trim(), password))
  const resetPassword = (email: string) =>
    withAuth((a) => sendPasswordResetEmail(a, email.trim()), `Password reset email sent to ${email.trim()}.`)
  const signOutUser = async () => { if (auth) await signOut(auth); setCloudId(null); setStatus('idle') }

  const saveNew = async () => {
    if (!db || !user) return
    const ref = doc(collection(db, 'users', user.uid, 'shows'))
    setCloudId(ref.id)
    await write(ref.id, showRef.current)
  }
  /** create a new cloud show from `s`, link it, and make it the working show */
  const create = async (s: Show) => {
    if (!db || !user) return
    const ref = doc(collection(db, 'users', user.uid, 'shows'))
    setCloudId(ref.id)
    openShow(s)
    await write(ref.id, s)
  }
  /** copy a cloud show alongside the original (does not open it) */
  const duplicate = async (c: CloudShow) => {
    if (!db || !user) return
    const ref = doc(collection(db, 'users', user.uid, 'shows'))
    await write(ref.id, { ...normalizeShow(c.data), name: `${c.name} (copy)` })
  }
  const open = (c: CloudShow) => { openShow(normalizeShow(c.data)); setCloudId(c.id) }
  const remove = async (id: string) => {
    if (!db || !user) return
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'shows', id))
      if (id === cloudId) setCloudId(null)
    } catch (e) { setError(describe(e)) }
  }

  return { configured: firebaseConfigured, authReady, user, shows, cloudId, status, error, notice, signIn, signUp, resetPassword, signOutUser, saveNew, create, duplicate, open, remove, unlink: () => setCloudId(null) }
}
