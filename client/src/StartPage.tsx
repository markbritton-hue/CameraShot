import { useState } from 'react'
import type { CloudShow, useCloud } from './cloud'

type Cloud = ReturnType<typeof useCloud>

interface Props {
  cloud: Cloud
  onOpen: (show: CloudShow) => void
  onNew: (name: string) => void
  /** go straight to the editor with the show saved in this browser, no account */
  onLocal: () => void
  /** pick up where you left off, when a cloud show was open last time */
  lastOpenedId: string | null
}

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function StartPage({ cloud, onOpen, onNew, onLocal, lastOpenedId }: Props) {
  const { configured, authReady, user, shows, error, notice } = cloud
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const canSubmit = email.trim() !== '' && password !== ''

  return (
    <div className="start">
      <div className="start-card">
        <header className="start-head">
          <h1>📷 CameraShot</h1>
          {user && (
            <div className="start-user">
              <small title={user.email ?? ''}>{user.email}</small>
              <button onClick={cloud.signOutUser}>Sign out</button>
            </div>
          )}
        </header>

        {configured && !authReady && <p className="hint">Checking sign-in…</p>}

        {configured && authReady && !user && (
          <form className="start-login" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void cloud.signIn(email, password) }}>
            <h2>Sign in</h2>
            <input type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="row">
              <button type="submit" className="primary" disabled={!canSubmit}>Sign in</button>
              <button type="button" disabled={!canSubmit} onClick={() => void cloud.signUp(email, password)}>Create account</button>
            </div>
            <button type="button" className="link" disabled={email.trim() === ''} onClick={() => void cloud.resetPassword(email)}>Forgot password?</button>
          </form>
        )}

        {!configured && <p className="hint">Cloud saving isn't set up on this copy (missing Firebase settings), so shows are kept in this browser only.</p>}

        {user && (
          <section className="start-shows">
            <div className="start-shows-head">
              <h2>Your shows</h2>
              {!creating && <button className="primary" onClick={() => setCreating(true)}>+ New show</button>}
            </div>

            {creating && (
              <form className="row start-new" onSubmit={(e) => {
                e.preventDefault()
                const name = newName.trim()
                if (!name) return
                onNew(name)
                setNewName('')
                setCreating(false)
              }}>
                <input placeholder="Show name, e.g. Sunday Service" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
                <button type="submit" className="primary" disabled={newName.trim() === ''}>Create</button>
                <button type="button" onClick={() => { setCreating(false); setNewName('') }}>Cancel</button>
              </form>
            )}

            <ul className="show-list">
              {shows.length === 0 && <li className="empty">No shows yet. Create your first one.</li>}
              {shows.map((c) => (
                <li key={c.id} className={c.id === lastOpenedId ? 'last' : ''}>
                  <button className="show-main" onClick={() => onOpen(c)}>
                    <span className="show-name">{c.name || 'Untitled'}{c.id === lastOpenedId && <em>last opened</em>}</span>
                    <small>
                      {c.data.cameras.length} camera{c.data.cameras.length === 1 ? '' : 's'} · edited {when(c.updatedAt)}
                    </small>
                  </button>
                  <button onClick={() => onOpen(c)}>Edit</button>
                  <button title="Make a copy" onClick={() => void cloud.duplicate(c)}>Duplicate</button>
                  <button title="Delete from the cloud" onClick={() => window.confirm(`Delete "${c.name}" from the cloud? This can't be undone.`) && void cloud.remove(c.id)}>×</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {notice && <p className="hint ok">{notice}</p>}
        {error && <p className="hint bad">{error}</p>}

        <footer className="start-foot">
          <button className="link" onClick={onLocal}>Continue without signing in</button>
          <small>Works offline. Uses the show saved in this browser.</small>
        </footer>
      </div>
    </div>
  )
}
